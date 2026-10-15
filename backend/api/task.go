package api

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/srand/jolt-dashboard/model"
)

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

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	}

	url := task.Log
	if c.QueryParam("follow") == "1" {
		// Ask logstash to hold the response open while the task is writing.
		url += "?follow=1"
	}

	// The request context ties the upstream connection to this client. Without
	// it, a closed dialog would leave the upstream read running for the rest of
	// the task.
	request, err := http.NewRequestWithContext(c.Request().Context(), http.MethodGet, url, nil)
	if err != nil {
		return c.String(http.StatusBadRequest, err.Error())
	}

	client := &http.Client{Transport: transport}
	response, err := client.Do(request)
	if err != nil {
		return c.String(http.StatusBadGateway, err.Error())
	}
	defer response.Body.Close()

	c.Response().Header().Set(echo.HeaderContentType, response.Header.Get("Content-Type"))
	// A buffering reverse proxy is the one deployment where chunked streaming
	// stalls; this asks nginx not to.
	c.Response().Header().Set("X-Accel-Buffering", "no")
	c.Response().WriteHeader(http.StatusOK)

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
			return nil
		}
	}
}
