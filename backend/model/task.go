package model

import (
	"log"
	"time"

	"github.com/google/uuid"
)

type Task struct {
	Instance   uuid.UUID `json:"id" gorm:"primaryKey"`
	Name       string
	Identity   string
	RoutingKey string
	Worker     string
	Status     string
	Queued     string
	Started    string
	Ended      string
	Log        string
}

func Now() string {
	return time.Now().Format("2006-01-02 15:04:05.999")
}

func NewTaskFromEvent(event *TaskEvent) *Task {
	task := Task{}
	task.Identity = event.Identity
	task.Instance = event.Instance
	task.RoutingKey = event.RoutingKey
	task.Name = event.Name
	task.Queued = Now()
	task.Status = "Queued"
	task.Worker = event.Hostname
	task.Log = event.Log
	return &task
}

type TaskEvent struct {
	Event      string
	Hostname   string
	RoutingKey string `json:"routing_key,omitempty"`
	Identity   string
	Instance   uuid.UUID
	Name       string
	Role       string
	Log        string
}

type TaskService struct {
	Db        *Database
	Broadcast *Broadcast
}

func NewTaskService(db *Database) *TaskService {
	err := db.AutoMigrate(&Task{})
	if err != nil {
		log.Fatal(err)
	}
	service := &TaskService{Db: db, Broadcast: NewBroadcast()}
	go service.garbageCollect()
	return service
}

func (service *TaskService) garbageCollect() {
	timer := time.NewTicker(time.Minute)
	for {
		<-timer.C
		queuedCutoff := time.Now().Add(-(time.Hour * 48)).Format("2006-01-02 15:04:05.999")
		endedCutOff := time.Now().Add(-time.Hour).Format("2006-01-02 15:04:05.999")

		var tasks []Task
		service.Db.db.Where("(queued < ?) or (ended != '' and ended < ?) ", queuedCutoff, endedCutOff).Find(&tasks)

		for _, lost := range tasks {
			service.DeleteTask(&lost)
		}
	}
}

func (service *TaskService) updateTask(task *Task) error {
	// Force-end tasks already running on same worker
	if task.Status == "Running" {
		var tasks []Task
		service.Db.db.Where("worker = ? and started != '' and ended = ''", task.Worker).Find(&tasks)
		for _, lost := range tasks {
			lost.Status = "Passed"
			lost.Ended = Now()
			service.Db.db.Save(lost)
			service.Broadcast.Send(lost)
		}
	}
	result := service.Db.db.Save(task)
	service.Broadcast.Send(task)
	return result.Error
}

func (service *TaskService) GetStatistics() (*Statistics, error) {
	var tasks []Task
	result := service.Db.db.Find(&tasks)
	if result.Error != nil {
		return nil, result.Error
	}

	stats := &Statistics{
		RoutingKeys: map[string]*Metrics{},
		Workers:     map[string]*BaseMetrics{},
		Tasks:       NewMetrics(),
	}

	for _, task := range tasks {
		if _, ok := stats.RoutingKeys[task.RoutingKey]; task.RoutingKey != "" && !ok {
			stats.RoutingKeys[task.RoutingKey] = NewMetrics()
		}
		if _, ok := stats.Workers[task.Worker]; task.Worker != "" && !ok {
			stats.Workers[task.Worker] = NewBaseMetrics()
		}

		switch task.Status {
		case "Queued":
			stats.Tasks.Queued++
			stats.Tasks.WaitTime.AddTask(&task)
			if task.RoutingKey != "" {
				m := stats.RoutingKeys[task.RoutingKey]
				m.Queued++
				m.WaitTime.AddTask(&task)
				stats.RoutingKeys[task.RoutingKey] = m
			}
		case "Running":
			stats.Tasks.Running++
			stats.Tasks.WaitTime.AddTask(&task)
			if task.RoutingKey != "" {
				m := stats.RoutingKeys[task.RoutingKey]
				m.Running++
				m.WaitTime.AddTask(&task)
				stats.RoutingKeys[task.RoutingKey] = m
			}
			if task.Worker != "" {
				m := stats.Workers[task.Worker]
				m.Running++
				m.WaitTime.AddTask(&task)
				stats.Workers[task.Worker] = m
			}
		case "Passed":
			stats.Tasks.Passed++
			stats.Tasks.WaitTime.AddTask(&task)
			if task.RoutingKey != "" {
				m := stats.RoutingKeys[task.RoutingKey]
				m.Passed++
				m.WaitTime.AddTask(&task)
				stats.RoutingKeys[task.RoutingKey] = m
			}
			if task.Worker != "" {
				m := stats.Workers[task.Worker]
				m.Passed++
				m.WaitTime.AddTask(&task)
				stats.Workers[task.Worker] = m
			}
		case "Failed":
			stats.Tasks.Failed++
			stats.Tasks.WaitTime.AddTask(&task)
			if task.RoutingKey != "" {
				m := stats.RoutingKeys[task.RoutingKey]
				m.Failed++
				m.WaitTime.AddTask(&task)
				stats.RoutingKeys[task.RoutingKey] = m
			}
			if task.Worker != "" {
				m := stats.Workers[task.Worker]
				m.Failed++
				m.WaitTime.AddTask(&task)
				stats.Workers[task.Worker] = m
			}
		case "Cancelled":
			stats.Tasks.Cancelled++
		}
	}

	stats.Tasks.WaitTime.Update()
	for routingKey := range stats.RoutingKeys {
		stats.RoutingKeys[routingKey].WaitTime.Update()
	}
	for worker := range stats.Workers {
		stats.Workers[worker].WaitTime.Update()
	}

	return stats, nil
}

