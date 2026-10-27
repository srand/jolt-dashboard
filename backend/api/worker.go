package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/srand/jolt-dashboard/model"
)

type WorkerApi struct {
	service *model.WorkerService
}

func NewWorkerApi(service *model.WorkerService) *WorkerApi {
	return &WorkerApi{service: service}
}

func (api *WorkerApi) GetWorkers(w http.ResponseWriter, r *http.Request) {
	workers, err := api.service.GetWorkers()
	if err != nil {
		writeString(w, http.StatusInternalServerError, "internal server error")
		return
	}

	writeJSON(w, http.StatusOK, workers)
}

func (api *WorkerApi) GetWorkerEvents(w http.ResponseWriter, r *http.Request) {
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
}
