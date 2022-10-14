package model

import (
	"log"
	"sync"

	"github.com/google/uuid"
)

type client struct {
	broadcast *Broadcast
	Id        uuid.UUID
	Chan      chan interface{}
}

func (c *client) Close() {
	c.broadcast.lock.Lock()
	defer c.broadcast.lock.Unlock()
	delete(c.broadcast.clients, c.Id)
}

type Broadcast struct {
	lock    sync.RWMutex
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
	client.broadcast = b

	b.clients[client.Id] = client

	return client
}

func (b *Broadcast) Send(msg interface{}) {
	b.lock.RLock()
	defer b.lock.RUnlock()
	for _, client := range b.clients {
		select {
		case client.Chan <- msg:
		default:
			log.Println("Client broadcast channel full, discarded event")
		}
	}
}
