package scheduler

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"strings"
	"time"

	"github.com/mattn/go-sqlite3"
	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const (
	maxMessageSize = 32 * 1024 * 1024

	minBackoff = time.Second
	maxBackoff = 30 * time.Second

	eventRetryAttempts = 3
	eventRetryDelay    = 250 * time.Millisecond
)

// Client mirrors the state of a Jolt scheduler into the dashboard database.
//
// The scheduler is the source of truth. Every time the stream is established
// the scheduler sends a snapshot of all queued and running tasks and all
// connected workers, which is reconciled against the database. Anything the
// dashboard believed to be in progress but that is absent from the snapshot
// was lost while disconnected and is terminated.
type Client struct {
	uri     string
	tasks   *model.TaskService
	workers *model.WorkerService

	// applyFn is overridden by tests that exercise stream failure handling.
	applyFn func(*protocol.SchedulerEvent) error
}

func NewClient(uri string, tasks *model.TaskService, workers *model.WorkerService) *Client {
	return &Client{uri: uri, tasks: tasks, workers: workers}
}

// Run maintains the subscription until the context is cancelled.
func (c *Client) Run(ctx context.Context) {
	backoff := minBackoff

	for ctx.Err() == nil {
		connected := time.Now()

		if err := c.stream(ctx); err != nil && ctx.Err() == nil {
			log.Println("scheduler stream closed:", err)
		}

		// A stream that survived for a while is not a connection problem.
		if time.Since(connected) > maxBackoff {
			backoff = minBackoff
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(jitter(backoff)):
		}

		if backoff < maxBackoff {
			backoff *= 2
		}
	}
}

func (c *Client) stream(ctx context.Context) error {
	target, err := parseUri(c.uri)
	if err != nil {
		return err
	}

	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return err
	}
	defer conn.Close()

	client := protocol.NewAdministrationClient(conn)
	stream, err := client.StreamEvents(ctx, &protocol.StreamEventsRequest{}, grpc.MaxCallRecvMsgSize(maxMessageSize))
	if err != nil {
		return err
	}

	return c.consume(ctx, stream)
}

type eventStream interface {
	Recv() (*protocol.SchedulerEvent, error)
}

// consume applies one event completely before receiving the next one. If a
// transient SQLite lock cannot be resolved, returning an error reconnects the
// stream and obtains a fresh scheduler snapshot instead of dropping the event.
func (c *Client) consume(ctx context.Context, stream eventStream) error {
	for {
		event, err := stream.Recv()
		if err != nil {
			return err
		}

		err = retrySQLite(ctx, eventRetryAttempts, eventRetryDelay, func() error {
			if c.applyFn != nil {
				return c.applyFn(event)
			}
			return c.apply(event)
		})
		if err != nil {
			return fmt.Errorf("failed to apply scheduler event: %w", err)
		}
	}
}

func retrySQLite(ctx context.Context, attempts int, delay time.Duration, operation func() error) error {
	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		err = operation()
		if err == nil || !isSQLiteContention(err) {
			return err
		}
		if attempt == attempts-1 {
			break
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return err
}

func isSQLiteContention(err error) bool {
	var sqliteErr sqlite3.Error
	if !errors.As(err, &sqliteErr) {
		return false
	}
	return sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked
}

func (c *Client) apply(event *protocol.SchedulerEvent) error {
	switch e := event.GetEvent().(type) {
	case *protocol.SchedulerEvent_Snapshot:
		log.Printf("synchronized with scheduler: %d tasks, %d workers, %d builds",
			len(e.Snapshot.GetTasks()), len(e.Snapshot.GetWorkers()), len(e.Snapshot.GetBuilds()))

		if err := c.tasks.ApplyBuildTaskSnapshot(e.Snapshot.GetBuilds(), e.Snapshot.GetTasks()); err != nil {
			return err
		}
		return c.workers.ApplySnapshot(e.Snapshot.GetWorkers())

	case *protocol.SchedulerEvent_Task:
		return c.tasks.ApplyTaskInfo(e.Task)

	case *protocol.SchedulerEvent_Build:
		return c.tasks.Builds.Upsert(e.Build)

	case *protocol.SchedulerEvent_BuildRemoved:
		return c.tasks.Builds.Remove(e.BuildRemoved.GetId())

	case *protocol.SchedulerEvent_Worker:
		return c.workers.Upsert(e.Worker)

	case *protocol.SchedulerEvent_WorkerRemoved:
		return c.workers.Remove(e.WorkerRemoved.GetId())
	}

	return nil
}

func jitter(backoff time.Duration) time.Duration {
	return backoff/2 + time.Duration(rand.Int63n(int64(backoff)))
}

// Accepts the tcp://host:port form used by the rest of Jolt, as well as a
// bare host:port target.
func parseUri(uri string) (string, error) {
	if !strings.Contains(uri, "://") {
		return uri, nil
	}

	parsed, err := url.Parse(uri)
	if err != nil {
		return "", err
	}

	if parsed.Scheme != "tcp" {
		return "", fmt.Errorf("unsupported scheduler protocol: %s", parsed.Scheme)
	}

	if parsed.Port() == "" {
		return parsed.Host + ":9090", nil
	}

	return parsed.Host, nil
}
