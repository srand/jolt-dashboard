package model

import (
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
	"gorm.io/gorm"
)

func buildInfo(id string) *protocol.BuildInfo {
	return &protocol.BuildInfo{
		Id: id, Status: protocol.BuildStatus_BUILD_ACCEPTED, ScheduledAt: timestamppb.Now(),
		Parameters: []*protocol.Property{
			{Key: "config.username", Value: " builder@example.com <user> "},
			{Key: "config.origin", Value: "https://ci.example.com/build/123"},
			{Key: "config.token", Value: "secret-token"},
			{Key: "origin", Value: "secret-unprefixed"},
			{Key: "params.username", Value: "secret-wrong-prefix"},
			{Key: "config.origin.extra", Value: "secret-suffix"},
		},
	}
}

func TestBuildAndTaskArrivalOrders(t *testing.T) {
	for _, taskFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "task-first", false: "build-first"}[taskFirst], func(t *testing.T) {
			tasks, _ := newTestServices(t)
			// A task-before-build must also work with SQLite FK enforcement enabled.
			if err := tasks.Db.db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
				t.Fatal(err)
			}
			info := newTaskInfo("task", protocol.TaskStatus_TASK_RUNNING)
			build := buildInfo(info.BuildId)
			consumer := tasks.Broadcast.NewClient()
			defer consumer.Close()
			if !taskFirst {
				if err := tasks.Builds.Upsert(build); err != nil {
					t.Fatal(err)
				}
			}
			if err := tasks.ApplyTaskInfo(info); err != nil {
				t.Fatal(err)
			}
			first := (<-consumer.Chan).(*Task)
			if taskFirst {
				if first.Build != nil || first.BuildID != info.BuildId {
					t.Fatalf("task before build = %+v", first)
				}
				if err := tasks.Builds.Upsert(build); err != nil {
					t.Fatal(err)
				}
				first = (<-consumer.Chan).(*Task)
			}
			stored, err := tasks.GetTask(uuid.MustParse(info.Instance))
			if err != nil {
				t.Fatal(err)
			}
			if stored.Build == nil || !reflect.DeepEqual(stored, first) {
				t.Fatalf("stored and broadcast views differ: %+v / %+v", stored, first)
			}
			if stored.Build.Username != build.Parameters[0].Value || stored.Build.Origin != build.Parameters[1].Value || stored.Build.Scheduled != FormatTime(build.ScheduledAt) {
				t.Fatalf("build values not preserved: %+v", stored.Build)
			}
			data, err := json.Marshal(stored)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(data), "secret") || strings.Contains(string(data), "Parameters") {
				t.Fatalf("raw parameters leaked: %s", data)
			}
			columns, err := tasks.Db.db.Migrator().ColumnTypes(&Build{})
			if err != nil {
				t.Fatal(err)
			}
			for _, column := range columns {
				if !strings.Contains("|id|status|scheduled|username|origin|registered|", "|"+column.Name()+"|") {
					t.Fatalf("unexpected build storage column %s", column.Name())
				}
			}
		})
	}
}

func TestBuildPersistenceAndBatchedTaskViews(t *testing.T) {
	dsn := filepath.Join(t.TempDir(), "dashboard.db")
	db := NewDatabaseFromDsn(dsn)
	tasks := &TaskService{Db: db, Broadcast: NewBroadcast()}
	tasks.Builds = NewBuildService(db, tasks.Broadcast)
	if err := db.db.AutoMigrate(&Task{}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"one", "two", "three"} {
		if err := tasks.Builds.Upsert(buildInfo(id)); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 2; i++ {
			info := newTaskInfo("retained", protocol.TaskStatus_TASK_PASSED)
			info.BuildId = id
			if err := tasks.ApplyTaskInfo(info); err != nil {
				t.Fatal(err)
			}
		}
	}
	sqlDB, err := db.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := sqlDB.Close(); err != nil {
		t.Fatal(err)
	}
	// Reopen the same database and migrate again, as a dashboard restart does.
	db = NewDatabaseFromDsn(dsn)
	tasks = &TaskService{Db: db, Broadcast: NewBroadcast()}
	tasks.Builds = NewBuildService(db, tasks.Broadcast)
	if err := db.db.AutoMigrate(&Task{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, err = db.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sqlDB.Close() })
	queries := 0
	if err := db.db.Callback().Query().Before("gorm:query").Register("test:count-queries", func(*gorm.DB) { queries++ }); err != nil {
		t.Fatal(err)
	}
	views, err := tasks.GetTasks()
	if err != nil {
		t.Fatal(err)
	}
	if len(views) != 6 || queries != 2 {
		t.Fatalf("list = %d tasks, %d queries; want 6 tasks and 2 batch queries", len(views), queries)
	}
	for _, view := range views {
		if view.Build == nil || view.Build.ID != view.BuildID || view.Build.Origin != "https://ci.example.com/build/123" {
			t.Fatalf("build association not persisted: %+v", view)
		}
	}
}

