package model

import (
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
)

type Task struct {
	Instance   uuid.UUID `json:"id" gorm:"primaryKey"`
	Name       string
	Identity   string
	RoutingKey string
	Worker     string
	Status     string
	Queued     string
	Assigned   string
	Started    string
	Ended      string
	Log        string
}

// Timestamps are stored as strings in the format the web application parses.
const timeFormat = "2006-01-02 15:04:05.999"

func Now() string {
	return time.Now().Format(timeFormat)
}

func FormatTime(timestamp *timestamppb.Timestamp) string {
	if timestamp == nil {
		return ""
	}
	return timestamp.AsTime().Local().Format(timeFormat)
}

// TaskStatusName maps a scheduler task status onto the status names used by
// the dashboard UI.
func TaskStatusName(status protocol.TaskStatus) string {
	switch status {
	case protocol.TaskStatus_TASK_QUEUED, protocol.TaskStatus_TASK_CREATED:
		return "Queued"
	case protocol.TaskStatus_TASK_ASSIGNED:
		return "Assigned"
	case protocol.TaskStatus_TASK_RUNNING:
		return "Running"
	case protocol.TaskStatus_TASK_PASSED,
		protocol.TaskStatus_TASK_UPLOADED,
		protocol.TaskStatus_TASK_DOWNLOADED,
		protocol.TaskStatus_TASK_SKIPPED:
		return "Passed"
	case protocol.TaskStatus_TASK_FAILED,
		protocol.TaskStatus_TASK_ERROR,
		protocol.TaskStatus_TASK_UNSTABLE:
		return "Failed"
	case protocol.TaskStatus_TASK_CANCELLED:
		return "Cancelled"
	default:
		return "Queued"
	}
}

func NewTaskFromInfo(info *protocol.TaskInfo) (*Task, error) {
	instance, err := uuid.Parse(info.GetInstance())
	if err != nil {
		return nil, err
	}

	return &Task{
		Instance:   instance,
		Name:       info.GetName(),
		Identity:   info.GetIdentity(),
		RoutingKey: strings.Join(info.GetLabels(), ","),
		Worker:     info.GetWorkerHostname(),
		Status:     TaskStatusName(info.GetStatus()),
		Queued:     FormatTime(info.GetQueuedAt()),
		Assigned:   FormatTime(info.GetAssignedAt()),
		Started:    FormatTime(info.GetStartedAt()),
		Ended:      FormatTime(info.GetEndedAt()),
		Log:        info.GetLog(),
	}, nil
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
		queuedCutoff := time.Now().Add(-(time.Hour * 48)).Format(timeFormat)
		endedCutOff := time.Now().Add(-time.Hour).Format(timeFormat)

		var tasks []Task
		service.Db.db.Where("(queued < ?) or (ended != '' and ended < ?) ", queuedCutoff, endedCutOff).Find(&tasks)

		for _, lost := range tasks {
			service.DeleteTask(&lost)
		}
	}
}

func (service *TaskService) updateTask(task *Task) error {
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
		case "Queued", "Assigned":
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

// ApplyTaskInfo records the scheduler's view of a single task.
func (service *TaskService) ApplyTaskInfo(info *protocol.TaskInfo) error {
	task, err := NewTaskFromInfo(info)
	if err != nil {
		return err
	}

	previous, previousErr := service.GetTask(task.Instance)
	if previousErr == nil && task.Assigned == "" {
		task.Assigned = previous.Assigned
	}

	// The scheduler clears the log URL for queued and cancelled tasks, but a
	// log recorded by an earlier attempt is still worth keeping.
	if task.Log == "" && previousErr == nil {
		task.Log = previous.Log
	}

	return service.updateTask(task)
}

// ApplySnapshot reconciles the database with the scheduler's complete view of
// its queued and running tasks. Tasks the dashboard still believes to be in
// progress but that the scheduler no longer knows about are terminated; they
// were lost while the dashboard was disconnected.
func (service *TaskService) ApplySnapshot(tasks []*protocol.TaskInfo) error {
	present := map[uuid.UUID]bool{}

	for _, info := range tasks {
		task, err := NewTaskFromInfo(info)
		if err != nil {
			log.Println("discarding task with malformed instance id:", err)
			continue
		}
		present[task.Instance] = true

		if err := service.ApplyTaskInfo(info); err != nil {
			return err
		}
	}

	var stale []Task
	result := service.Db.db.Where("status in ?", []string{"Queued", "Assigned", "Running"}).Find(&stale)
	if result.Error != nil {
		return result.Error
	}

	for _, task := range stale {
		if present[task.Instance] {
			continue
		}

		task.Status = "Cancelled"
		task.Ended = Now()
		if err := service.updateTask(&task); err != nil {
			return err
		}
	}

	return nil
}
