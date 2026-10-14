package model

import (
	"testing"

	"github.com/srand/jolt-dashboard/protocol"
)

func TestNewWorkerFromInfoRecordsTaskLog(t *testing.T) {
	running := newTaskInfo("build/lib", protocol.TaskStatus_TASK_RUNNING)
	running.Log = "http://logstash/logs/" + running.Instance

	worker := NewWorkerFromInfo(&protocol.WorkerInfo{Id: "worker", Task: running})

	if worker.TaskLog != running.Log {
		t.Errorf("task log = %q, want %q", worker.TaskLog, running.Log)
	}
}

// The scheduler leaves the log url empty until a task starts executing, which
// is what the dashboard uses to decide whether a log can be viewed.
func TestNewWorkerFromInfoWithoutTaskLog(t *testing.T) {
	assigned := newTaskInfo("build/lib", protocol.TaskStatus_TASK_ASSIGNED)

	worker := NewWorkerFromInfo(&protocol.WorkerInfo{Id: "worker", Task: assigned})

	if worker.TaskLog != "" {
		t.Errorf("task log = %q, want empty", worker.TaskLog)
	}

	idle := NewWorkerFromInfo(&protocol.WorkerInfo{Id: "worker"})
	if idle.TaskLog != "" {
		t.Errorf("idle task log = %q, want empty", idle.TaskLog)
	}
}
