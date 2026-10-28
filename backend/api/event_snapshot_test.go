package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newEventTestServices(t *testing.T) (*model.TaskService, *model.WorkerService) {
	t.Helper()
	db := newTestDatabase(t)
	tasks := &model.TaskService{Db: db, Broadcast: model.NewBroadcast()}
	tasks.Builds = model.NewBuildService(db, tasks.Broadcast)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	return tasks, model.NewWorkerService(db, model.NewBroadcast())
}

func seedEventViews(t *testing.T, tasks *model.TaskService, workers *model.WorkerService) (*protocol.TaskInfo, *protocol.WorkerInfo) {
	t.Helper()
	if err := tasks.Builds.Upsert(&protocol.BuildInfo{Id: "build", Parameters: []*protocol.Property{{Key: "config.username", Value: "user"}, {Key: "config.origin", Value: "origin"}, {Key: "config.token", Value: "secret"}}}); err != nil {
		t.Fatal(err)
	}
	info := &protocol.TaskInfo{Instance: uuid.NewString(), BuildId: "build", Identity: "identity", Name: "before", Status: protocol.TaskStatus_TASK_RUNNING, Labels: []string{"linux"}, WorkerHostname: "host", Log: "https://logs.example/task", QueuedAt: timestamppb.Now(), AssignedAt: timestamppb.Now(), StartedAt: timestamppb.Now()}
	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}
	worker := &protocol.WorkerInfo{Id: "worker", Hostname: "before", Task: info, EnlistedAt: timestamppb.Now(), Platform: &protocol.Platform{Properties: []*protocol.Property{{Key: "label", Value: "linux"}}}}
	if err := workers.Upsert(worker); err != nil {
		t.Fatal(err)
	}
	return info, worker
}

func TestEventEndpointsFirstFrameMatchesREST(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		for _, populated := range []bool{false, true} {
			name := stream + "/empty"
			if populated {
				name = stream + "/populated"
			}
			t.Run(name, func(t *testing.T) {
				tasks, workers := newEventTestServices(t)
				if populated {
					seedEventViews(t, tasks, workers)
					if err := tasks.ApplyTaskInfo(&protocol.TaskInfo{Instance: uuid.NewString(), BuildId: "missing-build"}); err != nil {
						t.Fatal(err)
					}
				}
				e := http.NewServeMux()
				path := "/api/v1/" + stream
				if stream == "tasks" {
					e.HandleFunc("GET "+path, NewTaskApi(tasks).GetTasks)
					e.HandleFunc("GET "+path+"/events", NewTaskApi(tasks).GetTaskEvents)
				} else {
					e.HandleFunc("GET "+path, NewWorkerApi(workers).GetWorkers)
					e.HandleFunc("GET "+path+"/events", NewWorkerApi(workers).GetWorkerEvents)
				}
				response := httptest.NewRecorder()
				e.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
				var current []interface{}
				if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &current) != nil {
					t.Fatalf("REST response=%d %s", response.Code, response.Body.String())
				}
				server := httptest.NewServer(e)
				defer server.Close()
				ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+path+"/events", nil)
				if err != nil {
					t.Fatal(err)
				}
				defer ws.Close()
				ws.SetReadDeadline(time.Now().Add(2 * time.Second))
				var first map[string]interface{}
				if err := ws.ReadJSON(&first); err != nil {
					t.Fatalf("first DATA frame missing: %v", err)
				}
				items, ok := first["items"].([]interface{})
				if len(first) != 2 || first["type"] != "snapshot" || !ok || !reflect.DeepEqual(items, current) {
					t.Fatalf("snapshot/REST mismatch: %+v / %+v", first, current)
				}
			})
		}
	}
}

type gatedSnapshotWebsocket struct {
	*blockedEventWebsocket
	entered chan struct{}
	release chan struct{}
	frames  chan []byte
	once    sync.Once
}

func (ws *gatedSnapshotWebsocket) WriteJSON(value interface{}) error {
	ws.once.Do(func() { close(ws.entered); <-ws.release })
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	select {
	case ws.frames <- data:
		return nil
	case <-ws.closed:
		return net.ErrClosed
	}
}

func TestEventSnapshotTransportPrecedesQueuedMutations(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			tasks, workers := newEventTestServices(t)
			info, worker := seedEventViews(t, tasks, workers)
			subscribe := tasks.Subscribe
			if stream == "workers" {
				subscribe = workers.Subscribe
			}
			subscription, err := subscribe()
			if err != nil {
				t.Fatal(err)
			}
			defer subscription.Close()
			ws := &gatedSnapshotWebsocket{blockedEventWebsocket: newBlockedEventWebsocket(), entered: make(chan struct{}), release: make(chan struct{}), frames: make(chan []byte, 4)}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			defer ws.Close()
			var releaseOnce sync.Once
			defer releaseOnce.Do(func() { close(ws.release) })
			done := make(chan struct{})
			go func() {
				serveEventWebsocket(ctx, ws, subscription.Snapshot, subscription.Chan, subscription.Overflow())
				close(done)
			}()
			select {
			case <-ws.entered:
			case <-time.After(5 * time.Second):
				t.Fatal("snapshot writer did not start")
			}
			mutationDone := make(chan error, 1)
			go func() {
				if stream == "tasks" {
					info.Name = "after"
					if err := tasks.ApplyTaskInfo(info); err != nil {
						mutationDone <- err
						return
					}
					if err := tasks.Builds.Remove("build"); err != nil {
						mutationDone <- err
						return
					}
					mutationDone <- tasks.DeleteTask(&model.Task{Instance: uuid.MustParse(info.Instance)})
				} else {
					worker.Hostname = "after"
					if err := workers.Upsert(worker); err != nil {
						mutationDone <- err
						return
					}
					mutationDone <- workers.Remove(worker.Id)
				}
			}()
			select {
			case err := <-mutationDone:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("snapshot transport held mutation coordinator")
			}
			releaseOnce.Do(func() { close(ws.release) })
			wantFrames := 3
			if stream == "tasks" {
				wantFrames = 4
			}
			for i := 0; i < wantFrames; i++ {
				var data []byte
				select {
				case data = <-ws.frames:
				case <-time.After(5 * time.Second):
					t.Fatal("queued frame missing")
				}
				var frame map[string]interface{}
				if err := json.Unmarshal(data, &frame); err != nil {
					t.Fatal(err)
				}
				if i == 0 {
					if frame["type"] != "snapshot" {
						t.Fatalf("first frame is not snapshot: %s", data)
					}
					item := frame["items"].([]interface{})[0].(map[string]interface{})
					if (stream == "tasks" && (item["Name"] != "before" || item["Build"].(map[string]interface{})["Registered"] != true)) || (stream == "workers" && item["Hostname"] != "before") {
						t.Fatalf("snapshot changed during transport: %s", data)
					}
				} else {
					if _, exists := frame["type"]; exists {
						t.Fatalf("incremental event was enveloped: %s", data)
					}
					if i == wantFrames-1 {
						key := "Status"
						if stream == "workers" {
							key = "TaskStatus"
						}
						if frame[key] != "Deleted" {
							t.Fatalf("last frame is not deletion: %s", data)
						}
					} else if stream == "tasks" {
						if frame["Name"] != "after" || frame["Build"].(map[string]interface{})["Registered"] != (i == 1) {
							t.Fatalf("task ordering lost: %s", data)
						}
					} else if frame["Hostname"] != "after" {
						t.Fatalf("worker ordering lost: %s", data)
					}
				}
			}
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("writer and reader were not joined")
			}
		})
	}
}
