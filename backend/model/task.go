package model

import (
	"log"
	"time"

	"github.com/google/uuid"
)

type Task struct {
	Instance uuid.UUID `json:"id" gorm:"primaryKey"`
	Name     string
	Identity string
	Worker   string
	Status   string
	Queued   string
	Started  string
	Ended    string
	Log      string
}

func Now() string {
	return time.Now().Format("2006-01-02 15:04:05.999")
}

func NewTaskFromEvent(event *TaskEvent) *Task {
	task := Task{}
	task.Identity = event.Identity
	task.Instance = event.Instance
	task.Name = event.Name
	task.Queued = Now()
	task.Status = "Queued"
	task.Worker = event.Hostname
	task.Log = event.Log
	return &task
}

type TaskEvent struct {
	Event    string
	Hostname string
	Identity string
	Instance uuid.UUID
	Name     string
	Role     string
	Log      string
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
		expired := time.Now().Add(-time.Hour)
		expiredStr := expired.Format("2006-01-02 15:04:05.999")

		var tasks []Task
		service.Db.db.Where("queued < ?", expiredStr).Find(&tasks)

		for _, lost := range tasks {
			service.DeleteTask(&lost)
		}
	}
}

func (service *TaskService) addTask(task *Task) error {
	return service.Db.Create(task)
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
