package api

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/protocol"
)

func newTestDatabase(t *testing.T) *model.Database {
	t.Helper()
	db := model.NewDatabaseFromDsn("file:" + uuid.NewString() + "?mode=memory&cache=shared")
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func TestGetTasksBuildJSONContract(t *testing.T) {
	db := newTestDatabase(t)
	service := &model.TaskService{Db: db, Broadcast: model.NewBroadcast()}
	service.Builds = model.NewBuildService(db, service.Broadcast)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{}
	for _, origin := range []string{"", "https://ci.example.com/build/123", "builder@example.com", "<script>arbitrary text</script>"} {
		instance := uuid.New().String()
		if err := service.Builds.Upsert(&protocol.BuildInfo{
			Id: instance, Parameters: []*protocol.Property{
				{Key: "config.origin", Value: origin},
				{Key: "config.username", Value: "<user@example.com>"},
				{Key: "config.password", Value: "secret-not-for-API"},
			},
		}); err != nil {
			t.Fatal(err)
		}
		if err := service.ApplyTaskInfo(&protocol.TaskInfo{
			Instance: instance, Name: "task", BuildId: instance,
		}); err != nil {
			t.Fatal(err)
		}
		want[instance] = origin
	}
	unknown := uuid.New().String()
	if err := service.ApplyTaskInfo(&protocol.TaskInfo{Instance: unknown, BuildId: "older-scheduler"}); err != nil {
		t.Fatal(err)
	}
	want[unknown] = ""

	e := http.NewServeMux()
	e.HandleFunc("GET /api/v1/tasks", NewTaskApi(service).GetTasks)
	response := httptest.NewRecorder()
	e.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "secret-not-for-API") || strings.Contains(response.Body.String(), "Parameters") {
		t.Fatal("raw parameters leaked through REST")
	}
	var objects []map[string]interface{}
	if err := json.Unmarshal(response.Body.Bytes(), &objects); err != nil {
		t.Fatal(err)
	}
	if len(objects) != len(want) {
		t.Fatalf("task count = %d, want %d", len(objects), len(want))
	}
	for _, object := range objects {
		instance, ok := object["id"].(string)
		if !ok {
			t.Fatalf("task id = %#v, want string", object["id"])
		}
		origin, exists := want[instance]
		if !exists {
			t.Fatalf("unexpected task id %q", instance)
		}
		if instance == unknown {
			if object["Build"] != nil || object["BuildId"] != "older-scheduler" {
				t.Fatalf("unknown build representation = %+v", object)
			}
		} else {
			build, ok := object["Build"].(map[string]interface{})
			if !ok || len(build) != 6 || build["Origin"] != origin || build["Username"] != "<user@example.com>" || build["Status"] != "BUILD_ACCEPTED" || build["Scheduled"] != "" || build["Registered"] != true || build["Id"] != instance || object["BuildId"] != instance {
				t.Fatalf("unexpected build contract = %+v", object)
			}
		}
		if _, exists := object["Provenance"]; exists {
			t.Error("task contains obsolete provenance key")
		}
		delete(want, instance)
	}
}

func TestGetTaskEventsMatchesRESTBuildContract(t *testing.T) {
	db := newTestDatabase(t)
	service := &model.TaskService{Db: db, Broadcast: model.NewBroadcast()}
	service.Builds = model.NewBuildService(db, service.Broadcast)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	e := http.NewServeMux()
	e.HandleFunc("GET /api/v1/tasks/events", NewTaskApi(service).GetTaskEvents)
	e.HandleFunc("GET /api/v1/tasks", NewTaskApi(service).GetTasks)
	server := httptest.NewServer(e)
	defer server.Close()
	ws, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/api/v1/tasks/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ws.Close()
	if err := ws.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	var snapshot struct {
		Type  string       `json:"type"`
		Items []model.Task `json:"items"`
	}
	if err := ws.ReadJSON(&snapshot); err != nil || snapshot.Type != "snapshot" || snapshot.Items == nil || len(snapshot.Items) != 0 {
		t.Fatalf("first frame = %+v, error=%v, want empty snapshot", snapshot, err)
	}

	// A pong proves the handler has subscribed and reached its read loop.
	ready := make(chan struct{})
	ws.SetPongHandler(func(string) error { close(ready); return nil })
	objects := make(chan map[string]interface{}, 4)
	readErrors := make(chan error, 1)
	go func() {
		for {
			var object map[string]interface{}
			if err := ws.ReadJSON(&object); err != nil {
				readErrors <- err
				return
			}
			objects <- object
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
		t.Fatal("websocket handler did not subscribe")
	}

	info := &protocol.TaskInfo{Instance: uuid.New().String(), Name: "task", BuildId: "build"}
	operations := []func() error{
		func() error { return service.ApplyTaskInfo(info) },
		func() error {
			return service.Builds.Upsert(&protocol.BuildInfo{Id: "build", Parameters: []*protocol.Property{
				{Key: "config.origin", Value: "https://ci.example.com/build/123"},
				{Key: "config.username", Value: "builder@example.com"},
				{Key: "config.token", Value: "secret-not-for-API"},
			}})
		},
		func() error {
			return service.Builds.Upsert(&protocol.BuildInfo{Id: "build", Status: protocol.BuildStatus_BUILD_COMPLETED})
		},
		func() error { return service.Builds.Remove("build") },
	}
	for _, operation := range operations {
		if err := operation(); err != nil {
			t.Fatal(err)
		}
		select {
		case object := <-objects:
			response := httptest.NewRecorder()
			e.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/tasks", nil))
			var rest []map[string]interface{}
			if err := json.Unmarshal(response.Body.Bytes(), &rest); err != nil {
				t.Fatal(err)
			}
			if len(rest) != 1 || !reflect.DeepEqual(object, rest[0]) {
				t.Fatalf("REST/websocket mismatch: %+v / %+v", rest, object)
			}
			if strings.Contains(response.Body.String(), "secret-not-for-API") || strings.Contains(response.Body.String(), "Parameters") {
				t.Fatal("raw parameters leaked")
			}
		case err := <-readErrors:
			t.Fatal(err)
		case <-time.After(5 * time.Second):
			t.Fatal("task update did not reach websocket")
		}
	}
}

// Serves GetTaskLog over a real HTTP server, backed by an in-memory database
// holding one task whose log lives at logURL.
//
// A real server rather than httptest.ResponseRecorder: the handler's whole job
// is to flush as it copies, so the test has to read the response while the
// handler is still writing it. Polling a recorder's buffer from the test
// goroutine would be a data race, and `go test -race` would say so.
func newTestTaskServer(t *testing.T, logURL string) (*httptest.Server, string) {
	t.Helper()

	db := newTestDatabase(t)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}

	instance := uuid.New()
	if err := db.Create(&model.Task{
		Instance: instance,
		Name:     "task",
		Status:   "Running",
		Log:      logURL,
	}); err != nil {
		t.Fatal(err)
	}

	api := NewTaskApi(&model.TaskService{Db: db, Broadcast: model.NewBroadcast()})

	e := http.NewServeMux()
	e.HandleFunc("GET /api/v1/tasks/{id}/log", api.GetTaskLog)
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)

	return server, "/api/v1/tasks/" + instance.String() + "/log"
}

