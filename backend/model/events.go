package model

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
