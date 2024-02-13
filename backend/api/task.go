package api

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
)

type TaskApi struct {
	service *model.TaskService
}

func NewTaskApi(service *model.TaskService) *TaskApi {
	return &TaskApi{service: service}
}

func (api *TaskApi) AddTask(c *gin.Context) {
	var event model.TaskEvent
	var err error
	var task *model.Task

	if err = c.ShouldBindJSON(&event); err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
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
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	c.JSON(http.StatusOK, task)
}

func (api *TaskApi) GetStatistics(c *gin.Context) {
	stats, err := api.service.GetStatistics()
	if err != nil {
		c.String(http.StatusInternalServerError, "internal server error")
		return
	}

	c.JSON(http.StatusOK, stats)
}

func (api *TaskApi) GetTasks(c *gin.Context) {
	tasks, err := api.service.GetTasks()
	if err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	c.JSON(http.StatusOK, tasks)
}

func (api *TaskApi) GetTaskEvents(c *gin.Context) {
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		err = fmt.Errorf("failed to upgrade to websocket: %w", err)
		c.String(http.StatusBadRequest, err.Error())
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

func (api *TaskApi) DeleteTask(c *gin.Context) {
	uuid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	task, err := api.service.GetTask(uuid)
	if err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	err = api.service.DeleteTask(task)
	if err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	c.String(http.StatusOK, "")
}

func (api *TaskApi) GetTaskLog(c *gin.Context) {
	uuid, err := uuid.Parse(c.Param("id"))
	if err != nil {
		c.String(http.StatusBadRequest, "bad request")
		return
	}

	task, err := api.service.GetTask(uuid)
	if err != nil || task.Log == "" {
		c.String(http.StatusNotFound, "not found")
		return
	}

	transport := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	}

	client := &http.Client{Transport: transport}
	response, err := client.Get(task.Log)
	if err != nil {
		c.String(http.StatusBadGateway, err.Error())
		return
	}

	reader := response.Body
	contentLength := response.ContentLength
	contentType := response.Header.Get("Content-Type")

	c.DataFromReader(http.StatusOK, contentLength, contentType, reader, nil)
}
