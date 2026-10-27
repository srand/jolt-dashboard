package api

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
)

// Shared across requests: a Transport pools and reuses connections, so
// creating a new one per request (as this handler used to) parks an idle
// connection and its readLoop goroutine per log view for the life of the
// process. InsecureSkipVerify is deliberate; see the design doc.
var logProxyClient = &http.Client{
	Transport: &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	},
}

type TaskApi struct {
	service *model.TaskService
}

func NewTaskApi(service *model.TaskService) *TaskApi {
	return &TaskApi{service: service}
}

func (api *TaskApi) GetStatistics(w http.ResponseWriter, r *http.Request) {
	stats, err := api.service.GetStatistics()
	if err != nil {
		writeString(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, stats)
}

func (api *TaskApi) GetTasks(w http.ResponseWriter, r *http.Request) {
	tasks, err := api.service.GetTasks()
	if err != nil {
		writeString(w, http.StatusBadRequest, "bad request")
		return
	}

	writeJSON(w, http.StatusOK, tasks)
}

func (api *TaskApi) GetTaskEvents(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// The upgrader has already sent an error response.
		fmt.Printf("failed to upgrade to websocket: %v\n", err)
		return
	}
	defer ws.Close()

	ctx, cancel := context.WithCancel(context.Background())

	consumer := api.service.Broadcast.NewClient()
	defer consumer.Close()

	go func(ctx context.Context) {
		for {
			select {
			case task := <-consumer.Chan:
				err := ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if err != nil {
					ws.Close()
					return
				}

				err = ws.WriteJSON(task)
				if err != nil {
					ws.Close()
					return
				}
			case <-ctx.Done():
				return
			}
		}
	}(ctx)

	for {
		_, _, err = ws.ReadMessage()
		if err != nil {
			fmt.Println(err)
			break
		}
	}

	cancel()
}

func (api *TaskApi) DeleteTask(w http.ResponseWriter, r *http.Request) {
	uuid, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeString(w, http.StatusBadRequest, "bad request")
		return
	}

	task, err := api.service.GetTask(uuid)
	if err != nil {
		writeString(w, http.StatusBadRequest, "bad request")
		return
	}

	err = api.service.DeleteTask(task)
	if err != nil {
		writeString(w, http.StatusBadRequest, "bad request")
		return
	}

	writeString(w, http.StatusOK, "")
}

func (api *TaskApi) GetTaskLog(w http.ResponseWriter, r *http.Request) {
	uuid, err := uuid.Parse(r.PathValue("id"))
	if err != nil {
		writeString(w, http.StatusBadRequest, "bad request")
		return
	}

	task, err := api.service.GetTask(uuid)
	if err != nil || task.Log == "" {
		writeString(w, http.StatusNotFound, "not found")
		return
	}

	logUrl := task.Log
	if r.URL.Query().Get("follow") == "1" {
		// Ask logstash to hold the response open while the task is writing.
		// Parsed rather than appended blindly: the producer never puts a
		// query string on task.Log today, but string concatenation would
		// silently build a malformed URL (a second "?", or dropping an
		// existing parameter) the day that stops being true.
		parsed, err := url.Parse(logUrl)
		if err != nil {
			writeString(w, http.StatusBadGateway, err.Error())
			return
		}
		query := parsed.Query()
		query.Set("follow", "1")
		parsed.RawQuery = query.Encode()
		logUrl = parsed.String()
	}

	// The request context ties the upstream connection to this client. Without
	// it, a closed dialog would leave the upstream read running for the rest of
	// the task.
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, logUrl, nil)
	if err != nil {
		writeString(w, http.StatusBadRequest, err.Error())
		return
	}

	response, err := logProxyClient.Do(request)
	if err != nil {
		writeString(w, http.StatusBadGateway, err.Error())
		return
	}
	defer response.Body.Close()

	w.Header().Set("Content-Type", response.Header.Get("Content-Type"))
	// A buffering reverse proxy is the one deployment where chunked streaming
	// stalls; this asks nginx not to.
	w.Header().Set("X-Accel-Buffering", "no")
	// Forward the upstream status rather than assuming 200: a log that has not
	// been written yet 404s, and the dashboard's browser-side retry depends on
	// seeing that 404 rather than a masked 200.
	w.WriteHeader(response.StatusCode)

	// Copy by hand rather than with io.Copy, which leaves the bytes in
	// net/http's buffer and defeats the point of streaming.
	flusher := http.NewResponseController(w)
	buf := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, err := w.Write(buf[:n]); err != nil {
				return
			}
			flusher.Flush()
		}
		if readErr != nil {
			// A client going away cancels the upstream read via the request
			// context, and a clean end of log looks like io.EOF; neither is
			// worth logging. A genuine upstream failure is.
			if !errors.Is(readErr, io.EOF) &&
				!errors.Is(readErr, context.Canceled) &&
				!errors.Is(readErr, context.DeadlineExceeded) {
				fmt.Printf("task %s: log stream read failed: %v\n", uuid, readErr)
			}
			return
		}
	}
}
