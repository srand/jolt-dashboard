package api

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/srand/jolt-dashboard/model"
)

// Serves GetTaskLog over a real HTTP server, backed by an in-memory database
// holding one task whose log lives at logURL.
//
// A real server rather than httptest.ResponseRecorder: the handler's whole job
// is to flush as it copies, so the test has to read the response while the
// handler is still writing it. Polling a recorder's buffer from the test
// goroutine would be a data race, and `go test -race` would say so.
func newTestTaskServer(t *testing.T, logURL string) (*httptest.Server, string) {
	t.Helper()

	db := model.NewDatabaseFromDsn("file:" + t.Name() + "?mode=memory&cache=shared")
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

	e := echo.New()
	e.GET("/api/v1/tasks/:id/log", api.GetTaskLog)
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
