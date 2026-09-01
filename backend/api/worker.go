package api

import (
	"net/http"

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
