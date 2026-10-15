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
	"github.com/labstack/echo/v4"
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

func (api *TaskApi) GetStatistics(c echo.Context) error {
	stats, err := api.service.GetStatistics()
	if err != nil {
		return c.String(http.StatusInternalServerError, "internal server error")
	}

	return c.JSON(http.StatusOK, stats)
}

func (api *TaskApi) GetTasks(c echo.Context) error {
	tasks, err := api.service.GetTasks()
	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	return c.JSON(http.StatusOK, tasks)
}

func (api *TaskApi) GetTaskEvents(c echo.Context) error {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(c.Response().Writer, c.Request(), nil)
	if err != nil {
		err = fmt.Errorf("failed to upgrade to websocket: %w", err)
		return c.String(http.StatusBadRequest, err.Error())
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
	return nil
}

func (api *TaskApi) DeleteTask(c echo.Context) error {
	uuid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	task, err := api.service.GetTask(uuid)
	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	err = api.service.DeleteTask(task)
	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	return c.String(http.StatusOK, "")
}

func (api *TaskApi) GetTaskLog(c echo.Context) error {
	uuid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	task, err := api.service.GetTask(uuid)
	if err != nil || task.Log == "" {
		return c.String(http.StatusNotFound, "not found")
	}

	logUrl := task.Log
	if c.QueryParam("follow") == "1" {
		// Ask logstash to hold the response open while the task is writing.
		// Parsed rather than appended blindly: the producer never puts a
		// query string on task.Log today, but string concatenation would
		// silently build a malformed URL (a second "?", or dropping an
		// existing parameter) the day that stops being true.
		parsed, err := url.Parse(logUrl)
		if err != nil {
			return c.String(http.StatusBadGateway, err.Error())
		}
		query := parsed.Query()
		query.Set("follow", "1")
		parsed.RawQuery = query.Encode()
		logUrl = parsed.String()
	}

	// The request context ties the upstream connection to this client. Without
	// it, a closed dialog would leave the upstream read running for the rest of
	// the task.
	request, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, logUrl, nil)
	if err != nil {
		return c.String(http.StatusBadRequest, err.Error())
	}

	response, err := logProxyClient.Do(request)
	if err != nil {
		return c.String(http.StatusBadGateway, err.Error())
	}
	defer response.Body.Close()

	c.Response().Header().Set(echo.HeaderContentType, response.Header.Get("Content-Type"))
	// A buffering reverse proxy is the one deployment where chunked streaming
	// stalls; this asks nginx not to.
	c.Response().Header().Set("X-Accel-Buffering", "no")
	// Forward the upstream status rather than assuming 200: a log that has not
	// been written yet 404s, and the dashboard's browser-side retry depends on
	// seeing that 404 rather than a masked 200.
	c.Response().WriteHeader(response.StatusCode)

	// Copy by hand rather than with c.Stream: io.Copy leaves the bytes in
	// net/http's buffer, which defeats the point of streaming.
	buf := make([]byte, 4096)
	for {
		n, readErr := response.Body.Read(buf)
		if n > 0 {
			if _, err := c.Response().Write(buf[:n]); err != nil {
				return nil
			}
			c.Response().Flush()
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
			return nil
		}
	}
}