// Reads one line in the background, so a test can tell "not sent yet" from
// "sent but stuck in a buffer".
func readLineAsync(reader *bufio.Reader) chan string {
	out := make(chan string, 1)
	go func() {
		line, err := reader.ReadString('\n')
		if err != nil {
			out <- ""
			return
		}
		out <- line
	}()
	return out
}

func TestGetTaskLogForwardsFollowUpstream(t *testing.T) {
	queries := make(chan string, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.RawQuery
		w.Write([]byte("line\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	select {
	case query := <-queries:
		if query != "follow=1" {
			t.Fatalf("upstream query = %q, want follow=1", query)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was never called")
	}
}

// The producer only ever formats task.Log as "%s/logs/%s" today, so this is
// not reachable yet - but if a logstash URI ever carried its own query
// parameter, blind string concatenation would silently build a malformed
// upstream URL (two "?"s, or dropping the existing parameter). Parsing the
// URL and merging into RawQuery must preserve both.
func TestGetTaskLogMergesFollowIntoExistingQueryString(t *testing.T) {
	queries := make(chan string, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.RawQuery
		w.Write([]byte("line\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x?token=abc")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	select {
	case query := <-queries:
		values, err := url.ParseQuery(query)
		if err != nil {
			t.Fatalf("upstream query %q did not parse: %v", query, err)
		}
		if values.Get("token") != "abc" {
			t.Fatalf("upstream query = %q, want token=abc preserved", query)
		}
		if values.Get("follow") != "1" {
			t.Fatalf("upstream query = %q, want follow=1 merged in", query)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was never called")
	}
}

func TestGetTaskLogWithoutFollowDoesNotForwardIt(t *testing.T) {
	queries := make(chan string, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		queries <- r.URL.RawQuery
		w.Write([]byte("line\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	select {
	case query := <-queries:
		if query != "" {
			t.Fatalf("upstream query = %q, want empty", query)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("upstream was never called")
	}
}

// A task's log URL is set at creation, before the first line is written, so
// logstash 404s until there is something to read. Task 7's dialog retries on
// that 404 while the task is still running; if the dashboard masked it with a
// 200, the retry would never fire and the browser would render logstash's
// error body as if it were log lines.
func TestGetTaskLogForwardsUpstreamStatusCode(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte("not found\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status code = %d, want %d", response.StatusCode, http.StatusNotFound)
	}
}

func TestGetTaskLogDeliversBytesBeforeUpstreamFinishes(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		<-release
		w.Write([]byte("second\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	reader := bufio.NewReader(response.Body)

	select {
	case line := <-readLineAsync(reader):
		if !strings.Contains(line, "first") {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first line was still buffered after 2s")
	}

	close(release)

	select {
	case line := <-readLineAsync(reader):
		if !strings.Contains(line, "second") {
			t.Fatalf("second line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the second line never arrived")
	}
}

// Review Focus 1: a line longer than the proxy's 4096-byte read buffer.
func TestGetTaskLogForwardsLinesLongerThanTheBuffer(t *testing.T) {
	long := strings.Repeat("x", 10000)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(long + "\n"))
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	response, err := http.Get(server.URL + path + "?follow=1")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	reader := bufio.NewReaderSize(response.Body, 64)

	select {
	case line := <-readLineAsync(reader):
		if len(line) != len(long)+1 {
			t.Fatalf("line length = %d, want %d", len(line), len(long)+1)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the long line never arrived")
	}
}

// Review Focus 4: an abandoned dialog must not pin the upstream connection for
// the rest of the task.
func TestGetTaskLogCancelsUpstreamWhenTheClientGoesAway(t *testing.T) {
	cancelled := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("first\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		cancelled <- struct{}{}
	}))
	defer upstream.Close()

	server, path := newTestTaskServer(t, upstream.URL+"/logs/x")

	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, server.URL+path+"?follow=1", nil)
	if err != nil {
		t.Fatal(err)
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()

	select {
	case line := <-readLineAsync(bufio.NewReader(response.Body)):
		if !strings.Contains(line, "first") {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the first line never arrived")
	}

	// Stand in for the user closing the dialog.
	cancel()

	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not cancelled when the client went away")
	}
}
