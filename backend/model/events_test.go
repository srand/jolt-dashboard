package model

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"gorm.io/gorm"
)

func TestEventSubscriptionsMatchCurrentViews(t *testing.T) {
	tasks, workers := newTestServices(t)
	for _, populated := range []bool{false, true} {
		if populated {
			if err := tasks.Builds.Upsert(buildInfo("build")); err != nil {
				t.Fatal(err)
			}
			if err := tasks.ApplyTaskInfo(newTaskInfo("task", protocol.TaskStatus_TASK_RUNNING)); err != nil {
				t.Fatal(err)
			}
			if err := workers.Upsert(&protocol.WorkerInfo{Id: "worker", Hostname: "host"}); err != nil {
				t.Fatal(err)
			}
		}
		for _, stream := range []string{"tasks", "workers"} {
			var subscription *EventSubscription
			var current interface{}
			var err error
			if stream == "tasks" {
				subscription, err = tasks.Subscribe()
				if err == nil {
					current, err = tasks.GetTasks()
				}
			} else {
				subscription, err = workers.Subscribe()
				if err == nil {
					current, err = workers.GetWorkers()
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(subscription.Snapshot, current) {
				t.Fatalf("%s snapshot differs from current views: %+v / %+v", stream, subscription.Snapshot, current)
			}
			data, err := json.Marshal(subscription.Snapshot)
			if err != nil || (!populated && string(data) != "[]") {
				t.Fatalf("%s empty snapshot = %s, error=%v, want []", stream, data, err)
			}
			select {
			case event := <-subscription.Chan:
				t.Fatalf("snapshot should not consume queue capacity: %+v", event)
			default:
			}
			subscription.Close()
			subscription.Close()
		}
	}
}

func TestEventSubscriptionAtomicBoundary(t *testing.T) {
	for _, mutation := range []string{"task update", "task delete", "task snapshot", "build update", "build remove", "build snapshot", "full snapshot", "worker update", "worker remove", "worker snapshot"} {
		t.Run(mutation, func(t *testing.T) {
			tasks, workers := newTestServices(t)
			info := newTaskInfo("before", protocol.TaskStatus_TASK_RUNNING)
			if err := tasks.Builds.Upsert(buildInfo("build")); err != nil {
				t.Fatal(err)
			}
			if err := tasks.ApplyTaskInfo(info); err != nil {
				t.Fatal(err)
			}
			wantTasks := 1
			if strings.HasPrefix(mutation, "build") || mutation == "full snapshot" {
				if err := tasks.ApplyTaskInfo(newTaskInfo("before", protocol.TaskStatus_TASK_RUNNING)); err != nil {
					t.Fatal(err)
				}
				wantTasks = 2
			}
			worker := &protocol.WorkerInfo{Id: "worker", Hostname: "before"}
			if err := workers.Upsert(worker); err != nil {
				t.Fatal(err)
			}
			// Use a second service to ensure the lock is shared by the database,
			// not just by the subscribing service instance.
			otherTasks := &TaskService{Db: tasks.Db, Broadcast: tasks.Broadcast, Builds: tasks.Builds}
			otherWorkers := &WorkerService{Db: workers.Db, Broadcast: workers.Broadcast}
			broadcast := tasks.Broadcast
			coordinator := &tasks.Db.taskCoordinator
			table := "tasks"
			subscribe := tasks.Subscribe
			if strings.HasPrefix(mutation, "worker") {
				broadcast, coordinator, table, subscribe = workers.Broadcast, &workers.Db.workerCoordinator, "workers", workers.Subscribe
			}
			entered, release := make(chan struct{}), make(chan struct{})
			var releaseOnce, queryOnce sync.Once
			t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
			if err := tasks.Db.db.Callback().Query().Before("gorm:query").Register("test:subscription-boundary", func(tx *gorm.DB) {
				if tx.Statement.Table != table {
					return
				}
				queryOnce.Do(func() {
					if coordinator.TryLock() {
						coordinator.Unlock()
						t.Error("snapshot query did not hold mutation/publication coordinator")
					}
					broadcast.lock.Lock()
					count := len(broadcast.clients)
					broadcast.lock.Unlock()
					if count != 1 {
						t.Errorf("clients at snapshot query = %d, want registered subscription", count)
					}
					close(entered)
					<-release
				})
			}); err != nil {
				t.Fatal(err)
			}
			subscriptions := make(chan *EventSubscription, 1)
			errors := make(chan error, 2)
			go func() {
				subscription, err := subscribe()
				errors <- err
				subscriptions <- subscription
			}()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("snapshot query did not start")
			}
			started := make(chan struct{})
			go func() {
				close(started)
				var err error
				info.Name, worker.Hostname = "after", "after"
				switch mutation {
				case "task update":
					err = otherTasks.ApplyTaskInfo(info)
				case "task delete":
					err = otherTasks.DeleteTask(&Task{Instance: uuid.MustParse(info.Instance)})
				case "task snapshot":
					err = otherTasks.ApplySnapshot(nil)
				case "build update":
					build := buildInfo("build")
					build.Status = protocol.BuildStatus_BUILD_COMPLETED
					err = tasks.Builds.Upsert(build)
				case "build remove":
					err = tasks.Builds.Remove("build")
				case "build snapshot":
					err = tasks.Builds.ApplySnapshot(nil)
				case "full snapshot":
					err = otherTasks.ApplyBuildTaskSnapshot(nil, nil)
				case "worker update":
					err = otherWorkers.Upsert(worker)
				case "worker remove":
					err = otherWorkers.Remove(worker.Id)
				case "worker snapshot":
					err = otherWorkers.ApplySnapshot(nil)
				}
				errors <- err
			}()
			<-started
			releaseOnce.Do(func() { close(release) })
			for i := 0; i < 2; i++ {
				select {
				case err := <-errors:
					if err != nil {
						t.Fatal(err)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("subscription or mutation stalled")
				}
			}
			subscription := <-subscriptions
			defer subscription.Close()
			if table == "tasks" {
				views := subscription.Snapshot.([]Task)
				if len(views) != wantTasks {
					t.Fatalf("snapshot was not detached at boundary: %+v", views)
				}
				for _, view := range views {
					if view.Name != "before" || view.Status != "Running" || view.Build == nil || !view.Build.Registered || view.Build.Status != "BUILD_ACCEPTED" {
						t.Fatalf("snapshot was not detached at boundary: %+v", view)
					}
				}
			} else {
				views := subscription.Snapshot.([]Worker)
				if len(views) != 1 || views[0].Hostname != "before" {
					t.Fatalf("snapshot was not detached at boundary: %+v", views)
				}
			}
			seen := map[uuid.UUID]bool{}
			for i := 0; i < wantTasks; i++ {
				select {
				case event := <-subscription.Chan:
					if table == "tasks" {
						view := event.(*Task)
						if seen[view.Instance] {
							t.Fatalf("duplicate build fanout event: %+v", view)
						}
						seen[view.Instance] = true
						if mutation == "task delete" {
							if view.Status != "Deleted" {
								t.Fatalf("delete event = %+v", view)
							}
						} else {
							current, err := tasks.GetTask(view.Instance)
							if err != nil || !reflect.DeepEqual(current, view) {
								t.Fatalf("update differs from committed view: %+v / %+v, %v", current, view, err)
							}
						}
					} else {
						view := event.(*Worker)
						if (mutation == "worker update" && view.Hostname != "after") || (mutation != "worker update" && view.TaskStatus != "Deleted") {
							t.Fatalf("worker event = %+v", view)
						}
					}
				case <-time.After(5 * time.Second):
					t.Fatal("mutation was lost across snapshot/subscription boundary")
				}
			}
			select {
			case event := <-subscription.Chan:
				t.Fatalf("duplicate event at boundary: %+v", event)
			default:
			}
		})
	}
}

func TestEventSubscriptionQueryFailureCleansClient(t *testing.T) {
	for _, failure := range []string{"tasks", "builds", "workers"} {
		t.Run(failure, func(t *testing.T) {
			tasks, workers := newTestServices(t)
			if err := tasks.Builds.Upsert(buildInfo("build")); err != nil {
				t.Fatal(err)
			}
			if err := tasks.ApplyTaskInfo(newTaskInfo("task", protocol.TaskStatus_TASK_QUEUED)); err != nil {
				t.Fatal(err)
			}
			injected := errors.New("snapshot query failed")
			if err := tasks.Db.db.Callback().Query().Before("gorm:query").Register("test:subscription-failure", func(tx *gorm.DB) {
				if tx.Statement.Table == failure {
					tx.AddError(injected)
				}
			}); err != nil {
				t.Fatal(err)
			}
			subscribe, broadcast := tasks.Subscribe, tasks.Broadcast
			if failure == "workers" {
				subscribe, broadcast = workers.Subscribe, workers.Broadcast
			}
			subscription, err := subscribe()
			if subscription != nil || !errors.Is(err, injected) {
				t.Fatalf("subscription=%+v error=%v, want nil and query error", subscription, err)
			}
			broadcast.lock.Lock()
			count := len(broadcast.clients)
			broadcast.lock.Unlock()
			if count != 0 {
				t.Fatalf("failed subscription leaked %d clients", count)
			}
		})
	}
}

func TestWorkerSQLFailureDoesNotPublish(t *testing.T) {
	for _, operation := range []string{"upsert", "create", "remove", "snapshot", "snapshot query", "snapshot commit"} {
		t.Run(operation, func(t *testing.T) {
			_, workers := newTestServices(t)
			if err := workers.Upsert(&protocol.WorkerInfo{Id: "worker", Hostname: "before"}); err != nil {
				t.Fatal(err)
			}
			before, err := workers.GetWorkers()
			if err != nil {
				t.Fatal(err)
			}
			consumer := workers.Broadcast.NewClient()
			defer consumer.Close()
			injected := errors.New("worker mutation failed")
			fail := func(tx *gorm.DB) { tx.AddError(injected) }
			if operation == "upsert" {
				err = workers.Db.db.Callback().Update().Before("gorm:update").Register("test:worker-failure", fail)
			} else if operation == "create" {
				err = workers.Db.db.Callback().Create().Before("gorm:create").Register("test:worker-failure", fail)
			} else if operation == "snapshot query" {
				err = workers.Db.db.Callback().Query().Before("gorm:query").Register("test:worker-failure", fail)
			} else if operation == "snapshot commit" {
				if err := workers.Db.db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
					t.Fatal(err)
				}
				if err := workers.Db.db.Exec("CREATE TABLE worker_commit_guard (worker_id TEXT REFERENCES workers(id) DEFERRABLE INITIALLY DEFERRED)").Error; err != nil {
					t.Fatal(err)
				}
				err = workers.Db.db.Callback().Query().After("gorm:after_query").Register("test:worker-failure", func(tx *gorm.DB) {
					if err := tx.Exec("INSERT INTO worker_commit_guard VALUES ('missing-worker')").Error; err != nil {
						t.Errorf("deferred violation failed before commit: %v", err)
					}
				})
			} else {
				err = workers.Db.db.Callback().Delete().Before("gorm:delete").Register("test:worker-failure", fail)
			}
			if err != nil {
				t.Fatal(err)
			}
			switch operation {
			case "upsert":
				err = workers.Upsert(&protocol.WorkerInfo{Id: "worker", Hostname: "after"})
			case "create":
				err = workers.Upsert(&protocol.WorkerInfo{Id: "new-worker"})
			case "remove":
				err = workers.Remove("worker")
			default:
				err = workers.ApplySnapshot([]*protocol.WorkerInfo{{Id: "new-worker"}})
			}
			if err == nil || (operation != "snapshot commit" && !errors.Is(err, injected)) {
				t.Fatalf("error = %v, want injected SQL failure", err)
			}
			if len(consumer.Chan) != 0 {
				t.Fatal("failed mutation broadcast bogus events")
			}
			if operation == "snapshot query" || operation == "snapshot commit" {
				if err := workers.Db.db.Callback().Query().Remove("test:worker-failure"); err != nil {
					t.Fatal(err)
				}
			}
			after, err := workers.GetWorkers()
			if err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("failed mutation changed rows: %+v / %+v, %v", before, after, err)
			}
		})
	}
}

