package model

import (
	"sync"

	"github.com/google/uuid"
)

type client struct {
	broadcast *Broadcast
	Id        uuid.UUID
	Chan      chan interface{}
	overflow  chan struct{}
}

// Overflow is closed once when the client falls behind and is evicted.
// Chan remains open; callers must stop consuming and resync on overflow.
func (c *client) Overflow() <-chan struct{} {
	return c.overflow
}

func (c *client) Close() {
	c.broadcast.lock.Lock()
	defer c.broadcast.lock.Unlock()
	delete(c.broadcast.clients, c.Id)
}

type Broadcast struct {
	lock    sync.Mutex
	clients map[uuid.UUID]*client
}

func NewBroadcast() *Broadcast {
	return &Broadcast{
		clients: make(map[uuid.UUID]*client),
	}
}

func (b *Broadcast) NewClient() *client {
	b.lock.Lock()
	defer b.lock.Unlock()

	client := &client{}
	client.Id = uuid.New()
	client.Chan = make(chan interface{}, 10)
	client.overflow = make(chan struct{})
	client.broadcast = b

	b.clients[client.Id] = client

	return client
}

func (b *Broadcast) Send(msg interface{}) {
	b.lock.Lock()
	defer b.lock.Unlock()
	for _, client := range b.clients {
		select {
		case client.Chan <- msg:
		default:
			delete(b.clients, client.Id)
			close(client.overflow)
		}
	}
}
