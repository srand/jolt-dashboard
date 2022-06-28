package main

import (
	"github.com/srand/jolt-dashboard/api"
	model "github.com/srand/jolt-dashboard/model"
)

func main() {
	db := model.NewDatabase()

	taskService := model.NewTaskService(db)
	taskApi := api.NewTaskApi(taskService)

	router := api.NewRouter(taskApi)
	router.Run()
}
