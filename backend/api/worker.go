package api

import (
	"net/http"

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
	getEvents(w, r, api.service.Subscribe)
}
