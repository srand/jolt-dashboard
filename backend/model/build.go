package model

import (
	"log"

	"github.com/srand/jolt-dashboard/protocol"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// A configuration parameter of a build, as submitted by the client.
type Parameter struct {
	Key   string
	Value string
}

// Origin is the attribution parameter. All parameters are stored and shown:
// the scheduler shows them to all its readers, and clients must not put
// secrets in them. Who submitted a build is known from its owners, not from
// parameters.
type Build struct {
	ID         string `json:"Id" gorm:"primaryKey"`
	Status     string
	Scheduled  string
	Origin     string
	Parameters []Parameter `gorm:"serializer:json"`
	// Authenticated clients that submitted the build, who may cancel it.
	Owners     []string `gorm:"serializer:json"`
	Registered bool     `gorm:"index"`
}

// A build as sent on the builds stream. The lower-case id is the key that
// the stream uses for all its items.
type BuildView struct {
	Build
	StreamID string `json:"id"`
}

type BuildService struct {
	Db *Database
	// Task views, whose builds change with the builds.
	Broadcast *Broadcast
	// The builds themselves.
	Updates *Broadcast
}

func NewBuildService(db *Database, broadcast *Broadcast) *BuildService {
	if err := db.db.AutoMigrate(&Build{}); err != nil {
		log.Fatal(err)
	}
	return &BuildService{Db: db, Broadcast: broadcast, Updates: NewBroadcast()}
}

// GetBuilds returns the registered builds, and the builds of the tasks that
// are still listed.
func (service *BuildService) getBuilds(db *gorm.DB) ([]BuildView, error) {
	var builds []Build
	if err := db.Find(&builds).Error; err != nil {
		return nil, err
	}
	views := make([]BuildView, 0, len(builds))
	for _, build := range builds {
		views = append(views, BuildView{Build: build, StreamID: build.ID})
	}
	return views, nil
}

// Subscribe returns the current builds and a channel for their updates.
func (service *BuildService) Subscribe() (*EventSubscription, error) {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	consumer := service.Updates.NewClient()
	builds, err := service.getBuilds(service.Db.db)
	if err != nil {
		consumer.Close()
		return nil, err
	}
	return &EventSubscription{Snapshot: builds, Chan: consumer.Chan, consumer: consumer}, nil
}

// Select the final views of builds in the mutation transaction; builds that
// no longer exist are marked as deleted. Callers publish after commit.
func buildViews(db *gorm.DB, ids []string) ([]BuildView, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var builds []Build
	if err := db.Where("id IN ?", ids).Find(&builds).Error; err != nil {
		return nil, err
	}
	found := map[string]Build{}
	for _, build := range builds {
		found[build.ID] = build
	}
	views := []BuildView{}
	seen := map[string]bool{}
	for _, id := range ids {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		if build, ok := found[id]; ok {
			views = append(views, BuildView{Build: build, StreamID: id})
		} else {
			views = append(views, BuildView{Build: Build{ID: id, Status: "Deleted"}, StreamID: id})
		}
	}
	return views, nil
}

func (service *BuildService) publish(views []BuildView) {
	for i := range views {
		service.Updates.Send(&views[i])
	}
}

func (service *BuildService) Upsert(info *protocol.BuildInfo) error {
	service.Db.taskCoordinator.Lock()
	defer service.Db.taskCoordinator.Unlock()
	if info.GetId() == "" {
		return nil
	}
	var views []Task
	var builds []BuildView
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.upsert(tx, info); err != nil {
			return err
		}
		var err error
		if views, err = snapshotTaskViews(tx, nil, []string{info.GetId()}); err != nil {
			return err
		}
		builds, err = buildViews(tx, []string{info.GetId()})
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	service.publish(builds)
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
		Owners: append([]string{}, info.GetOwners()...),
	}
	build.Parameters = []Parameter{}
	for _, parameter := range info.GetParameters() {
		build.Parameters = append(build.Parameters, Parameter{Key: parameter.GetKey(), Value: parameter.GetValue()})
		switch parameter.GetKey() {
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
	var builds []BuildView
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		if err := service.remove(tx, id); err != nil {
			return err
		}
		var err error
		if views, err = snapshotTaskViews(tx, nil, []string{id}); err != nil {
			return err
		}
		builds, err = buildViews(tx, []string{id})
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	service.publish(builds)
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
	var builds []BuildView
	if err := service.Db.db.Transaction(func(tx *gorm.DB) error {
		affected, err := service.applySnapshot(tx, infos)
		if err != nil {
			return err
		}
		if views, err = snapshotTaskViews(tx, nil, affected); err != nil {
			return err
		}
		builds, err = buildViews(tx, affected)
		return err
	}); err != nil {
		return err
	}
	for i := range views {
		service.Broadcast.Send(&views[i])
	}
	service.publish(builds)
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
	var unused []Build
	if err := service.Db.db.Where("registered = ? AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.build_id = builds.id)", false).
		Find(&unused).Error; err != nil {
		return err
	}
	if len(unused) == 0 {
		return nil
	}
	ids := make([]string, 0, len(unused))
	for _, build := range unused {
		ids = append(ids, build.ID)
	}
	if err := service.Db.db.Where("id IN ?", ids).Delete(&Build{}).Error; err != nil {
		return err
	}
	views, err := buildViews(service.Db.db, ids)
	if err != nil {
		return err
	}
	service.publish(views)
	return nil
}
