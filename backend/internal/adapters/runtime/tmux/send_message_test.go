package tmux

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type recordingRunner struct {
	mu      sync.Mutex
	calls   []string
	entered chan struct{}
	release chan struct{}
}

func (r *recordingRunner) Run(_ context.Context, _ []string, _ string, args ...string) ([]byte, error) {
	call := strings.Join(args, " ")
	r.mu.Lock()
	r.calls = append(r.calls, call)
	r.mu.Unlock()
	if strings.Contains(call, " -l ") && r.entered != nil {
		close(r.entered)
		<-r.release
	}
	return nil, nil
}

func (r *recordingRunner) contains(fragment string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, call := range r.calls {
		if strings.Contains(call, fragment) {
			return true
		}
	}
	return false
}

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

func TestSendMessageGuardedRechecksBeforeEnter(t *testing.T) {
	runner := &recordingRunner{}
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})
	runtime.runner = runner
	runtime.enterDelay = time.Millisecond
	checks := 0
	err := runtime.SendMessageGuarded(context.Background(), ports.RuntimeHandle{ID: "session-a"}, "hello", func(context.Context) error {
		checks++
		if checks == 2 {
			return errors.New("blocked")
		}
		return nil
	})
	if !errors.Is(err, ports.ErrPaneDraftPending) {
		t.Fatalf("SendMessageGuarded error = %v, want pending draft", err)
	}
	if runner.contains(" Enter") {
		t.Fatal("Enter was sent after the guard rejected the post-settle state")
	}
}

func TestInterruptWaitsForPendingSend(t *testing.T) {
	runner := &recordingRunner{entered: make(chan struct{}), release: make(chan struct{})}
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})
	runtime.runner = runner
	runtime.enterDelay = 0
	done := make(chan struct{})
	go func() {
		_ = runtime.SendMessage(context.Background(), ports.RuntimeHandle{ID: "session-a"}, "hello")
		close(done)
	}()
	<-runner.entered
	interruptDone := make(chan struct{})
	go func() {
		_ = runtime.Interrupt(context.Background(), ports.RuntimeHandle{ID: "session-a"})
		close(interruptDone)
	}()
	select {
	case <-interruptDone:
		t.Fatal("interrupt bypassed the pending send lock")
	case <-time.After(20 * time.Millisecond):
	}
	close(runner.release)
	<-done
	<-interruptDone
	if !runner.contains(" C-c") {
		t.Fatal("interrupt did not reach tmux after the send completed")
	}
}

func TestDestroyWaitsForPendingSend(t *testing.T) {
	runner := &recordingRunner{entered: make(chan struct{}), release: make(chan struct{})}
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})
	runtime.runner = runner
	runtime.enterDelay = 0
	sent := make(chan struct{})
	go func() {
		_ = runtime.SendMessage(context.Background(), ports.RuntimeHandle{ID: "session-a"}, "hello")
		close(sent)
	}()
	<-runner.entered
	destroyed := make(chan struct{})
	go func() {
		_ = runtime.Destroy(context.Background(), ports.RuntimeHandle{ID: "session-a"})
		close(destroyed)
	}()
	select {
	case <-destroyed:
		t.Fatal("destroy bypassed a pending pane write")
	case <-time.After(20 * time.Millisecond):
	}
	close(runner.release)
	<-sent
	<-destroyed
	if !runner.contains("kill-session") {
		t.Fatal("destroy did not reach tmux")
	}
}
