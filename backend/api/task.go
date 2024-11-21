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

func (api *TaskApi) AddTask(c echo.Context) error {
	var event model.TaskEvent
	var err error
	var task *model.Task

	if err = c.Bind(&event); err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	switch event.Event {
	case "queued":
		task, err = api.service.TaskQueued(&event)
	case "started":
		task, err = api.service.TaskStarted(&event)
	case "finished":
		task, err = api.service.TaskFinished(&event)
	case "failed":
		task, err = api.service.TaskFailed(&event)
	case "cancelled":
		task, err = api.service.TaskCancelled(&event)
	}

	if err != nil {
		return c.String(http.StatusBadRequest, "bad request")
	}

	return c.JSON(http.StatusOK, task)
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

	client := &http.Client{Transport: transport}
	response, err := client.Get(task.Log)
	if err != nil {
		return c.String(http.StatusBadGateway, err.Error())
	}

	reader := response.Body
	contentType := response.Header.Get("Content-Type")

	return c.Stream(http.StatusOK, contentType, reader)
}
