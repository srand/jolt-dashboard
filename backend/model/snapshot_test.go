package model

import (
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/mattn/go-sqlite3"
	"github.com/srand/jolt-dashboard/protocol"
	"gorm.io/gorm"
)

func TestSnapshotFailureRollsBackAndRetryPublishesAllViews(t *testing.T) {
	for _, snapshot := range []string{"full", "tasks", "builds"} {
		for _, failure := range []string{"reconciliation", "previous-task", "final-tasks", "final-preload", "commit"} {
			if snapshot == "builds" && failure == "previous-task" {
				continue
			}
			t.Run(snapshot+"/"+failure, func(t *testing.T) {
				tasks, _ := newTestServices(t)
				for _, id := range []string{"history", "active"} {
					if err := tasks.Builds.Upsert(buildInfo(id)); err != nil {
						t.Fatal(err)
					}
				}
				history := newTaskInfo("history", protocol.TaskStatus_TASK_PASSED)
				history.BuildId = "history"
				history.Log = "https://logs.example/history"
				lost := newTaskInfo("lost", protocol.TaskStatus_TASK_RUNNING)
				survivor := newTaskInfo("survivor", protocol.TaskStatus_TASK_RUNNING)
				lost.BuildId, survivor.BuildId = "active", "active"
				for _, info := range []*protocol.TaskInfo{history, lost, survivor} {
					if err := tasks.ApplyTaskInfo(info); err != nil {
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
				consumer := tasks.Broadcast.NewClient()
				defer consumer.Close()
				survivor.Status = protocol.TaskStatus_TASK_QUEUED
				survivor.BuildId = "new"
				apply := func() error {
					switch snapshot {
					case "tasks":
						return tasks.ApplySnapshot([]*protocol.TaskInfo{survivor})
					case "builds":
						return tasks.Builds.ApplySnapshot([]*protocol.BuildInfo{buildInfo("new")})
					default:
						return tasks.ApplyBuildTaskSnapshot([]*protocol.BuildInfo{buildInfo("new")}, []*protocol.TaskInfo{survivor})
					}
				}
				// A deferred FK violation exercises a real COMMIT failure after all
				// mutation and selection queries succeed, without a second connection.
				if failure == "commit" {
					if err := tasks.Db.db.Exec("PRAGMA foreign_keys = ON").Error; err != nil {
						t.Fatal(err)
					}
					if err := tasks.Db.db.Exec(`CREATE TABLE commit_guard (
						build_id TEXT REFERENCES builds(id) DEFERRABLE INITIALLY DEFERRED
					)`).Error; err != nil {
						t.Fatal(err)
					}
				}
				injected, selectingFinal := false, false
				callback := func(tx *gorm.DB) {
					if injected {
						return
					}
					where := fmt.Sprint(tx.Statement.Clauses["WHERE"].Expression)
					finalTasks := tx.Statement.Table == "tasks" && strings.Contains(where, "instance IN ? OR build_id IN ?")
					if finalTasks {
						selectingFinal = true
					}
					match := false
					switch failure {
					case "reconciliation":
						match = tx.Statement.Table == "tasks" && strings.Contains(where, "status in ?")
						if snapshot == "builds" {
							match = tx.Statement.Table == "builds" && strings.Contains(where, "registered = ?")
						}
					case "previous-task":
						_, match = tx.Statement.Dest.(*Task)
					case "final-tasks", "commit":
						match = finalTasks
					case "final-preload":
						match = selectingFinal && tx.Statement.Table == "builds"
					}
					if !match {
						return
					}
					injected = true
					if len(consumer.Chan) != 0 {
						t.Error("snapshot published before commit")
					}
					if tasks.Db.taskCoordinator.TryLock() {
						tasks.Db.taskCoordinator.Unlock()
						t.Error("snapshot released coordinator before commit")
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
					err = processor.After("gorm:after_query").Register("test:fail-snapshot-once", callback)
				} else {
					err = processor.Before("gorm:query").Register("test:fail-snapshot-once", callback)
				}
				if err != nil {
					t.Fatal(err)
				}
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
					t.Fatal("failed snapshot published events")
				}
				afterTasks, err := tasks.GetTasks()
				if err != nil || !reflect.DeepEqual(beforeTasks, afterTasks) {
					t.Fatalf("failed snapshot changed tasks: before=%+v after=%+v error=%v", beforeTasks, afterTasks, err)
				}
				var afterBuilds []Build
				if err := tasks.Db.db.Order("id").Find(&afterBuilds).Error; err != nil || !reflect.DeepEqual(beforeBuilds, afterBuilds) {
					t.Fatalf("failed snapshot changed builds: before=%+v after=%+v error=%v", beforeBuilds, afterBuilds, err)
				}
				if err := apply(); err != nil {
					t.Fatal(err)
				}
				wantEvents := 3
				if snapshot == "tasks" {
					wantEvents = 2
				}
				if len(consumer.Chan) != wantEvents {
					t.Fatalf("retry published %d events, want %d", len(consumer.Chan), wantEvents)
				}
				seen := map[uuid.UUID]bool{}
				for len(consumer.Chan) > 0 {
					view := (<-consumer.Chan).(*Task)
					if seen[view.Instance] {
						t.Fatalf("duplicate retry event: %+v", view)
					}
					seen[view.Instance] = true
					stored, err := tasks.GetTask(view.Instance)
					if err != nil || !reflect.DeepEqual(stored, view) {
						t.Fatalf("retry event differs from committed view: %+v / %+v, %v", view, stored, err)
					}
					if view.Name == "history" && (view.Status != "Passed" || view.Log != history.Log || view.Build == nil || view.Build.Registered) {
						t.Fatalf("retry lost retained history: %+v", view)
					}
					if view.Name == "lost" && snapshot != "builds" && (view.Status != "Cancelled" || view.Ended == "") {
						t.Fatalf("retry lost cancellation: %+v", view)
					}
				}
				if !seen[uuid.MustParse(lost.Instance)] || !seen[uuid.MustParse(survivor.Instance)] || (snapshot != "tasks" && !seen[uuid.MustParse(history.Instance)]) {
					t.Fatalf("retry lost affected rows: %v", seen)
				}
			})
		}
	}
}