func TestGetWorkersHoldsSharedCoordinator(t *testing.T) {
	_, workers := newTestServices(t)
	queried := false
	if err := workers.Db.db.Callback().Query().Before("gorm:query").Register("test:worker-read-lock", func(tx *gorm.DB) {
		queried = true
		if workers.Db.workerCoordinator.TryLock() {
			workers.Db.workerCoordinator.Unlock()
			t.Error("GetWorkers query did not hold worker coordinator")
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := workers.GetWorkers(); err != nil || !queried {
		t.Fatalf("queried=%v error=%v", queried, err)
	}
}

func TestEventMutationsHoldCoordinatorThroughSQL(t *testing.T) {
	for _, mutation := range []string{"task update", "task delete", "task snapshot", "build update", "build remove", "build snapshot", "full snapshot", "worker update", "worker remove", "worker snapshot"} {
		t.Run(mutation, func(t *testing.T) {
			tasks, workers := newTestServices(t)
			info := newTaskInfo("task", protocol.TaskStatus_TASK_RUNNING)
			if err := tasks.Builds.Upsert(buildInfo("build")); err != nil {
				t.Fatal(err)
			}
			if err := tasks.ApplyTaskInfo(info); err != nil {
				t.Fatal(err)
			}
			if err := workers.Upsert(&protocol.WorkerInfo{Id: "worker"}); err != nil {
				t.Fatal(err)
			}
			coordinator := &tasks.Db.taskCoordinator
			if strings.HasPrefix(mutation, "worker") {
				coordinator = &workers.Db.workerCoordinator
			}
			operations := 0
			assertLocked := func(tx *gorm.DB) {
				operations++
				if coordinator.TryLock() {
					coordinator.Unlock()
					t.Error("mutation SQL escaped the subscription coordinator")
				}
			}
			for _, err := range []error{
				tasks.Db.db.Callback().Query().Before("gorm:query").Register("test:mutation-lock", assertLocked),
				tasks.Db.db.Callback().Create().Before("gorm:create").Register("test:mutation-lock", assertLocked),
				tasks.Db.db.Callback().Update().Before("gorm:update").Register("test:mutation-lock", assertLocked),
				tasks.Db.db.Callback().Delete().Before("gorm:delete").Register("test:mutation-lock", assertLocked),
			} {
				if err != nil {
					t.Fatal(err)
				}
			}
			var err error
			switch mutation {
			case "task update":
				err = tasks.ApplyTaskInfo(info)
			case "task delete":
				err = tasks.DeleteTask(&Task{Instance: uuid.MustParse(info.Instance)})
			case "task snapshot":
				err = tasks.ApplySnapshot(nil)
			case "build update":
				err = tasks.Builds.Upsert(buildInfo("build"))
			case "build remove":
				err = tasks.Builds.Remove("build")
			case "build snapshot":
				err = tasks.Builds.ApplySnapshot(nil)
			case "full snapshot":
				err = tasks.ApplyBuildTaskSnapshot(nil, nil)
			case "worker update":
				err = workers.Upsert(&protocol.WorkerInfo{Id: "worker", Hostname: "after"})
			case "worker remove":
				err = workers.Remove("worker")
			case "worker snapshot":
				err = workers.ApplySnapshot(nil)
			}
			if err != nil || operations == 0 {
				t.Fatalf("operations=%d error=%v", operations, err)
			}
		})
	}
}

func TestEventSubscriptionOverflowAndClose(t *testing.T) {
	for _, stream := range []string{"tasks", "workers"} {
		t.Run(stream, func(t *testing.T) {
			tasks, workers := newTestServices(t)
			subscribe, broadcast := tasks.Subscribe, tasks.Broadcast
			if stream == "workers" {
				subscribe, broadcast = workers.Subscribe, workers.Broadcast
			}
			subscription, err := subscribe()
			if err != nil {
				t.Fatal(err)
			}
			defer subscription.Close()
			for i := 0; i < 10; i++ {
				broadcast.Send(i)
			}
			select {
			case <-subscription.Overflow():
				t.Fatal("snapshot consumed incremental queue capacity")
			default:
			}
			broadcast.Send(10)
			select {
			case <-subscription.Overflow():
			default:
				t.Fatal("eleventh queued event did not overflow subscription")
			}
			subscription.Close()
			subscription.Close()
			for i := 0; i < 10; i++ {
				if event := <-subscription.Chan; event != i {
					t.Fatalf("queued event=%v, want %d", event, i)
				}
			}
			broadcast.Send("after close")
			select {
			case event := <-subscription.Chan:
				t.Fatalf("closed subscription received %+v", event)
			default:
			}
		})
	}
}
