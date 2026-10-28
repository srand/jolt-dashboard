package model

import (
	"sync"
	"testing"
	"time"
)

func TestBroadcast(t *testing.T) {
	bc := NewBroadcast()

	cl := bc.NewClient()
	defer cl.Close()

	bc.Send("msg")
	msg := <-cl.Chan
	if msg != "msg" {
		t.Fatalf("message = %v, want msg", msg)
	}
	select {
	case <-cl.Overflow():
		t.Fatal("client overflowed before its channel filled")
	default:
	}
}

func TestBroadcastOverflowEvictsOnlySlowClient(t *testing.T) {
	bc := NewBroadcast()
	slow := bc.NewClient()
	healthy := bc.NewClient()
	defer slow.Close()
	defer healthy.Close()
	if cap(slow.Chan) != 10 {
		t.Fatalf("channel capacity = %d, want 10", cap(slow.Chan))
	}

	for i := 0; i < 12; i++ {
		sent := make(chan struct{})
		go func() {
			bc.Send(i)
			close(sent)
		}()
		select {
		case <-sent:
		case <-time.After(time.Second):
			t.Fatal("Send blocked on the slow client")
		}
		select {
		case msg := <-healthy.Chan:
			if msg != i {
				t.Fatalf("healthy client message = %v, want %d", msg, i)
			}
		default:
			t.Fatal("healthy client missed an event")
		}
		select {
		case <-slow.Overflow():
			if i < 10 {
				t.Fatalf("client overflowed on event %d before the queue was full", i)
			}
		default:
			if i >= 10 {
				t.Fatal("overflow was not signaled")
			}
		}
	}
	if _, exists := bc.clients[slow.Id]; exists {
		t.Fatal("overflowed client was not evicted")
	}
	if _, exists := bc.clients[healthy.Id]; !exists {
		t.Fatal("healthy client was evicted")
	}
	for i := 0; i < 10; i++ {
		if msg := <-slow.Chan; msg != i {
			t.Fatalf("queued message = %v, want %d", msg, i)
		}
	}
	bc.Send("after draining")
	select {
	case msg, open := <-slow.Chan:
		t.Fatalf("drained evicted client received %v (channel open = %v)", msg, open)
	default:
	}
	// Neither draining the queue nor closing an evicted client revives it or
	// triggers a second notification (which would panic for a closed channel).
	slow.Close()
	slow.Close()
	bc.Send("after eviction")
	select {
	case msg, open := <-slow.Chan:
		t.Fatalf("evicted client received %v (channel open = %v)", msg, open)
	default:
	}
	select {
	case <-healthy.Overflow():
		t.Fatal("healthy client overflowed")
	default:
	}
}

func TestBroadcastCloseDoesNotSignalOverflow(t *testing.T) {
	bc := NewBroadcast()
	cl := bc.NewClient()
	cl.Close()
	cl.Close()
	bc.Send("after close")
	select {
	case <-cl.Overflow():
		t.Fatal("explicit Close signaled overflow")
	default:
	}
	select {
	case msg, open := <-cl.Chan:
		t.Fatalf("closed client received %v (channel open = %v)", msg, open)
	default:
	}
}

func TestBroadcastConcurrentSendClose(t *testing.T) {
	for round := 0; round < 20; round++ {
		bc := NewBroadcast()
		clients := make([]*client, 32)
		for i := range clients {
			clients[i] = bc.NewClient()
		}
		for i := 0; i < 10; i++ {
			bc.Send(i)
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, cl := range clients {
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				for i := 0; i < 10; i++ {
					bc.Send(i)
				}
			}()
			go func() {
				defer wg.Done()
				<-start
				cl.Close()
				cl.Close()
			}()
		}
		close(start)
		done := make(chan struct{})
		go func() {
			wg.Wait()
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent Send/Close did not finish")
		}
		if len(bc.clients) != 0 {
			t.Fatal("closed or overflowed clients remain subscribed")
		}
		for _, cl := range clients {
			for i := 0; i < 10; i++ {
				if msg, open := <-cl.Chan; !open || msg != i {
					t.Fatalf("queued message = %v (open = %v), want %d", msg, open, i)
				}
			}
			bc.Send("after close")
			select {
			case msg, open := <-cl.Chan:
				t.Fatalf("closed client received %v (channel open = %v)", msg, open)
			default:
			}
		}
	}
}
