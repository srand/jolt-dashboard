package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/labstack/echo/v4"
	"github.com/srand/jolt-dashboard/model"
)

type WorkerApi struct {
	service *model.WorkerService
}

func NewWorkerApi(service *model.WorkerService) *WorkerApi {
	return &WorkerApi{service: service}
}

func (api *WorkerApi) GetWorkers(c echo.Context) error {
	workers, err := api.service.GetWorkers()
	if err != nil {
		return c.String(http.StatusInternalServerError, "internal server error")
	}

	return c.JSON(http.StatusOK, workers)
}

func (api *WorkerApi) GetWorkerEvents(c echo.Context) error {
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
			case worker := <-consumer.Chan:
				err := ws.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if err != nil {
					ws.Close()
					return
				}

				err = ws.WriteJSON(worker)
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
			break
		}
	}

	cancel()
	return nil
}