func TestBuildUpdatesFanOutWithoutDuplicatingAttribution(t *testing.T) {
	tasks, _ := newTestServices(t)
	build := buildInfo("build")
	if err := tasks.Builds.Upsert(build); err != nil {
		t.Fatal(err)
	}
	for _, status := range []protocol.TaskStatus{protocol.TaskStatus_TASK_RUNNING, protocol.TaskStatus_TASK_PASSED} {
		if err := tasks.ApplyTaskInfo(newTaskInfo("associated", status)); err != nil {
			t.Fatal(err)
		}
	}
	unrelated := newTaskInfo("unrelated", protocol.TaskStatus_TASK_RUNNING)
	unrelated.BuildId = "other"
	if err := tasks.ApplyTaskInfo(unrelated); err != nil {
		t.Fatal(err)
	}
	consumer := tasks.Broadcast.NewClient()
	defer consumer.Close()
	for _, status := range []protocol.BuildStatus{protocol.BuildStatus_BUILD_CANCELLED, protocol.BuildStatus_BUILD_COMPLETED} {
		build.Status = status
		build.Parameters = nil // Replacement metadata must clear removed attributes.
		if err := tasks.Builds.Upsert(build); err != nil {
			t.Fatal(err)
		}
		if len(consumer.Chan) != 2 {
			t.Fatalf("fanout count = %d, want 2", len(consumer.Chan))
		}
		for i := 0; i < 2; i++ {
			view := (<-consumer.Chan).(*Task)
			if view.Build == nil || view.Build.Status != status.String() || !view.Build.Registered || view.Build.Username != "" || view.Build.Origin != "" {
				t.Fatalf("stale build view: %+v", view.Build)
			}
			if view.Status != "Running" && view.Status != "Passed" {
				t.Fatalf("build status overwrote task status: %+v", view)
			}
		}
	}
	var count int64
	if err := tasks.Db.db.Model(&Build{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("build count = %d, error %v", count, err)
	}
	// Saving a loaded task must not save its stale nested build over current data.
	list, err := tasks.GetTasks()
	if err != nil {
		t.Fatal(err)
	}
	for i := range list {
		if list[i].Build != nil {
			list[i].Build.Origin = "stale copy"
			if err := tasks.updateTask(&list[i]); err != nil {
				t.Fatal(err)
			}
			if view := (<-consumer.Chan).(*Task); view.Build.Origin != "" {
				t.Fatal("task saved a copy of build attribution")
			}
		}
	}
}

func TestBuildSnapshotsRemovalsAndRetention(t *testing.T) {
	tasks, _ := newTestServices(t)
	for _, id := range []string{"history", "registered-no-tasks", "orphan", "queue-expired", "end-expired"} {
		if err := tasks.Builds.Upsert(buildInfo(id)); err != nil {
			t.Fatal(err)
		}
	}
	now := time.Now()
	completed := newTaskInfo("history", protocol.TaskStatus_TASK_PASSED)
	completed.BuildId = "history"
	completed.EndedAt = timestamppb.New(now.Add(-30 * time.Minute))
	completed.Log = "https://logs.example/history"
	queued := newTaskInfo("queue-expired", protocol.TaskStatus_TASK_QUEUED)
	queued.BuildId = "queue-expired"
	queued.QueuedAt = timestamppb.New(now.Add(-49 * time.Hour))
	ended := newTaskInfo("end-expired", protocol.TaskStatus_TASK_FAILED)
	ended.BuildId = "end-expired"
	ended.EndedAt = timestamppb.New(now.Add(-2 * time.Hour))
	for _, info := range []*protocol.TaskInfo{completed, queued, ended} {
		if err := tasks.ApplyTaskInfo(info); err != nil {
			t.Fatal(err)
		}
	}
	if err := tasks.ApplyBuildTaskSnapshot([]*protocol.BuildInfo{buildInfo("registered-no-tasks")}, nil); err != nil {
		t.Fatal(err)
	}
	if err := tasks.Builds.GarbageCollect(); err != nil {
		t.Fatal(err)
	}
	stored, err := tasks.GetTask(uuid.MustParse(completed.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Build == nil || stored.Build.Registered || stored.Build.Origin == "" || stored.Status != "Passed" || stored.Log != completed.Log {
		t.Fatalf("snapshot lost history: %+v", stored)
	}
	if err := tasks.Builds.Upsert(buildInfo("history")); err != nil {
		t.Fatal(err)
	}
	consumer := tasks.Broadcast.NewClient()
	defer consumer.Close()
	if err := tasks.Builds.Remove("history"); err != nil {
		t.Fatal(err)
	}
	if event := (<-consumer.Chan).(*Task); event.Build == nil || event.Build.Registered || event.Build.Origin == "" {
		t.Fatalf("removal lost metadata: %+v", event)
	}
	if err := tasks.collectExpiredTasks(now); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"history", "registered-no-tasks"} {
		var build Build
		if err := tasks.Db.db.Where("id = ?", id).Take(&build).Error; err != nil {
			t.Fatalf("retained build %s: %v", id, err)
		}
	}
	for _, id := range []string{"orphan", "queue-expired", "end-expired"} {
		var build Build
		if err := tasks.Db.db.Where("id = ?", id).Take(&build).Error; err != gorm.ErrRecordNotFound {
			t.Fatalf("orphan %s still retained: %v", id, err)
		}
	}
	if err := tasks.DeleteTask(stored); err != nil {
		t.Fatal(err)
	}
	if err := tasks.Builds.GarbageCollect(); err != nil {
		t.Fatal(err)
	}
	var history Build
	if err := tasks.Db.db.Where("id = ?", "history").Take(&history).Error; err != gorm.ErrRecordNotFound {
		t.Fatalf("unreferenced history retained: %v", err)
	}
}

// Pause after SQL/preloading completes, while publication still owns the lock.
func pauseModelOperation(t *testing.T, db *Database, operation, table string) (<-chan struct{}, func()) {
	t.Helper()
	entered := make(chan struct{})
	release := make(chan struct{})
	var pauseOnce, releaseOnce sync.Once
	resume := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(resume)
	processor := db.db.Callback().Query()
	after := "gorm:after_query"
	switch operation {
	case "delete":
		processor = db.db.Callback().Delete()
		after = "gorm:commit_or_rollback_transaction"
	case "update":
		processor = db.db.Callback().Update()
		after = "gorm:commit_or_rollback_transaction"
	}
	if err := processor.After(after).Register("test:pause-model-operation", func(tx *gorm.DB) {
		if tx.Statement.Table == table {
			pauseOnce.Do(func() {
				close(entered)
				<-release
			})
		}
	}); err != nil {
		t.Fatal(err)
	}
	return entered, resume
}

func waitModelOperation(t *testing.T, done <-chan error) {
	t.Helper()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("model operation did not complete")
	}
}

func TestBuildFanoutAndDeletionAreOrdered(t *testing.T) {
	for _, buildEvent := range []string{"upsert", "remove", "snapshot"} {
		for _, deletion := range []string{"API", "retention"} {
			for _, first := range []string{"fanout", "deletion"} {
				t.Run(buildEvent+"/"+deletion+"/"+first+"-first", func(t *testing.T) {
					tasks, _ := newTestServices(t)
					now := time.Now()
					info := newTaskInfo("history", protocol.TaskStatus_TASK_PASSED)
					info.EndedAt = timestamppb.New(now.Add(-2 * time.Hour))
					if err := tasks.Builds.Upsert(buildInfo(info.BuildId)); err != nil {
						t.Fatal(err)
					}
					if err := tasks.ApplyTaskInfo(info); err != nil {
						t.Fatal(err)
					}
					stored, err := tasks.GetTask(uuid.MustParse(info.Instance))
					if err != nil {
						t.Fatal(err)
					}
					consumer := tasks.Broadcast.NewClient()
					defer consumer.Close()
					fanout := func() error {
						if buildEvent == "remove" {
							return tasks.Builds.Remove(info.BuildId)
						}
						if buildEvent == "snapshot" {
							return tasks.ApplyBuildTaskSnapshot([]*protocol.BuildInfo{buildInfo(info.BuildId)}, nil)
						}
						return tasks.Builds.Upsert(buildInfo(info.BuildId))
					}
					deleteTask := func() error {
						if deletion == "retention" {
							return tasks.collectExpiredTasks(now)
						}
						return tasks.DeleteTask(stored)
					}
					operation := "query"
					firstOp, secondOp := fanout, deleteTask
					if first == "deletion" {
						firstOp, secondOp = deleteTask, fanout
						if deletion == "API" {
							operation = "delete"
						}
					}
					entered, resume := pauseModelOperation(t, tasks.Db, operation, "tasks")
					firstDone := make(chan error, 1)
					go func() { firstDone <- firstOp() }()
					select {
					case <-entered:
					case <-time.After(5 * time.Second):
						t.Fatal("first operation did not reach barrier")
					}
					if tasks.Db.taskCoordinator.TryLock() {
						tasks.Db.taskCoordinator.Unlock()
						t.Fatal("mutation/publication boundary is not coordinated")
					}
					secondDone := make(chan error, 1)
					started := make(chan struct{})
					go func() {
						close(started)
						secondDone <- secondOp()
					}()
					<-started
					resume()
					waitModelOperation(t, firstDone)
					waitModelOperation(t, secondDone)
					wantEvents := 1
					if first == "fanout" {
						wantEvents = 2
					}
					if len(consumer.Chan) != wantEvents {
						t.Fatalf("events = %d, want %d", len(consumer.Chan), wantEvents)
					}
					for i := 0; i < wantEvents; i++ {
						view := (<-consumer.Chan).(*Task)
						wantStatus := "Deleted"
						if first == "fanout" && i == 0 {
							wantStatus = "Passed"
							if view.Build == nil || view.Build.Registered != (buildEvent != "remove") {
								t.Fatalf("fanout metadata = %+v", view.Build)
							}
						}
						if view.Instance != stored.Instance || view.Status != wantStatus {
							t.Fatalf("event %d = %+v, want %s", i, view, wantStatus)
						}
					}
					if _, err := tasks.GetTask(stored.Instance); err != gorm.ErrRecordNotFound {
						t.Fatalf("deleted task still exists: %v", err)
					}
					if err := fanout(); err != nil {
						t.Fatal(err)
					}
					if len(consumer.Chan) != 0 {
						t.Fatal("fanout resurrected a deleted task")
					}
				})
			}
		}
	}
}

func TestFullSnapshotPublishesHistoryAndReconciliationOnce(t *testing.T) {
	tasks, _ := newTestServices(t)
	for _, id := range []string{"history", "active"} {
		if err := tasks.Builds.Upsert(buildInfo(id)); err != nil {
			t.Fatal(err)
		}
	}
	history := newTaskInfo("history", protocol.TaskStatus_TASK_PASSED)
	history.BuildId = "history"
	history.EndedAt = timestamppb.Now()
	history.Log = "https://logs.example/history"
	lost := newTaskInfo("lost", protocol.TaskStatus_TASK_RUNNING)
	lost.BuildId = "active"
	reassigned := newTaskInfo("reassigned", protocol.TaskStatus_TASK_RUNNING)
	reassigned.BuildId = "active"
	unrelated := newTaskInfo("unrelated", protocol.TaskStatus_TASK_PASSED)
	unrelated.BuildId = "unknown"
	for _, info := range []*protocol.TaskInfo{history, lost, reassigned, unrelated} {
		if err := tasks.ApplyTaskInfo(info); err != nil {
			t.Fatal(err)
		}
	}
	consumer := tasks.Broadcast.NewClient()
	defer consumer.Close()
	reassigned.BuildId = "new"
	reassigned.Status = protocol.TaskStatus_TASK_QUEUED
	if err := tasks.ApplyBuildTaskSnapshot([]*protocol.BuildInfo{buildInfo("new")}, []*protocol.TaskInfo{reassigned}); err != nil {
		t.Fatal(err)
	}
	if len(consumer.Chan) != 3 {
		t.Fatalf("affected task events = %d, want 3", len(consumer.Chan))
	}
	seen := map[string]bool{}
	for len(consumer.Chan) > 0 {
		view := (<-consumer.Chan).(*Task)
		if seen[view.Name] {
			t.Fatalf("duplicate publication for %s", view.Name)
		}
		seen[view.Name] = true
		stored, err := tasks.GetTask(view.Instance)
		if err != nil || !reflect.DeepEqual(stored, view) {
			t.Fatalf("broadcast differs from final view: %+v / %+v, %v", view, stored, err)
		}
		switch view.Name {
		case "history":
			if view.Status != "Passed" || view.Log != history.Log || view.Build == nil || view.Build.Registered || view.Build.Origin == "" {
				t.Fatalf("history lost on build unregistration: %+v", view)
			}
		case "lost":
			if view.Status != "Cancelled" || view.Ended == "" || view.Build == nil || view.Build.Registered {
				t.Fatalf("lost task published before reconciliation: %+v", view)
			}
		case "reassigned":
			if view.Status != "Queued" || view.BuildID != "new" || view.Build == nil || view.Build.ID != "new" || !view.Build.Registered {
				t.Fatalf("reassigned task has old association: %+v", view)
			}
		default:
			t.Fatalf("unaffected task was published: %+v", view)
		}
	}
}

func TestFullSnapshotCoordinatesRetentionAndReads(t *testing.T) {
	for _, existingTask := range []bool{true, false} {
		t.Run(map[bool]string{true: "requeued", false: "restored"}[existingTask], func(t *testing.T) {
			tasks, _ := newTestServices(t)
			now := time.Now()
			build := buildInfo("build")
			if err := tasks.Builds.Upsert(build); err != nil {
				t.Fatal(err)
			}
			info := newTaskInfo("restored task", protocol.TaskStatus_TASK_PASSED)
			if existingTask {
				info.QueuedAt = timestamppb.New(now.Add(-3 * time.Hour))
				info.EndedAt = timestamppb.New(now.Add(-2 * time.Hour))
				info.Log = "https://logs.example/history"
				if err := tasks.ApplyTaskInfo(info); err != nil {
					t.Fatal(err)
				}
			}
			info.Status = protocol.TaskStatus_TASK_QUEUED
			info.QueuedAt = timestamppb.New(now)
			info.EndedAt = nil
			info.Log = ""
			consumer := tasks.Broadcast.NewClient()
			defer consumer.Close()
			// An older scheduler omits builds. Pause just after unregistration,
			// when retention would previously remove this build's only reference.
			entered, resume := pauseModelOperation(t, tasks.Db, "update", "builds")
			snapshotDone := make(chan error, 1)
			go func() { snapshotDone <- tasks.ApplyBuildTaskSnapshot(nil, []*protocol.TaskInfo{info}) }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("snapshot did not reach build/task barrier")
			}
			if tasks.Db.taskCoordinator.TryLock() {
				tasks.Db.taskCoordinator.Unlock()
				t.Fatal("snapshot phases are not coordinated")
			}
			if len(consumer.Chan) != 0 {
				t.Fatal("snapshot published an intermediate task view")
			}
			retentionDone, readDone := make(chan error, 1), make(chan error, 1)
			retentionStarted, readStarted := make(chan struct{}), make(chan struct{})
			var read []Task
			go func() {
				close(retentionStarted)
				retentionDone <- tasks.collectExpiredTasks(now)
			}()
			go func() {
				close(readStarted)
				var err error
				read, err = tasks.GetTasks()
				readDone <- err
			}()
			<-retentionStarted
			<-readStarted
			resume()
			waitModelOperation(t, snapshotDone)
			waitModelOperation(t, retentionDone)
			waitModelOperation(t, readDone)
			stored, err := tasks.GetTask(uuid.MustParse(info.Instance))
			if err != nil {
				t.Fatal(err)
			}
			if stored.Status != "Queued" || stored.Build == nil || stored.Build.Registered || stored.Build.Origin != build.Parameters[1].Value || stored.Ended != "" {
				t.Fatalf("restored task lost metadata/state: %+v", stored)
			}
			if existingTask && stored.Log != "https://logs.example/history" {
				t.Fatal("requeued task lost historical log")
			}
			if len(read) != 1 || !reflect.DeepEqual(&read[0], stored) {
				t.Fatalf("read observed partial snapshot: %+v", read)
			}
			if len(consumer.Chan) != 1 {
				t.Fatalf("snapshot events = %d, want 1", len(consumer.Chan))
			}
			if view := (<-consumer.Chan).(*Task); !reflect.DeepEqual(view, stored) {
				t.Fatalf("published intermediate state: %+v", view)
			}
		})
	}
}
