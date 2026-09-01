package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/labstack/echo/v4"
)

type Router struct {
	engine *echo.Echo
}

func HttpLogger(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		err := next(c)
		now := time.Now().Format("2006-01-02 15:04:05.000")
		if err != nil {
			fmt.Printf("%s %4s %s %v\n", now, c.Request().Method, c.Request().URL, err)
		} else {
			fmt.Printf("%s %4s %s %v\n", now, c.Request().Method, c.Request().URL, c.Response().Status)
		}
		return err
	}
}

func NewRouter(
	apiTask *TaskApi,
	apiWorker *WorkerApi,
) *Router {
	r := echo.New()

	r.Use(HttpLogger)

	v1 := r.Group("/api/v1/")
	v1.GET("statistics", apiTask.GetStatistics)
	v1.GET("tasks", apiTask.GetTasks)
	// v1.GET("task/:id", apiTask.GetTask)
	v1.DELETE("tasks/:id", apiTask.DeleteTask)
	v1.GET("tasks/:id/log", apiTask.GetTaskLog)
	v1.GET("tasks/events", apiTask.GetTaskEvents)
	v1.GET("workers", apiWorker.GetWorkers)
	v1.GET("workers/events", apiWorker.GetWorkerEvents)

	r.Static("/", "static")
	r.RouteNotFound("/*", func(ctx echo.Context) error {
		return ctx.File("static/index.html")
	})

	return &Router{engine: r}
}

func (router *Router) Run(ctx context.Context) error {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := &http.Server{
		Addr:    net.JoinHostPort("", port),
		Handler: router.engine,
	}

	served := make(chan error, 1)
	go func() {
		err := server.ListenAndServe()
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		served <- err
	}()

	select {
	case err := <-served:
		return err
	case <-ctx.Done():
	}

	// Websocket clients never close on their own, so don't wait forever.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	return server.Shutdown(shutdownCtx)
}
