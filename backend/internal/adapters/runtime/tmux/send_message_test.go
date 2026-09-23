package tmux

import (
	"sync"
	"testing"
	"time"
)

func TestNewUsesOneSecondEnterSettleDelay(t *testing.T) {
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})

	if runtime.enterDelay != time.Second {
		t.Fatalf("enter delay = %s, want %s", runtime.enterDelay, time.Second)
	}
}

func TestSendLockSerializesOneSessionOnly(t *testing.T) {
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})

	first := runtime.sendLock("session-a")
	if first != runtime.sendLock("session-a") {
		t.Fatal("same session received different send locks")
	}
	if first == runtime.sendLock("session-b") {
		t.Fatal("different sessions unexpectedly share a send lock")
	}

	first.Lock()
	acquired := make(chan struct{})
	var wait sync.WaitGroup
	wait.Add(1)
	go func() {
		defer wait.Done()
		runtime.sendLock("session-a").Lock()
		close(acquired)
		runtime.sendLock("session-a").Unlock()
	}()
	select {
	case <-acquired:
		t.Fatal("second sender acquired the same session lock early")
	case <-time.After(20 * time.Millisecond):
	}
	first.Unlock()
	wait.Wait()
}
