package model

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newTestDatabase(t *testing.T) *Database {
	t.Helper()
	db := NewDatabaseFromDsn("file:" + uuid.NewString() + "?mode=memory&cache=shared")
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Error(err)
		}
	})
	return db
}

func newTestServices(t *testing.T) (*TaskService, *WorkerService) {
	t.Helper()

	db := newTestDatabase(t)
	tasks := &TaskService{Db: db, Broadcast: NewBroadcast()}
	tasks.Builds = NewBuildService(db, tasks.Broadcast)
	if err := db.AutoMigrate(&Task{}); err != nil {
		t.Fatal(err)
	}

	return tasks, NewWorkerService(db, NewBroadcast())
}

func newTaskInfo(name string, status protocol.TaskStatus) *protocol.TaskInfo {
	instance, _ := uuid.NewRandom()
	return &protocol.TaskInfo{
		BuildId:  "build",
		Identity: "identity-" + name,
		Instance: instance.String(),
		Name:     name,
		Status:   status,
		QueuedAt: timestamppb.New(time.Now()),
	}
}

func TestTaskBuildAssociationMigratesExistingRows(t *testing.T) {
	db := newTestDatabase(t)
	// Existing task history must remain readable without inferred attribution.
	if err := db.db.Exec(`CREATE TABLE tasks (
		instance text PRIMARY KEY, name text, identity text, routing_key text,
		worker text, status text, queued text, assigned text, started text,
		ended text, log text
	)`).Error; err != nil {
		t.Fatal(err)
	}
	instance := uuid.New()
	if err := db.db.Exec("INSERT INTO tasks (instance, name, status, log) VALUES (?, ?, ?, ?)", instance, "existing task", "Passed", "https://logs.example/task").Error; err != nil {
		t.Fatal(err)
	}
	tasks := &TaskService{Db: db, Broadcast: NewBroadcast()}
	tasks.Builds = NewBuildService(db, tasks.Broadcast)
	if err := db.db.AutoMigrate(&Task{}); err != nil {
		t.Fatal(err)
	}
	stored, err := tasks.GetTask(instance)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Name != "existing task" || stored.BuildID != "" || stored.Build != nil || stored.Status != "Passed" || stored.Log != "https://logs.example/task" {
		t.Fatalf("migrated task = %+v, want unchanged history with no build", stored)
	}
	var emptyRows int64
	if err := db.db.Model(&Task{}).Where("build_id = ''").Count(&emptyRows).Error; err != nil {
		t.Fatal(err)
	}
	if emptyRows != 1 {
		t.Errorf("rows with empty build ID = %d, want 1 (not NULL)", emptyRows)
	}
	if db.db.Migrator().HasColumn(&Task{}, "provenance") || !db.db.Migrator().HasIndex(&Task{}, "BuildID") {
		t.Fatal("expected indexed build ID and no task-level provenance column")
	}
}

func TestApplyTaskInfoRecordsSchedulerTimestamps(t *testing.T) {
	tasks, _ := newTestServices(t)

	queued := time.Now().Add(-time.Hour)
	assigned := time.Now().Add(-time.Minute * 30)
	started := time.Now().Add(-time.Minute)

	info := newTaskInfo("build/lib", protocol.TaskStatus_TASK_RUNNING)
	info.QueuedAt = timestamppb.New(queued)
	info.AssignedAt = timestamppb.New(assigned)
	info.StartedAt = timestamppb.New(started)
	info.WorkerHostname = "builder1"
	info.Labels = []string{"fast", "linux"}

	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}

	stored, err := tasks.GetTask(uuid.MustParse(info.Instance))
	if err != nil {
		t.Fatal(err)
	}

	if stored.Status != "Running" {
		t.Errorf("status = %q, want Running", stored.Status)
	}
	if stored.Worker != "builder1" {
		t.Errorf("worker = %q, want builder1", stored.Worker)
	}
	if stored.RoutingKey != "fast,linux" {
		t.Errorf("routing key = %q, want fast,linux", stored.RoutingKey)
	}
	if want := queued.Local().Format(timeFormat); stored.Queued != want {
		t.Errorf("queued = %q, want %q", stored.Queued, want)
	}
	if want := assigned.Local().Format(timeFormat); stored.Assigned != want {
		t.Errorf("assigned = %q, want %q", stored.Assigned, want)
	}
	if want := started.Local().Format(timeFormat); stored.Started != want {
		t.Errorf("started = %q, want %q", stored.Started, want)
	}
	if stored.Ended != "" {
		t.Errorf("ended = %q, want empty", stored.Ended)
	}
}

