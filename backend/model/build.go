package model

import (
	"log"

	"github.com/srand/jolt-dashboard/protocol"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Only explicitly allowlisted attribution is retained from generic parameters.
type Build struct {
	ID         string `json:"Id" gorm:"primaryKey"`
	Status     string
	Scheduled  string
	Username   string
	Origin     string
	Registered bool `gorm:"index"`
}

type BuildService struct {
	Db        *Database
	Broadcast *Broadcast
}

func NewBuildService(db *Database, broadcast *Broadcast) *BuildService {
	if err := db.db.AutoMigrate(&Build{}); err != nil {
		log.Fatal(err)
	}
	return &BuildService{Db: db, Broadcast: broadcast}
}

func (service *BuildService) Upsert(info *protocol.BuildInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	if info.GetId() == "" {
		return nil
	}
	var views []Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.upsert(tx, info); err != nil {
			return err
		}
		var err error
		views, err = snapshotTaskViews(tx, nil, []string{info.GetId()})
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}

// Internal operations run under the shared task/build coordinator.
func (service *BuildService) upsert(db *gorm.DB, info *protocol.BuildInfo) error {
	if info.GetId() == "" {
		return nil
	}
	build := &Build{
		ID: info.GetId(), Status: info.GetStatus().String(),
		Scheduled: FormatTime(info.GetScheduledAt()), Registered: true,
	}
	for _, parameter := range info.GetParameters() {
		switch parameter.GetKey() {
		case "config.username":
			build.Username = parameter.GetValue()
		case "config.origin":
			build.Origin = parameter.GetValue()
		}
	}
	return db.Clauses(clause.OnConflict{UpdateAll: true}).Create(build).Error
}

func (service *BuildService) Remove(id string) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var views []Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.remove(tx, id); err != nil {
			return err
		}
		var err error
		views, err = snapshotTaskViews(tx, nil, []string{id})
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}

func (service *BuildService) remove(db *gorm.DB, id string) error {
	return db.Model(&Build{}).Where("id = ?", id).Update("registered", false).Error
}

// Snapshots contain registered builds, not all builds referenced by task history.
func (service *BuildService) ApplySnapshot(infos []*protocol.BuildInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	var views []Task
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		affected, err := service.applySnapshot(tx, infos)
		if err != nil {
			return err
		}
		views, err = snapshotTaskViews(tx, nil, affected)
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	return nil
}

func (service *BuildService) applySnapshot(db *gorm.DB, infos []*protocol.BuildInfo) ([]string, error) {
	present := make([]string, 0, len(infos))
	seen := map[string]bool{}
	for _, info := range infos {
		if err := service.upsert(db, info); err != nil {
			return nil, err
		}
		if info.GetId() != "" && !seen[info.GetId()] {
			present = append(present, info.GetId())
			seen[info.GetId()] = true
		}
	}
	var missing []Build
	query := db.Where("registered = ?", true)
	if len(present) > 0 {
		query = query.Where("id NOT IN ?", present)
	}
	if err := query.Find(&missing).Error; err != nil {
		return nil, err
	}
	affected := append([]string(nil), present...)
	for _, build := range missing {
		if err := service.remove(db, build.ID); err != nil {
			return nil, err
		}
		affected = append(affected, build.ID)
	}
	return affected, nil
}

func (service *BuildService) GarbageCollect() error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	return service.garbageCollect()
}

func (service *BuildService) garbageCollect() error {
	return service.Db.db.Where("registered = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.build_id = builds.id)", false).
		Delete(&Build{}).Error
}
