package scheduler

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"net/url"
	"strings"
	"time"

	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

const (
	maxMessageSize = 32 * 1024 * 1024

	minBackoff = time.Second
	maxBackoff = 30 * time.Second
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

	for {
		event, err := stream.Recv()
		if err != nil {
			return err
		}

		if err := c.apply(event); err != nil {
			log.Println("failed to apply scheduler event:", err)
		}
	}
}

func (c *Client) apply(event *protocol.SchedulerEvent) error {
	switch e := event.GetEvent().(type) {
	case *protocol.SchedulerEvent_Snapshot:
		log.Printf("synchronized with scheduler: %d tasks, %d workers",
			len(e.Snapshot.GetTasks()), len(e.Snapshot.GetWorkers()))

		if err := c.tasks.ApplySnapshot(e.Snapshot.GetTasks()); err != nil {
			return err
		}
		return c.workers.ApplySnapshot(e.Snapshot.GetWorkers())

	case *protocol.SchedulerEvent_Task:
		return c.tasks.ApplyTaskInfo(e.Task)

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
