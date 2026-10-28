package model

import (
	"log"
	"strings"

	"github.com/srand/jolt-dashboard/protocol"
	"gorm.io/gorm"
)

// A worker connected to the scheduler.
type Worker struct {
	Id           string `json:"id" gorm:"primaryKey"`
	Hostname     string
	Labels       string
	TaskInstance string
	TaskName     string
	TaskStatus   string
	TaskLog      string
	Enlisted     string
}

type WorkerService struct {
	Db        *Database
	Broadcast *Broadcast
}

func NewWorkerService(db *Database, broadcast *Broadcast) *WorkerService {
	if err := db.AutoMigrate(&Worker{}); err != nil {
		log.Fatal(err)
	}
	return &WorkerService{Db: db, Broadcast: broadcast}
}

func NewWorkerFromInfo(info *protocol.WorkerInfo) *Worker {
	worker := &Worker{
		Id:       info.GetId(),
		Hostname: info.GetHostname(),
		Labels:   strings.Join(platformLabels(info.GetPlatform()), ","),
		Enlisted: FormatTime(info.GetEnlistedAt()),
	}

	if task := info.GetTask(); task != nil {
		worker.TaskInstance = task.GetInstance()
		worker.TaskName = task.GetName()
		worker.TaskStatus = TaskStatusName(task.GetStatus())
		worker.TaskLog = task.GetLog()
	}

	return worker
}

func platformLabels(platform *protocol.Platform) []string {
	labels := []string{}
	for _, property := range platform.GetProperties() {
		if property.GetKey() == "label" {
			labels = append(labels, property.GetValue())
		}
	}
	return labels
}

func (service *WorkerService) GetWorkers() ([]Worker, error) {
	service.Db.workerCoordinator.Lock()
	defer service.Db.workerCoordinator.Unlock()
	return service.getWorkers(service.Db.db)
}

func (service *WorkerService) getWorkers(db *gorm.DB) ([]Worker, error) {
	workers := []Worker{}
	result := db.Find(&workers)
	if result.Error != nil {
		return nil, result.Error
	}
	return workers, nil
}

func (service *WorkerService) Subscribe() (*EventSubscription, error) {
	service.Db.workerCoordinator.Lock()
	defer service.Db.workerCoordinator.Unlock()
	consumer := service.Broadcast.NewClient()
	workers, err := service.getWorkers(service.Db.db)
	if err != nil {
		consumer.Close()
		return nil, err
	}
	return &EventSubscription{Snapshot: workers, Chan: consumer.Chan, consumer: consumer}, nil
}

func (service *WorkerService) Upsert(info *protocol.WorkerInfo) error {
	service.Db.workerCoordinator.Lock()
	defer service.Db.workerCoordinator.Unlock()
	worker := NewWorkerFromInfo(info)
	if err := service.Db.db.Save(worker).Error; err != nil {
		return err
	}
	service.Broadcast.Send(worker)
	return nil
}

func (service *WorkerService) Remove(id string) error {
	service.Db.workerCoordinator.Lock()
	defer service.Db.workerCoordinator.Unlock()
	if err := service.Db.db.Delete(&Worker{Id: id}).Error; err != nil {
		return err
	}
	service.Broadcast.Send(&Worker{Id: id, TaskStatus: "Deleted"})
	return nil
}

// ApplySnapshot replaces the worker table with the scheduler's view of the
// world. Workers absent from the snapshot are no longer connected.
func (service *WorkerService) ApplySnapshot(workers []*protocol.WorkerInfo) error {
	service.Db.workerCoordinator.Lock()
	defer service.Db.workerCoordinator.Unlock()
	var views []Worker
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		present := map[string]bool{}
		for _, info := range workers {
			present[info.GetId()] = true
			worker := NewWorkerFromInfo(info)
			if err := tx.Save(worker).Error; err != nil {
				return err
			}
			views = append(views, *worker)
		}
		known, err := service.getWorkers(tx)
		if err != nil {
			return err
		}
		for _, worker := range known {
			if present[worker.Id] {
				continue
			}
			if err := tx.Delete(&worker).Error; err != nil {
				return err
			}
			views = append(views, Worker{Id: worker.Id, TaskStatus: "Deleted"})
		}
		return nil
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}
