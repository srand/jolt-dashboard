package api

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
)

type gatedEvent struct {
	entered chan struct{}
	release chan struct{}
}

func (event gatedEvent) MarshalJSON() ([]byte, error) {
	close(event.entered)
	<-event.release
	return []byte(`{"id":"gated"}`), nil
}

func TestEventEndpointsOverflowClose(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			tasks, workers := newEventTestServices(t)
			broadcast := tasks.Broadcast
			e := http.NewServeMux()
			path := "/api/v1/" + stream + "/events"
			var handler http.HandlerFunc
			if stream == "tasks" {
				handler = NewTaskApi(tasks).GetTaskEvents
			} else {
				broadcast = workers.Broadcast
				handler = NewWorkerApi(workers).GetWorkerEvents
			}
			handlerDone := make(chan struct{})
			e.HandleFunc("GET "+path, func(w http.ResponseWriter, r *http.Request) {
				defer close(handlerDone)
				handler(w, r)
			})
			server := httptest.NewServer(e)
			t.Cleanup(server.Close)
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path, nil)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { ws.Close() })
			if err := ws.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
				t.Fatal(err)
			}
			var snapshot map[string]interface{}
			if err := ws.ReadJSON(&snapshot); err != nil || snapshot["type"] != "snapshot" {
				t.Fatalf("first frame = %+v, error=%v, want snapshot", snapshot, err)
			}
			ready := make(chan struct{})
			ws.SetPongHandler(func(string) error { close(ready); return nil })
			readErrors := make(chan error, 1)
			go func() {
				for {
					if _, _, err := ws.ReadMessage(); err != nil {
						readErrors <- err
						return
					}
				}
			}()
			if err := ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				t.Fatal(err)
			}
			select {
			case <-ready:
			case err := <-readErrors:
				t.Fatal(err)
			case <-time.After(5 * time.Second):
				t.Fatal("handler did not subscribe")
			}

			// Gate serialization to fill the subscription deterministically while
			// using a real websocket for the endpoint's close-code contract.
			event := gatedEvent{entered: make(chan struct{}), release: make(chan struct{})}
			var release sync.Once
			t.Cleanup(func() { release.Do(func() { close(event.release) }) })
			broadcast.Send(event)
			select {
			case <-event.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("writer did not start")
			}
			for i := 0; i < 11; i++ {
				broadcast.Send(i)
			}
			select {
			case err := <-readErrors:
				var closeErr *websocket.CloseError
				if !errors.As(err, &closeErr) || closeErr.Code != websocket.CloseTryAgainLater || closeErr.Text != eventOverflowReason {
					t.Fatalf("close = %v, want 1013 with resync instruction", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("overflow did not disconnect websocket")
			}
			release.Do(func() { close(event.release) })
			select {
			case <-handlerDone:
			case <-time.After(5 * time.Second):
				t.Fatal("handler did not clean up after overflow")
			}
		})
	}
}

type controlFrame struct {
	messageType int
	data        []byte
	deadline    time.Time
}

// Socket I/O remains blocked until Close, just as on an unread slow socket.
type blockedEventWebsocket struct {
	closed         chan struct{}
	writeStarted   chan struct{}
	controls       chan controlFrame
	closeOnce      sync.Once
	controlBlocked bool
	writeErr       error
	deadlineErr    error
	readErr        error
	blockingWrite  int
	writes         int
}

func newBlockedEventWebsocket() *blockedEventWebsocket {
	return &blockedEventWebsocket{
		closed: make(chan struct{}), writeStarted: make(chan struct{}),
		controls: make(chan controlFrame, 2),
	}
}

func (ws *blockedEventWebsocket) ReadMessage() (int, []byte, error) {
	if ws.readErr != nil {
		return 0, nil, ws.readErr
	}
	<-ws.closed
	return 0, nil, net.ErrClosed
}

func (ws *blockedEventWebsocket) SetWriteDeadline(time.Time) error {
	return ws.deadlineErr
}

func (ws *blockedEventWebsocket) WriteJSON(interface{}) error {
	ws.writes++
	if ws.writes != ws.blockingWrite+1 {
		return nil
	}
	close(ws.writeStarted)
	if ws.writeErr != nil {
		return ws.writeErr
	}
	<-ws.closed
	return net.ErrClosed
}