func TestApplyTaskInfoPreservesAssignedTimestamp(t *testing.T) {
	tasks, _ := newTestServices(t)
	info := newTaskInfo("build/lib", protocol.TaskStatus_TASK_QUEUED)

	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}

	info.Status = protocol.TaskStatus_TASK_ASSIGNED
	assignedAt := time.Now().Add(-time.Minute * 30)
	info.AssignedAt = timestamppb.New(assignedAt)
	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}

	assigned, err := tasks.GetTask(uuid.MustParse(info.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if want := assignedAt.Local().Format(timeFormat); assigned.Assigned != want {
		t.Fatalf("assigned = %q, want %q", assigned.Assigned, want)
	}

	info.Status = protocol.TaskStatus_TASK_RUNNING
	info.StartedAt = timestamppb.Now()
	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}

	running, err := tasks.GetTask(uuid.MustParse(info.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if running.Assigned != assigned.Assigned {
		t.Errorf("assigned timestamp changed from %q to %q", assigned.Assigned, running.Assigned)
	}
}

func TestApplyTaskInfoPreservesLogThroughQueueAndCancellation(t *testing.T) {
	tasks, _ := newTestServices(t)
	info := newTaskInfo("build/lib", protocol.TaskStatus_TASK_RUNNING)
	info.Log = "https://logs.example/task"
	if err := tasks.Builds.Upsert(buildInfo(info.BuildId)); err != nil {
		t.Fatal(err)
	}
	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}
	info.Log = ""
	for _, status := range []protocol.TaskStatus{protocol.TaskStatus_TASK_QUEUED, protocol.TaskStatus_TASK_CANCELLED} {
		info.Status = status
		if err := tasks.ApplyTaskInfo(info); err != nil {
			t.Fatal(err)
		}
		view, err := tasks.GetTask(uuid.MustParse(info.Instance))
		if err != nil {
			t.Fatal(err)
		}
		if view.Log != "https://logs.example/task" || view.Build == nil || view.BuildID != info.BuildId {
			t.Fatalf("log or association lost on %v: %+v", status, view)
		}
	}
}

// A task the dashboard still believes is in progress but that the scheduler no
// longer knows about was lost while disconnected and must not linger forever.
func TestApplySnapshotTerminatesLostTasks(t *testing.T) {
	tasks, _ := newTestServices(t)

	lostQueued := newTaskInfo("lost/queued", protocol.TaskStatus_TASK_QUEUED)
	lostAssigned := newTaskInfo("lost/assigned", protocol.TaskStatus_TASK_ASSIGNED)
	lostRunning := newTaskInfo("lost/running", protocol.TaskStatus_TASK_RUNNING)
	completed := newTaskInfo("done", protocol.TaskStatus_TASK_PASSED)
	survivor := newTaskInfo("survivor", protocol.TaskStatus_TASK_QUEUED)

	for _, info := range []*protocol.TaskInfo{lostQueued, lostAssigned, lostRunning, completed, survivor} {
		if err := tasks.ApplyTaskInfo(info); err != nil {
			t.Fatal(err)
		}
	}

	consumer := tasks.Broadcast.NewClient()
	defer consumer.Close()

	if err := tasks.ApplySnapshot([]*protocol.TaskInfo{survivor}); err != nil {
		t.Fatal(err)
	}

	for _, info := range []*protocol.TaskInfo{lostQueued, lostAssigned, lostRunning} {
		stored, err := tasks.GetTask(uuid.MustParse(info.Instance))
		if err != nil {
			t.Fatal(err)
		}
		if stored.Status != "Cancelled" {
			t.Errorf("%s status = %q, want Cancelled", info.Name, stored.Status)
		}
		if stored.Ended == "" {
			t.Errorf("%s has no end time", info.Name)
		}
		if stored.BuildID != info.BuildId {
			t.Errorf("%s lost build ID during reconciliation", info.Name)
		}
	}

	stored, err := tasks.GetTask(uuid.MustParse(completed.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "Passed" {
		t.Errorf("completed task was rewritten to %q", stored.Status)
	}
	if stored.BuildID != completed.BuildId {
		t.Error("completed task lost build ID during reconciliation")
	}

	stored, err = tasks.GetTask(uuid.MustParse(survivor.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "Queued" {
		t.Errorf("survivor status = %q, want Queued", stored.Status)
	}
	if stored.BuildID != survivor.BuildId {
		t.Errorf("survivor build ID = %q, want snapshot value %q", stored.BuildID, survivor.BuildId)
	}

	// Every change must reach the websocket clients.
	updates := map[string]string{}
	for len(consumer.Chan) > 0 {
		task := (<-consumer.Chan).(*Task)
		updates[task.Name] = task.Status
	}

	if updates["lost/queued"] != "Cancelled" || updates["lost/assigned"] != "Cancelled" || updates["lost/running"] != "Cancelled" {
		t.Errorf("lost tasks were not broadcast: %v", updates)
	}
}

func TestApplySnapshotRemovesDisconnectedWorkers(t *testing.T) {
	_, workers := newTestServices(t)

	present := &protocol.WorkerInfo{
		Id:         "worker-1",
		Hostname:   "builder1",
		EnlistedAt: timestamppb.Now(),
		Platform: &protocol.Platform{
			Properties: []*protocol.Property{
				{Key: "label", Value: "fast"},
				{Key: "node.os", Value: "linux"},
			},
		},
	}
	gone := &protocol.WorkerInfo{Id: "worker-2", Hostname: "builder2"}

	if err := workers.ApplySnapshot([]*protocol.WorkerInfo{present, gone}); err != nil {
		t.Fatal(err)
	}
	if err := workers.ApplySnapshot([]*protocol.WorkerInfo{present}); err != nil {
		t.Fatal(err)
	}

	stored, err := workers.GetWorkers()
	if err != nil {
		t.Fatal(err)
	}

	if len(stored) != 1 {
		t.Fatalf("got %d workers, want 1", len(stored))
	}
	if stored[0].Id != "worker-1" {
		t.Errorf("worker id = %q, want worker-1", stored[0].Id)
	}
	if stored[0].Labels != "fast" {
		t.Errorf("labels = %q, want fast", stored[0].Labels)
	}
}

func TestTaskStatusNames(t *testing.T) {
	cases := map[protocol.TaskStatus]string{
		protocol.TaskStatus_TASK_CREATED:    "Queued",
		protocol.TaskStatus_TASK_QUEUED:     "Queued",
		protocol.TaskStatus_TASK_ASSIGNED:   "Assigned",
		protocol.TaskStatus_TASK_RUNNING:    "Running",
		protocol.TaskStatus_TASK_PASSED:     "Passed",
		protocol.TaskStatus_TASK_UPLOADED:   "Passed",
		protocol.TaskStatus_TASK_DOWNLOADED: "Passed",
		protocol.TaskStatus_TASK_SKIPPED:    "Passed",
		protocol.TaskStatus_TASK_FAILED:     "Failed",
		protocol.TaskStatus_TASK_ERROR:      "Failed",
		protocol.TaskStatus_TASK_UNSTABLE:   "Failed",
		protocol.TaskStatus_TASK_CANCELLED:  "Cancelled",
	}

	for status, want := range cases {
		if got := TaskStatusName(status); got != want {
			t.Errorf("%v = %q, want %q", status, got, want)
		}
	}
}
