package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"

	"github.com/srand/jolt-dashboard/api"
	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/scheduler"
)

func main() {
	schedulerUri := os.Getenv("JOLT_SCHEDULER_URI")
	if schedulerUri == "" {
		schedulerUri = "tcp://jolt-scheduler:9090"
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	db := model.NewDatabase()

	taskService := model.NewTaskService(db)

	// Workers get their own broadcast; the task websocket must only ever carry
	// tasks.
	workerService := model.NewWorkerService(db, model.NewBroadcast())

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	go scheduler.NewClient(schedulerUri, taskService, workerService).Run(ctx)

	router := api.NewRouter(api.NewTaskApi(taskService), api.NewWorkerApi(workerService))
	if err := http.ListenAndServe(":"+port, router); err != nil {
		log.Fatal(err)
	}
}
