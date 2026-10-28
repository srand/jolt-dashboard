package model

import (
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
	"gorm.io/gorm"
)

type Task struct {
	Instance uuid.UUID `json:"id" gorm:"primaryKey"`
	Name     string
	Identity string
	BuildID  string `json:"BuildId" gorm:"index;not null;default:''"`
	// Missing builds are valid, including when tasks arrive before build events.
	Build      *Build `gorm:"foreignKey:BuildID;references:ID;constraint:-"`
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
		BuildID:    info.GetBuildId(),
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
	Builds    *BuildService
}

func NewTaskService(db *Database) *TaskService {
	service := &TaskService{Db: db, Broadcast: NewBroadcast()}
	service.Builds = NewBuildService(db, service.Broadcast)
	err := db.db.AutoMigrate(&Task{})
	if err != nil {
		log.Fatal(err)
	}
	go service.garbageCollect()
	return service
}

func (service *TaskService) garbageCollect() {
	timer := time.NewTicker(time.Minute)
	for {
		<-timer.C
		if err := service.collectExpiredTasks(time.Now()); err != nil {
			log.Println("task retention failed:", err)
		}
	}
}

func (service *TaskService) collectExpiredTasks(now time.Time) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	queuedCutoff := now.Add(-time.Hour * 48).Format(timeFormat)
	endedCutoff := now.Add(-time.Hour).Format(timeFormat)
	var tasks []Task
	if err := service.Db.db.Preload("Build").Where("(queued < ?) or (ended != '' and ended < ?)", queuedCutoff, endedCutoff).Find(&tasks).Error; err != nil {
		return err
	}
	for i := range tasks {
		if err := service.deleteTask(&tasks[i]); err != nil {
			return err
		}
	}
	return service.Builds.garbageCollect()
}

func (service *TaskService) updateTask(task *Task) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var view *Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.saveTask(tx, task); err != nil {
			return err
		}
		var err error
		view, err = service.getTask(tx, task.Instance)
		return err
	}); err != nil {
		return err
	}
	service.Broadcast.Send(view)
	return nil
}

// Internal operations run under the shared task/build coordinator.
func (service *TaskService) saveTask(db *gorm.DB, task *Task) error {
	return db.Omit("Build").Save(task).Error
}

func (service *TaskService) GetStatistics() (*Statistics, error) {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
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
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	return service.getTask(service.Db.db, instance)
}

func (service *TaskService) getTask(db *gorm.DB, instance uuid.UUID) (*Task, error) {
	var dbtask Task
	result := db.Preload("Build").Where("instance = ?", instance).Take(&dbtask)
	if result.Error != nil {
		return nil, result.Error
	}
	return &dbtask, nil
}

func (service *TaskService) GetTasks() ([]Task, error) {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	return service.getTasks()
}

func (service *TaskService) getTasks() ([]Task, error) {
	tasks := []Task{}
	result := service.Db.db.Preload("Build").Find(&tasks)
	if result.Error != nil {
		return nil, result.Error
	}
	return tasks, nil
}

func (service *TaskService) Subscribe() (*EventSubscription, error) {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	consumer := service.Broadcast.NewClient()
	tasks, err := service.getTasks()
	if err != nil {
		consumer.Close()
		return nil, err
	}
	return &EventSubscription{Snapshot: tasks, Chan: consumer.Chan, consumer: consumer}, nil
}

func (service *TaskService) DeleteTask(task *Task) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	return service.deleteTask(task)
}

func (service *TaskService) deleteTask(task *Task) error {
	if err := service.Db.db.Delete(task).Error; err != nil {
		return err
	}
	deleted := *task
	deleted.Status = "Deleted"
	service.Broadcast.Send(&deleted)
	return nil
}

// ApplyTaskInfo records the scheduler's view of a single task.
func (service *TaskService) ApplyTaskInfo(info *protocol.TaskInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var view *Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.applyTaskInfo(tx, info); err != nil {
			return err
		}
		var err error
		view, err = service.getTask(tx, uuid.MustParse(info.GetInstance()))
		return err
	}); err != nil {
		return err
	}
	service.Broadcast.Send(view)
	return nil
}

func (service *TaskService) applyTaskInfo(db *gorm.DB, info *protocol.TaskInfo) error {
	task, err := NewTaskFromInfo(info)
	if err != nil {
		return err
	}

	previous, previousErr := service.getTask(db, task.Instance)
	if previousErr != nil && previousErr != gorm.ErrRecordNotFound {
		return previousErr
	}
	if previousErr == nil && task.Assigned == "" {
		task.Assigned = previous.Assigned
	}

	// The scheduler clears the log URL for queued and cancelled tasks, but a
	// log recorded by an earlier attempt is still worth keeping.
	if task.Log == "" && previousErr == nil {
		task.Log = previous.Log
	}

	return service.saveTask(db, task)
}

// ApplySnapshot reconciles the database with the scheduler's complete view of
// its queued and running tasks. Tasks the dashboard still believes to be in
// progress but that the scheduler no longer knows about are terminated; they
// were lost while the dashboard was disconnected.
func (service *TaskService) ApplySnapshot(tasks []*protocol.TaskInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var views []Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		affected := map[uuid.UUID]bool{}
		if err := service.applySnapshot(tx, tasks, affected); err != nil {
			return err
		}
		var err error
		views, err = snapshotTaskViews(tx, affected, nil)
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}

// ApplyBuildTaskSnapshot reconciles both phases before publishing final views.
// Retention must not remove metadata between build unregistration and task restore.
func (service *TaskService) ApplyBuildTaskSnapshot(builds []*protocol.BuildInfo, tasks []*protocol.TaskInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var views []Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		buildIDs, err := service.Builds.applySnapshot(tx, builds)
		if err != nil {
			return err
		}
		affected := map[uuid.UUID]bool{}
		if err := service.applySnapshot(tx, tasks, affected); err != nil {
			return err
		}
		views, err = snapshotTaskViews(tx, affected, buildIDs)
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}

// Select final views in the mutation transaction; callers publish after commit.
func snapshotTaskViews(db *gorm.DB, affected map[uuid.UUID]bool, buildIDs []string) ([]Task, error) {
	if len(affected) == 0 && len(buildIDs) == 0 {
		return nil, nil
	}
	instances := make([]uuid.UUID, 0, len(affected))
	for instance := range affected {
		instances = append(instances, instance)
	}
	var tasks []Task
	if err := db.Preload("Build").Where("instance IN ? OR build_id IN ?", instances, buildIDs).Find(&tasks).Error; err != nil {
		return nil, err
	}
	return tasks, nil
}

func (service *TaskService) applySnapshot(db *gorm.DB, tasks []*protocol.TaskInfo, affected map[uuid.UUID]bool) error {
	present := map[uuid.UUID]bool{}

	for _, info := range tasks {
		task, err := NewTaskFromInfo(info)
		if err != nil {
			log.Println("discarding task with malformed instance id:", err)
			continue
		}
		present[task.Instance] = true

		if err := service.applyTaskInfo(db, info); err != nil {
			return err
		}
		affected[task.Instance] = true
	}

	var stale []Task
	result := db.Where("status in ?", []string{"Queued", "Assigned", "Running"}).Find(&stale)
	if result.Error != nil {
		return result.Error
	}

	for _, task := range stale {
		if present[task.Instance] {
			continue
		}

		task.Status = "Cancelled"
		task.Ended = Now()
		if err := service.saveTask(db, &task); err != nil {
			return err
		}
		affected[task.Instance] = true
	}

	return nil
}
