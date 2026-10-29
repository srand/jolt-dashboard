package model

import "context"

// EventSubscription holds a detached snapshot and updates published after it.
// The snapshot is separate from the bounded incremental event queue.
type EventSubscription struct {
	Snapshot interface{}
	Chan     <-chan interface{}
	consumer *client
}

func (subscription *EventSubscription) Overflow() <-chan struct{} {
	return subscription.consumer.Overflow()
}

func (subscription *EventSubscription) Close() {
	subscription.consumer.Close()
}

// A subscription to the tasks, workers and builds, whose snapshots are taken
// together so that they are consistent with each other.
type Subscription struct {
	Tasks   []Task
	Workers []Worker
	Builds  []BuildView

	tasks, workers, builds *client
}

// Subscribe returns the current tasks, workers and builds, and their updates.
func Subscribe(tasks *TaskService, workers *WorkerService) (*Subscription, error) {
	// Builds change with tasks, under the task coordinator
	tasks.Db.taskCoordinator.Lock()
	defer tasks.Db.taskCoordinator.Unlock()
	workers.Db.workerCoordinator.Lock()
	defer workers.Db.workerCoordinator.Unlock()

	subscription := &Subscription{
		tasks:   tasks.Broadcast.NewClient(),
		workers: workers.Broadcast.NewClient(),
		builds:  tasks.Builds.Updates.NewClient(),
	}
	var err error
	if subscription.Tasks, err = tasks.getTasks(); err == nil {
		if subscription.Workers, err = workers.getWorkers(workers.Db.db); err == nil {
			subscription.Builds, err = tasks.Builds.getBuilds(tasks.Db.db)
		}
	}
	if err != nil {
		subscription.Close()
		return nil, err
	}
	return subscription, nil
}

func (subscription *Subscription) Close() {
	subscription.tasks.Close()
	subscription.workers.Close()
	subscription.builds.Close()
}

// An update on the combined stream.
type Event struct {
	Type string      `json:"type"`
	Item interface{} `json:"item"`
}

// Events merges the updates into one channel, in order for each kind, until
// the context is done. The second channel is closed when any kind of update
// overflowed, after which the subscriber must resubscribe for a new snapshot.
func (subscription *Subscription) Events(ctx context.Context) (<-chan interface{}, <-chan struct{}) {
	// Unbuffered, so a slow subscriber backs up into the queues that detect it
	events := make(chan interface{})
	overflow := make(chan struct{})
	go func() {
		select {
		case <-subscription.tasks.Overflow():
		case <-subscription.workers.Overflow():
		case <-subscription.builds.Overflow():
		case <-ctx.Done():
			return
		}
		close(overflow)
	}()
	go func() {
		for {
			var event Event
			select {
			case <-ctx.Done():
				return
			case item := <-subscription.tasks.Chan:
				event = Event{Type: "task", Item: item}
			case item := <-subscription.workers.Chan:
				event = Event{Type: "worker", Item: item}
			case item := <-subscription.builds.Chan:
				event = Event{Type: "build", Item: item}
			}
			select {
			case events <- event:
			case <-ctx.Done():
				return
			}
		}
	}()
	return events, overflow
}
