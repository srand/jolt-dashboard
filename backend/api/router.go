package api

import (
	"github.com/gin-gonic/contrib/static"
	"github.com/gin-gonic/gin"
)

type Router struct {
	engine *gin.Engine
}

func NewRouter(
	apiTask *TaskApi,
) *Router {
	r := gin.Default()

	v1 := r.Group("/api/v1/")
	v1.POST("tasks", apiTask.AddTask)
	v1.GET("tasks", apiTask.GetTasks)
	// v1.GET("task/:id", apiTask.GetTask)
	v1.DELETE("tasks/:id", apiTask.DeleteTask)
	v1.GET("tasks/:id/log", apiTask.GetTaskLog)
	v1.GET("tasks/events", apiTask.GetTaskEvents)

	r.Use(static.Serve("/", static.LocalFile("static", true)))
	r.NoRoute(func(ctx *gin.Context) {
		ctx.File("static/index.html")
	})

	return &Router{engine: r}
}

func (router *Router) Run() error {
	return router.engine.Run()
}
