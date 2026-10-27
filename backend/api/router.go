package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"time"
)

type Router struct {
	engine http.Handler
}

// Records the status of a response for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
	r.ResponseWriter.WriteHeader(status)
}

func (r *statusRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.ResponseWriter.Write(data)
}

func (r *statusRecorder) Flush() {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	http.NewResponseController(r.ResponseWriter).Flush()
}

// Websocket upgrades take over the connection.
func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(r.ResponseWriter).Hijack()
	if err == nil && r.status == 0 {
		r.status = http.StatusSwitchingProtocols
	}
	return conn, rw, err
}

func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func HttpLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder := &statusRecorder{ResponseWriter: w}
		next.ServeHTTP(recorder, r)
		if recorder.status == 0 {
			recorder.status = http.StatusOK
		}
		now := time.Now().Format("2006-01-02 15:04:05.000")
		fmt.Printf("%s %4s %s %v\n", now, r.Method, r.URL, recorder.status)
	})
}

func writeString(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
	w.WriteHeader(status)
	w.Write([]byte(text))
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(value)
}

// Serves files from dir, and its index.html for any path that is not a file
// there, so that the frontend can route it.
func staticHandler(dir string) http.Handler {
	root := http.Dir(dir)
	files := http.FileServer(root)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if file, err := root.Open(path.Clean("/" + r.URL.Path)); err == nil {
			file.Close()
			files.ServeHTTP(w, r)
			return
		}

		index, err := root.Open("/index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer index.Close()

		info, err := index.Stat()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, "index.html", info.ModTime(), index)
	})
}

func NewRouter(
	apiTask *TaskApi,
	apiWorker *WorkerApi,
) *Router {
	r := http.NewServeMux()

	r.HandleFunc("GET /api/v1/statistics", apiTask.GetStatistics)
	r.HandleFunc("GET /api/v1/tasks", apiTask.GetTasks)
	// r.HandleFunc("GET /api/v1/task/{id}", apiTask.GetTask)
	r.HandleFunc("DELETE /api/v1/tasks/{id}", apiTask.DeleteTask)
	r.HandleFunc("GET /api/v1/tasks/{id}/log", apiTask.GetTaskLog)
	r.HandleFunc("GET /api/v1/tasks/events", apiTask.GetTaskEvents)
	r.HandleFunc("GET /api/v1/workers", apiWorker.GetWorkers)
	r.HandleFunc("GET /api/v1/workers/events", apiWorker.GetWorkerEvents)

	r.Handle("/", staticHandler("static"))

	return &Router{engine: HttpLogger(r)}
}

func (router *Router) Run(ctx context.Context) error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    net.JoinHostPort("", port),
		Handler: router.engine,
	}

	served := make(chan error, 1)
	go func() {
		err := server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		served <- err
	}()

	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}

	// Websocket clients never close on their own, so don't wait forever.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return server.Shutdown(shutdownCtx)
}
