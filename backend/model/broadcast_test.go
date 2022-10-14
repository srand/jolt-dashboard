package model

import "testing"

func TestBroadcast(t *testing.T) {
	bc := NewBroadcast()

	cl := bc.NewClient()

	bc.Send("msg")
	msg := <-cl.Chan
	if msg.(string) != msg {
		t.Fatal(msg)
	}

	bc.Send("1")
	bc.Send("2")
	bc.Send("3")
	bc.Send("4")
	bc.Send("5")
	bc.Send("6")
	bc.Send("7")
	bc.Send("8")
	bc.Send("9")
	bc.Send("10")
	bc.Send("11")

	done := false
	for done {
		select {
		case msg := <-cl.Chan:
			if msg.(string) == "11" {
				t.Fatal(msg)
			}
		default:
			done = true
		}
	}
}