func (service *TaskService) GetTask(instance uuid.UUID) (*Task, error) {
	var dbtask Task
	result := service.Db.db.Where("instance = ?", instance).Take(&dbtask)
	if result.Error != nil {
		return nil, result.Error
	}
	return &dbtask, nil
}

func (service *TaskService) GetTasks() ([]Task, error) {
	var tasks []Task
	result := service.Db.db.Find(&tasks)
	if result.Error != nil {
		return nil, result.Error
	}
	return tasks, nil
}

func (service *TaskService) DeleteTask(task *Task) error {
	task.Status = "Deleted"
	service.Broadcast.Send(task)
	return service.Db.Delete(task)
}

func (service *TaskService) TaskQueued(event *TaskEvent) (*Task, error) {
	task := NewTaskFromEvent(event)
	task.Worker = ""
	return task, service.updateTask(task)
}

func (service *TaskService) TaskStarted(event *TaskEvent) (*Task, error) {
	task, err := service.GetTask(event.Instance)
	if err != nil {
		task = NewTaskFromEvent(event)
	}
	if task.Log == "" {
		task.Log = event.Log
	}
	task.Started = Now()
	task.Status = "Running"
	task.Worker = event.Hostname
	return task, service.updateTask(task)
}

func (service *TaskService) TaskFinished(event *TaskEvent) (*Task, error) {
	task, err := service.GetTask(event.Instance)
	if err != nil {
		task = NewTaskFromEvent(event)
		task.Started = Now()
	}
	if task.Worker == "" {
		task.Worker = event.Hostname
	}
	if task.Log == "" {
		task.Log = event.Log
	}
	task.Ended = Now()
	task.Status = "Passed"
	return task, service.updateTask(task)
}

func (service *TaskService) TaskFailed(event *TaskEvent) (*Task, error) {
	task, err := service.GetTask(event.Instance)
	if err != nil {
		task = NewTaskFromEvent(event)
		task.Started = Now()
	}
	if task.Worker == "" {
		task.Worker = event.Hostname
	}
	if task.Log == "" {
		task.Log = event.Log
	}
	task.Ended = Now()
	task.Status = "Failed"
	return task, service.updateTask(task)
}

func (service *TaskService) TaskCancelled(event *TaskEvent) (*Task, error) {
	task, err := service.GetTask(event.Instance)
	if err != nil {
		task = NewTaskFromEvent(event)
	}
	if task.Worker == "" {
		task.Worker = event.Hostname
	}
	task.Log = ""
	task.Ended = Now()
	task.Status = "Cancelled"
	return task, service.updateTask(task)
}