func (ws *blockedEventWebsocket) WriteControl(messageType int, data []byte, deadline time.Time) error {
	ws.controls <- controlFrame{messageType: messageType, data: data, deadline: deadline}
	if ws.controlBlocked {
		<-time.After(time.Until(deadline))
		return context.DeadlineExceeded
	}
	return nil
}

func (ws *blockedEventWebsocket) Close() error {
	ws.closeOnce.Do(func() { close(ws.closed) })
	return nil
}

func TestEventWebsocketOverflowUnblocksWriter(t *testing.T) {
	for _, blockedFrame := range []string{"snapshot", "update"} {
		for _, controlBlocked := range []bool{false, true} {
			name := "control writable"
			if controlBlocked {
				name = "control blocked"
			}
			t.Run(blockedFrame+"/"+name, func(t *testing.T) {
				broadcast := model.NewBroadcast()
				consumer := broadcast.NewClient()
				defer consumer.Close()
				ws := newBlockedEventWebsocket()
				ws.controlBlocked = controlBlocked
				if blockedFrame == "update" {
					ws.blockingWrite = 1
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				defer ws.Close()
				done := make(chan struct{})
				go func() {
					serveEventWebsocket(ctx, ws, snapshotFrame([]model.Task{}), consumer.Chan, consumer.Overflow())
					close(done)
				}()
				if blockedFrame == "update" {
					broadcast.Send("blocked write")
				}
				select {
				case <-ws.writeStarted:
				case <-time.After(5 * time.Second):
					t.Fatal("writer did not start")
				}
				for i := 0; i < 11; i++ {
					broadcast.Send(i)
				}
				select {
				case control := <-ws.controls:
					if control.messageType != websocket.CloseMessage || len(control.data) < 2 ||
						int(binary.BigEndian.Uint16(control.data[:2])) != websocket.CloseTryAgainLater ||
						string(control.data[2:]) != eventOverflowReason {
						t.Fatalf("control frame = %+v, want 1013 with resync instruction", control)
					}
					if remaining := time.Until(control.deadline); remaining <= 0 || remaining > time.Second {
						t.Fatalf("control deadline remaining = %s, want at most 1s", remaining)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("blocked writer prevented overflow notification")
				}
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Fatal("overflow did not close socket and join I/O goroutines")
				}
				select {
				case <-ws.closed:
				default:
					t.Fatal("socket was not closed")
				}
				select {
				case <-ws.controls:
					t.Fatal("overflow sent more than one close frame")
				default:
				}
			})
		}
	}
}

func TestEventWebsocketShutdown(t *testing.T) {
	for _, reason := range []string{"context cancellation", "read error", "write error", "deadline error"} {
		t.Run(reason, func(t *testing.T) {
			ws := newBlockedEventWebsocket()
			defer ws.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			messages := make(chan interface{}, 1)
			messages <- "event"
			switch reason {
			case "read error":
				ws.readErr = net.ErrClosed
			case "write error":
				ws.writeErr = net.ErrClosed
			case "deadline error":
				ws.deadlineErr = net.ErrClosed
			}
			done := make(chan struct{})
			go func() {
				serveEventWebsocket(ctx, ws, snapshotFrame([]model.Task{}), messages, make(chan struct{}))
				close(done)
			}()
			if reason == "context cancellation" {
				select {
				case <-ws.writeStarted:
				case <-time.After(5 * time.Second):
					t.Fatal("writer did not start")
				}
				cancel()
			}
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("handler did not join its I/O goroutines")
			}
			select {
			case <-ws.closed:
			default:
				t.Fatal("socket was not closed")
			}
			select {
			case <-ws.controls:
				t.Fatal("ordinary shutdown sent an overflow close frame")
			default:
			}
		})
	}
}

func TestEventOverflowReasonRequestsFreshSnapshot(t *testing.T) {
	if !strings.Contains(eventOverflowReason, "reconnect") || !strings.Contains(eventOverflowReason, "snapshot") || strings.Contains(eventOverflowReason, "REST") {
		t.Fatalf("overflow reason = %q, want reconnect for fresh snapshot", eventOverflowReason)
	}
}

