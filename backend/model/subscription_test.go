package model

import (
	"context"
	"testing"
	"time"

	"github.com/srand/jolt-dashboard/protocol"
)

func nextEvent(t *testing.T, events <-chan interface{}) Event {
	t.Helper()
	select {
	case event := <-events:
		return event.(Event)
	case <-time.After(5 * time.Second):
		t.Fatal("no event")
		return Event{}
	}
}

func TestSubscriptionSnapshotsAndTypedUpdates(t *testing.T) {
	tasks, workers := newTestServices(t)
	if err := tasks.Builds.Upsert(&protocol.BuildInfo{Id: "build", Owners: []string{"alice"},
		Parameters: []*protocol.Property{{Key: "config.branch", Value: "main"}}}); err != nil {
		t.Fatal(err)
	}
	info := newTaskInfo("task", protocol.TaskStatus_TASK_QUEUED)
	info.BuildId = "build"
	if err := tasks.ApplyTaskInfo(info); err != nil {
		t.Fatal(err)
	}

	subscription, err := Subscribe(tasks, workers)
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()
	if len(subscription.Tasks) != 1 || subscription.Workers == nil || len(subscription.Builds) != 1 {
		t.Fatalf("snapshot = %d tasks, %v workers, %d builds", len(subscription.Tasks), subscription.Workers, len(subscription.Builds))
	}
	build := subscription.Builds[0]
	if build.StreamID != "build" || len(build.Owners) != 1 || build.Owners[0] != "alice" {
		t.Fatalf("snapshot build = %+v", build)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events, overflow := subscription.Events(ctx)

	// A build update reaches the tasks of the build and the build itself
	if err := tasks.Builds.Upsert(&protocol.BuildInfo{Id: "build", Status: protocol.BuildStatus_BUILD_CANCELLED}); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for range 2 {
		event := nextEvent(t, events)
		seen[event.Type] = true
		if event.Type == "build" && event.Item.(*BuildView).Status != "BUILD_CANCELLED" {
			t.Fatalf("build update = %+v", event.Item)
		}
	}
	if !seen["task"] || !seen["build"] {
		t.Fatalf("updates = %v, want a task and a build", seen)
	}

	if err := workers.Upsert(&protocol.WorkerInfo{Id: "worker"}); err != nil {
		t.Fatal(err)
	}
	if event := nextEvent(t, events); event.Type != "worker" {
		t.Fatalf("update = %+v, want a worker", event)
	}

	// Removing the last task of an unregistered build deletes the build
	if err := tasks.Builds.Remove("build"); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		nextEvent(t, events)
	}
	if err := tasks.collectExpiredTasks(time.Now().Add(72 * time.Hour)); err != nil {
		t.Fatal(err)
	}
	deleted := false
	for range 2 {
		event := nextEvent(t, events)
		if event.Type == "build" {
			deleted = event.Item.(*BuildView).Status == "Deleted"
		}
	}
	if !deleted {
		t.Fatal("no deleted build")
	}

	select {
	case <-overflow:
		t.Fatal("unexpected overflow")
	default:
	}
}

func TestSubscriptionOverflow(t *testing.T) {
	tasks, workers := newTestServices(t)
	subscription, err := Subscribe(tasks, workers)
	if err != nil {
		t.Fatal(err)
	}
	defer subscription.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, overflow := subscription.Events(ctx)

	// Nobody reads the events, so the worker queue overflows
	for i := range 20 {
		if err := workers.Upsert(&protocol.WorkerInfo{Id: string(rune('a' + i))}); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-overflow:
	case <-time.After(5 * time.Second):
		t.Fatal("no overflow")
	}
}
