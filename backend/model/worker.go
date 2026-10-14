package model

import (
	"log"
	"strings"

	"github.com/srand/jolt-dashboard/protocol"
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
	var workers []Worker
	result := service.Db.db.Find(&workers)
	if result.Error != nil {
		return nil, result.Error
	}
	return workers, nil
}

func (service *WorkerService) Upsert(info *protocol.WorkerInfo) error {
	worker := NewWorkerFromInfo(info)
	result := service.Db.db.Save(worker)
	service.Broadcast.Send(worker)
	return result.Error
}

func (service *WorkerService) Remove(id string) error {
	result := service.Db.db.Delete(&Worker{Id: id})
	service.Broadcast.Send(&Worker{Id: id, TaskStatus: "Deleted"})
	return result.Error
}

// ApplySnapshot replaces the worker table with the scheduler's view of the
// world. Workers absent from the snapshot are no longer connected.
func (service *WorkerService) ApplySnapshot(workers []*protocol.WorkerInfo) error {
	present := map[string]bool{}

	for _, info := range workers {
		present[info.GetId()] = true
		if err := service.Upsert(info); err != nil {
			return err
		}
	}

	known, err := service.GetWorkers()
	if err != nil {
		return err
	}

	for _, worker := range known {
		if present[worker.Id] {
			continue
		}
		if err := service.Remove(worker.Id); err != nil {
			return err
		}
	}

	return nil
}
