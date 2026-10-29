package scheduler

import (
	"testing"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/model"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newTestDatabase(t *testing.T) *model.Database {
	t.Helper()
	db := model.NewDatabaseFromDsn("file:" + uuid.NewString() + "?mode=memory&cache=shared")
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func TestApplyBuildEvents(t *testing.T) {
	for _, taskFirst := range []bool{true, false} {
		t.Run(map[bool]string{true: "task-first", false: "build-first"}[taskFirst], func(t *testing.T) {
			db := newTestDatabase(t)
			tasks := &model.TaskService{Db: db, Broadcast: model.NewBroadcast()}
			tasks.Builds = model.NewBuildService(db, tasks.Broadcast)
			if err := db.AutoMigrate(&model.Task{}); err != nil {
				t.Fatal(err)
			}
			workers := model.NewWorkerService(db, model.NewBroadcast())
			client := NewClient("", Options{}, tasks, workers)
			consumer := tasks.Broadcast.NewClient()
			defer consumer.Close()
			instance := uuid.New()
			info := &protocol.TaskInfo{Instance: instance.String(), BuildId: "build", Status: protocol.TaskStatus_TASK_RUNNING}
			build := &protocol.BuildInfo{Id: "build", Parameters: []*protocol.Property{{Key: "config.origin", Value: "CI job"}}}
			taskEvent := &protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_Task{Task: info}}
			buildEvent := &protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_Build{Build: build}}
			events := []*protocol.SchedulerEvent{buildEvent, taskEvent}
			if taskFirst {
				events = []*protocol.SchedulerEvent{taskEvent, buildEvent}
			}
			for _, event := range events {
				if err := client.apply(event); err != nil {
					t.Fatal(err)
				}
			}
			view, err := tasks.GetTask(instance)
			if err != nil || view.Build == nil || view.Build.Origin != "CI job" {
				t.Fatalf("incremental build/task events: %+v, %v", view, err)
			}
			for len(consumer.Chan) > 0 {
				<-consumer.Chan
			}
			// A snapshot's build metadata must already be present on its task events.
			build.Parameters[0].Value = "snapshot job"
			snapshotTask := &protocol.TaskInfo{Instance: uuid.New().String(), BuildId: "build"}
			if err := client.apply(&protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_Snapshot{Snapshot: &protocol.Snapshot{
				Tasks: []*protocol.TaskInfo{info, snapshotTask}, Builds: []*protocol.BuildInfo{build},
			}}}); err != nil {
				t.Fatal(err)
			}
			seen := map[string]int{}
			for len(consumer.Chan) > 0 {
				view := (<-consumer.Chan).(*model.Task)
				if view.Build == nil || view.Build.Origin != "snapshot job" {
					t.Fatalf("snapshot broadcast before build upsert: %+v", view)
				}
				seen[view.Instance.String()]++
			}
			if len(seen) != 2 || seen[info.Instance] != 1 || seen[snapshotTask.Instance] != 1 {
				t.Fatalf("snapshot must publish each task exactly once: %v", seen)
			}
			info.Status = protocol.TaskStatus_TASK_PASSED
			info.EndedAt = timestamppb.Now()
			if err := client.apply(taskEvent); err != nil {
				t.Fatal(err)
			}
			build.Status = protocol.BuildStatus_BUILD_COMPLETED
			if err := client.apply(buildEvent); err != nil {
				t.Fatal(err)
			}
			if err := client.apply(&protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_BuildRemoved{BuildRemoved: &protocol.BuildRemoved{Id: "build"}}}); err != nil {
				t.Fatal(err)
			}
			// Older schedulers send no build fields. Completed history must survive.
			unknown := &protocol.TaskInfo{Instance: uuid.New().String(), BuildId: "unknown"}
			if err := client.apply(&protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_Snapshot{Snapshot: &protocol.Snapshot{Tasks: []*protocol.TaskInfo{unknown}}}}); err != nil {
				t.Fatal(err)
			}
			view, err = tasks.GetTask(instance)
			if err != nil || view.Status != "Passed" || view.Build == nil || view.Build.Registered || view.Build.Status != "BUILD_COMPLETED" || view.Build.Origin != "snapshot job" {
				t.Fatalf("completed history lost after reconnect: %+v, %v", view, err)
			}
			view, err = tasks.GetTask(uuid.MustParse(unknown.Instance))
			if err != nil || view.BuildID != "unknown" || view.Build != nil {
				t.Fatalf("older scheduler task: %+v, %v", view, err)
			}
		})
	}
}

func TestSnapshotPublishesSixFinalTaskViews(t *testing.T) {
	db := newTestDatabase(t)
	tasks := &model.TaskService{Db: db, Broadcast: model.NewBroadcast()}
	tasks.Builds = model.NewBuildService(db, tasks.Broadcast)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	client := NewClient("", Options{}, tasks, model.NewWorkerService(db, model.NewBroadcast()))
	build := &protocol.BuildInfo{Id: "build"}
	if err := tasks.Builds.Upsert(build); err != nil {
		t.Fatal(err)
	}
	snapshot := &protocol.Snapshot{Builds: []*protocol.BuildInfo{build, build}}
	for i := 0; i < 6; i++ {
		info := &protocol.TaskInfo{Instance: uuid.New().String(), BuildId: "build", Status: protocol.TaskStatus_TASK_RUNNING, QueuedAt: timestamppb.Now()}
		if err := tasks.ApplyTaskInfo(info); err != nil {
			t.Fatal(err)
		}
		info.Status = protocol.TaskStatus_TASK_QUEUED
		snapshot.Tasks = append(snapshot.Tasks, info)
	}
	// Duplicate input must not duplicate publication either.
	snapshot.Tasks = append(snapshot.Tasks, snapshot.Tasks[0])
	build.Parameters = []*protocol.Property{{Key: "config.origin", Value: "final snapshot job"}}
	consumer := tasks.Broadcast.NewClient()
	defer consumer.Close()
	// Keep the ten-slot consumer undrained until the entire snapshot is applied.
	if err := client.apply(&protocol.SchedulerEvent{Event: &protocol.SchedulerEvent_Snapshot{Snapshot: snapshot}}); err != nil {
		t.Fatal(err)
	}
	if len(consumer.Chan) != 6 {
		t.Fatalf("snapshot events = %d, want 6", len(consumer.Chan))
	}
	seen := map[uuid.UUID]bool{}
	for len(consumer.Chan) > 0 {
		view := (<-consumer.Chan).(*model.Task)
		if seen[view.Instance] || view.Status != "Queued" || view.Build == nil || view.Build.Origin != "final snapshot job" {
			t.Fatalf("duplicate or intermediate snapshot view: %+v", view)
		}
		seen[view.Instance] = true
	}
	stored, err := tasks.GetTasks()
	if err != nil || len(stored) != 6 {
		t.Fatalf("stored tasks = %d, error %v", len(stored), err)
	}
	for _, view := range stored {
		if !seen[view.Instance] || view.Status != "Queued" {
			t.Fatalf("final state missing from publication: %+v", view)
		}
	}
}
