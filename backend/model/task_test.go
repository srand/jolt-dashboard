package model

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/srand/jolt-dashboard/protocol"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func newTestServices(t *testing.T) (*TaskService, *WorkerService) {
	t.Helper()

	db := NewDatabaseFromDsn("file:" + t.Name() + "?mode=memory&cache=shared")
	tasks := &TaskService{Db: db, Broadcast: NewBroadcast()}
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

func TestApplyTaskInfoRecordsSchedulerTimestamps(t *testing.T) {
	tasks, _ := newTestServices(t)

	queued := time.Now().Add(-time.Hour)
	started := time.Now().Add(-time.Minute)

	info := newTaskInfo("build/lib", protocol.TaskStatus_TASK_RUNNING)
	info.QueuedAt = timestamppb.New(queued)
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
	if want := started.Local().Format(timeFormat); stored.Started != want {
		t.Errorf("started = %q, want %q", stored.Started, want)
	}
	if stored.Ended != "" {
		t.Errorf("ended = %q, want empty", stored.Ended)
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
	}

	stored, err := tasks.GetTask(uuid.MustParse(completed.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "Passed" {
		t.Errorf("completed task was rewritten to %q", stored.Status)
	}

	stored, err = tasks.GetTask(uuid.MustParse(survivor.Instance))
	if err != nil {
		t.Fatal(err)
	}
	if stored.Status != "Queued" {
		t.Errorf("survivor status = %q, want Queued", stored.Status)
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
