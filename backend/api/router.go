package api

import (
	"fmt"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
)

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


func NewRouter(apiTask *TaskApi) http.Handler {
	r := echo.New()

	r.Use(HttpLogger)

	v1 := r.Group("/api/v1/")
	v1.POST("tasks", apiTask.AddTask)
	v1.GET("statistics", apiTask.GetStatistics)
	v1.GET("tasks", apiTask.GetTasks)
	// v1.GET("task/:id", apiTask.GetTask)
	v1.DELETE("tasks/:id", apiTask.DeleteTask)
	v1.GET("tasks/:id/log", apiTask.GetTaskLog)
	v1.GET("tasks/events", apiTask.GetTaskEvents)

	r.Static("/", "static")
	r.RouteNotFound("/*", func(ctx echo.Context) error {
		return ctx.File("static/index.html")
	})

	return r
}