func TestEventEndpointsSnapshotQueryFailure(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			tasks, workers := newEventTestServices(t)
			if err := tasks.Db.Close(); err != nil {
				t.Fatal(err)
			}
			e := http.NewServeMux()
			if stream == "tasks" {
				e.HandleFunc("GET /events", NewTaskApi(tasks).GetTaskEvents)
			} else {
				e.HandleFunc("GET /events", NewWorkerApi(workers).GetWorkerEvents)
			}
			server := httptest.NewServer(e)
			defer server.Close()
			ws, response, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/events", nil)
			if ws != nil {
				defer ws.Close()
			}
			if err == nil || response == nil || response.StatusCode != http.StatusInternalServerError {
				t.Fatalf("dial error=%v response=%+v, want snapshot failure before upgrade (500)", err, response)
			}
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil || string(body) != "failed to read event snapshot" || response.Header.Get("Content-Type") != "text/plain; charset=UTF-8" {
				t.Fatalf("snapshot failure body=%q headers=%v error=%v", body, response.Header, err)
			}
		})
	}
}

func TestEventEndpointsFailedUpgradeClosesSubscription(t *testing.T) {
	tasks, _ := newEventTestServices(t)
	calls := 0
	var captured *model.EventSubscription
	subscribe := func() (*model.EventSubscription, error) {
		calls++
		var err error
		captured, err = tasks.Subscribe()
		return captured, err
	}
	e := http.NewServeMux()
	e.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) { getEvents(w, r, subscribe) })
	request := httptest.NewRequest(http.MethodGet, "/events", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "12")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, request)
	if calls != 1 || response.Code != http.StatusBadRequest {
		t.Fatalf("subscriptions=%d status=%d, want subscription then failed upgrade", calls, response.Code)
	}
	if response.Body.String() != "Bad Request\n" || response.Header().Get("Sec-Websocket-Version") != "13" {
		t.Fatalf("upgrade failure body=%q headers=%v, want only the upgrader response", response.Body.String(), response.Header())
	}
	for i := 0; i < 11; i++ {
		tasks.Broadcast.Send(i)
	}
	select {
	case <-captured.Overflow():
		t.Fatal("failed upgrade leaked subscription until overflow")
	case event := <-captured.Chan:
		t.Fatalf("closed subscription received event: %+v", event)
	default:
	}
}

func TestEventEndpointDisconnectClosesSubscription(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			tasks, workers := newEventTestServices(t)
			subscribe, broadcast := tasks.Subscribe, tasks.Broadcast
			if stream == "workers" {
				subscribe, broadcast = workers.Subscribe, workers.Broadcast
			}
			subscriptions := make(chan *model.EventSubscription, 1)
			done := make(chan struct{})
			e := http.NewServeMux()
			e.HandleFunc("GET /events", func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				getEvents(w, r, func() (*model.EventSubscription, error) {
					subscription, err := subscribe()
					subscriptions <- subscription
					return subscription, err
				})
			})
			server := httptest.NewServer(e)
			defer server.Close()
			ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/events", nil)
			if err != nil {
				t.Fatal(err)
			}
			ws.Close()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("disconnect did not join websocket handler")
			}
			subscription := <-subscriptions
			for i := 0; i < 11; i++ {
				broadcast.Send(i)
			}
			select {
			case <-subscription.Overflow():
				t.Fatal("disconnected subscription remained registered until overflow")
			case event := <-subscription.Chan:
				t.Fatalf("disconnected subscription received event: %+v", event)
			default:
			}
		})
	}
}

func TestEventEndpointsRequireWebsocketUpgrade(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			e := http.NewServeMux()
			if stream == "tasks" {
				e.HandleFunc("GET /events", NewTaskApi(&model.TaskService{}).GetTaskEvents)
			} else {
				e.HandleFunc("GET /events", NewWorkerApi(&model.WorkerService{}).GetWorkerEvents)
			}
			response := httptest.NewRecorder()
			e.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/events", nil))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", response.Code)
			}
			if response.Body.String() != "websocket upgrade required" || response.Header().Get("Content-Type") != "text/plain; charset=UTF-8" {
				t.Fatalf("non-websocket response body=%q headers=%v", response.Body.String(), response.Header())
			}
		})
	}
}
