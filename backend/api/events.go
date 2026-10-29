package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
)

const eventOverflowReason = "event stream overflow; reconnect for a fresh snapshot"

type eventWebsocket interface {
	ReadMessage() (int, []byte, error)
	SetWriteDeadline(time.Time) error
	WriteJSON(interface{}) error
	WriteControl(int, []byte, time.Time) error
	Close() error
}

func getEvents(w http.ResponseWriter, r *http.Request, subscribe func() (*model.EventSubscription, error)) {
	if !websocket.IsWebSocketUpgrade(r) {
		writeString(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	consumer, err := subscribe()
	if err != nil {
		writeString(w, http.StatusInternalServerError, "failed to read event snapshot")
		return
	}
	defer consumer.Close()
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// The upgrader has already sent an error response.
		fmt.Printf("failed to upgrade to websocket: %v\n", err)
		return
	}

	serveEventWebsocket(r.Context(), ws, snapshotFrame(consumer.Snapshot), consumer.Chan, consumer.Overflow())
}

// The first frame of the stream of one kind of item.
func snapshotFrame(items interface{}) interface{} {
	return struct {
		Type  string      `json:"type"`
		Items interface{} `json:"items"`
	}{Type: "snapshot", Items: items}
}

type EventApi struct {
	tasks   *model.TaskService
	workers *model.WorkerService
}

func NewEventApi(tasks *model.TaskService, workers *model.WorkerService) *EventApi {
	return &EventApi{tasks: tasks, workers: workers}
}

// GetEvents streams tasks, workers and builds over one websocket. The first
// frame is a snapshot of all three, followed by updates of type task, worker
// and build.
func (api *EventApi) GetEvents(w http.ResponseWriter, r *http.Request) {
	if !websocket.IsWebSocketUpgrade(r) {
		writeString(w, http.StatusBadRequest, "websocket upgrade required")
		return
	}
	subscription, err := model.Subscribe(api.tasks, api.workers)
	if err != nil {
		writeString(w, http.StatusInternalServerError, "failed to read event snapshot")
		return
	}
	defer subscription.Close()
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// The upgrader has already sent an error response.
		fmt.Printf("failed to upgrade to websocket: %v\n", err)
		return
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	events, overflow := subscription.Events(ctx)
	serveEventWebsocket(ctx, ws, struct {
		Type    string      `json:"type"`
		Tasks   interface{} `json:"tasks"`
		Workers interface{} `json:"workers"`
		Builds  interface{} `json:"builds"`
	}{Type: "snapshot", Tasks: subscription.Tasks, Workers: subscription.Workers, Builds: subscription.Builds}, events, overflow)
}

func serveEventWebsocket(ctx context.Context, ws eventWebsocket, first interface{}, messages <-chan interface{}, overflow <-chan struct{}) {
	ctx, cancel := context.WithCancel(ctx)
	readDone := make(chan struct{})
	writeDone := make(chan struct{})
	defer func() {
		cancel()
		ws.Close()
		<-readDone
		<-writeDone
	}()

	go func() {
		defer close(readDone)
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}()

	go func() {
		defer close(writeDone)
		write := func(message interface{}) error {
			// Do not send stale data after an overflow or shutdown.
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-overflow:
				return fmt.Errorf("event stream overflow")
			default:
			}
			if err := ws.SetWriteDeadline(time.Now().Add(30 * time.Second)); err != nil {
				return err
			}
			return ws.WriteJSON(message)
		}
		if err := write(first); err != nil {
			return
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-overflow:
				return
			case message := <-messages:
				if err := write(message); err != nil {
					return
				}
			}
		}
	}()

	select {
	case <-overflow:
	case <-ctx.Done():
	case <-readDone:
	case <-writeDone:
	}

	select {
	case <-overflow:
		// WriteControl and Close are safe alongside a blocked data writer.
		// Bound the control attempt, then Close unblocks both socket I/O loops.
		ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseTryAgainLater, eventOverflowReason),
			time.Now().Add(time.Second))
	default:
	}
}
