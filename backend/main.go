package main

import (
	"context"
	"log"
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

	db := model.NewDatabase()

	taskService := model.NewTaskService(db)

	// Workers get their own broadcast; the task websocket must only ever carry
	// tasks.
	workerService := model.NewWorkerService(db, model.NewBroadcast())

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	options := scheduler.OptionsFromEnvironment()
	go scheduler.NewClient(schedulerUri, options, taskService, workerService).Run(ctx)

	// Users sign in with this provider to cancel builds. Its tokens must be
	// issued to a client that the scheduler accepts tokens for.
	auth := api.AuthConfig{
		Issuer:   os.Getenv("JOLT_AUTH_ISSUER"),
		ClientID: os.Getenv("JOLT_AUTH_CLIENT_ID"),
	}
	if auth.ClientID == "" {
		auth.ClientID = "jolt"
	}

	router := api.NewRouter(
		api.NewTaskApi(taskService),
		api.NewWorkerApi(workerService),
		api.NewBuildApi(scheduler.NewBuildCanceller(schedulerUri, options), auth),
		api.NewEventApi(taskService, workerService),
	)
	if err := router.Run(ctx); err != nil {
		log.Fatal(err)
	}
}
