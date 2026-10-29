package model

import (
	"errors"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/mattn/go-sqlite3"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
	"gorm.io/gorm"
)

func TestIncrementalFailureRollsBackAndRecoveryPublishesFinalViews(t *testing.T) {
	for _, operation := range []string{"build upsert", "build remove", "task info", "task update"} {
		for _, failure := range []string{"final-tasks", "final-preload", "commit"} {
			for _, recovery := range []string{"retry", "snapshot"} {
				t.Run(operation+"/"+failure+"/"+recovery, func(t *testing.T) {
					tasks, _ := newTestServices(t)
					build := buildInfo("build")
					if err := tasks.Builds.Upsert(build); err != nil {
						t.Fatal(err)
					}
					buildMutation := operation == "build upsert" || operation == "build remove"
					if !buildMutation {
						// An older scheduler's empty snapshot cannot enumerate this build.
						if err := tasks.Builds.Remove(build.Id); err != nil {
							t.Fatal(err)
						}
					}
					history := newTaskInfo("history", protocol.TaskStatus_TASK_PASSED)
					history.EndedAt = timestamppb.Now()
					history.Log = "https://logs.example/history"
					info := newTaskInfo("target", protocol.TaskStatus_TASK_RUNNING)
					if buildMutation {
						info.Status = protocol.TaskStatus_TASK_FAILED
						info.EndedAt = timestamppb.Now()
					}
					for _, task := range []*protocol.TaskInfo{history, info} {
						if err := tasks.ApplyTaskInfo(task); err != nil {
							t.Fatal(err)
						}
					}
					beforeTasks, err := tasks.GetTasks()
					if err != nil {
						t.Fatal(err)
					}
					var beforeBuilds []Build
					if err := tasks.Db.db.Order("id").Find(&beforeBuilds).Error; err != nil {
						t.Fatal(err)
					}
					updated, err := tasks.GetTask(uuid.MustParse(info.Instance))
					if err != nil {
						t.Fatal(err)
					}
					info.Status = protocol.TaskStatus_TASK_PASSED
					info.EndedAt = timestamppb.Now()
					updated.Status, updated.Ended = "Passed", FormatTime(info.EndedAt)
					build.Status, build.Parameters = protocol.BuildStatus_BUILD_COMPLETED, nil
					apply := func() error {
						switch operation {
						case "build upsert":
							return tasks.Builds.Upsert(build)
						case "build remove":
							return tasks.Builds.Remove(build.Id)
						case "task info":
							return tasks.ApplyTaskInfo(info)
						default:
							return tasks.updateTask(updated)
						}
					}
					consumer := tasks.Broadcast.NewClient()
					defer consumer.Close()
					if failure == "commit" {
						if err := tasks.Db.db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
							t.Fatal(err)
						}
						if err := tasks.Db.db.Exec("CREATE TABLE commit_guard (build_id TEXT REFERENCES builds(id) DEFERRABLE INITIALLY DEFERRED)").Error; err != nil {
							t.Fatal(err)
						}
					}
					injected, selectingFinal := false, false
					taskReads := 0
					callback := func(tx *gorm.DB) {
						if injected {
							return
						}
						if tx.Statement.Table == "tasks" {
							taskReads++
							// ApplyTaskInfo first loads the previous task to preserve timestamps/logs.
							selectingFinal = operation != "task info" || taskReads == 2
						}
						match := selectingFinal && tx.Statement.Table == "tasks"
						if failure == "final-preload" {
							match = selectingFinal && tx.Statement.Table == "builds"
						}
						if !match {
							return
						}
						injected = true
						if len(consumer.Chan) != 0 {
							t.Error("incremental mutation published before commit")
						}
						if tasks.Db.taskCoordinator.TryLock() {
							tasks.Db.taskCoordinator.Unlock()
							t.Error("incremental mutation released coordinator before commit")
						}
						if failure == "commit" {
							if err := tx.Exec("INSERT INTO commit_guard VALUES ('missing-build')").Error; err != nil {
								t.Errorf("deferred violation failed before commit: %v", err)
							}
						} else {
							tx.AddError(sqlite3.Error{Code: sqlite3.ErrBusy})
						}
					}
					processor := tasks.Db.db.Callback().Query()
					if failure == "commit" {
						err = processor.After("gorm:after_query").Register("test:fail-incremental", callback)
					} else {
						err = processor.Before("gorm:query").Register("test:fail-incremental", callback)
					}
					if err != nil {
						t.Fatal(err)
					}
					attempts := 1
					if recovery == "snapshot" {
						attempts = 3 // Exhaust retries before a scheduler reconnection.
					}
					for attempt := 0; attempt < attempts; attempt++ {
						injected, selectingFinal, taskReads = false, false, 0
						err = apply()
						var sqliteErr sqlite3.Error
						wantCode := sqlite3.ErrBusy
						if failure == "commit" {
							wantCode = sqlite3.ErrConstraint
						}
						if !injected || !errors.As(err, &sqliteErr) || sqliteErr.Code != wantCode {
							t.Fatalf("fault not returned: injected=%v, error=%v", injected, err)
						}
						if len(consumer.Chan) != 0 {
							t.Fatal("failed incremental mutation published events")
						}
						afterTasks, err := tasks.GetTasks()
						if err != nil || !reflect.DeepEqual(beforeTasks, afterTasks) {
							t.Fatalf("failed mutation changed tasks: before=%+v after=%+v error=%v", beforeTasks, afterTasks, err)
						}
						var afterBuilds []Build
						if err := tasks.Db.db.Order("id").Find(&afterBuilds).Error; err != nil || !reflect.DeepEqual(beforeBuilds, afterBuilds) {
							t.Fatalf("failed mutation changed builds: before=%+v after=%+v error=%v", beforeBuilds, afterBuilds, err)
						}
					}
					if err := processor.Remove("test:fail-incremental"); err != nil {
						t.Fatal(err)
					}
					if recovery == "retry" {
						err = apply()
					} else {
						var builds []*protocol.BuildInfo
						if operation == "build upsert" {
							builds = []*protocol.BuildInfo{build}
						}
						// Terminal history is absent from scheduler snapshots; older schedulers
						// also omit builds. Rolled-back active tasks must still be reconciled.
						err = tasks.ApplyBuildTaskSnapshot(builds, nil)
					}
					if err != nil {
						t.Fatal(err)
					}
					wantEvents := 1
					if buildMutation {
						wantEvents = 2
					}
					if len(consumer.Chan) != wantEvents {
						t.Fatalf("recovery published %d events, want %d", len(consumer.Chan), wantEvents)
					}
					seen := map[uuid.UUID]bool{}
					for len(consumer.Chan) > 0 {
						view := (<-consumer.Chan).(*Task)
						stored, err := tasks.GetTask(view.Instance)
						if err != nil || !reflect.DeepEqual(stored, view) || seen[view.Instance] {
							t.Fatalf("duplicate or non-final recovery view: %+v / %+v, %v", view, stored, err)
						}
						seen[view.Instance] = true
						if buildMutation {
							if view.Build == nil || view.Build.Registered != (operation == "build upsert") {
								t.Fatalf("recovery lost build registration: %+v", view)
							}
							if operation == "build upsert" && (view.Build.Status != build.Status.String() || view.Build.Origin != "") {
								t.Fatalf("recovery lost replacement metadata: %+v", view.Build)
							}
							if operation == "build remove" && view.Build.Origin != beforeBuilds[0].Origin {
								t.Fatal("removal erased retained attribution")
							}
							if view.Name == "history" && (view.Status != "Passed" || view.Log != history.Log) {
								t.Fatalf("recovery changed terminal history: %+v", view)
							}
							if view.Name == "target" && view.Status != "Failed" {
								t.Fatalf("build mutation changed task status: %+v", view)
							}
						} else {
							wantStatus := "Passed"
							if recovery == "snapshot" {
								wantStatus = "Cancelled"
							}
							if view.Instance != updated.Instance || view.Status != wantStatus || view.Ended == "" || view.Build == nil {
								t.Fatalf("recovery lost task reconciliation: %+v", view)
							}
						}
					}
				})
			}
		}
	}
}
