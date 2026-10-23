package daemon

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"testing"
	"time"
)

func TestPeriodicReaperWaitsForRecoveryBarrier(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	admission, started := make(chan struct{}), make(chan struct{})
	done := startAfterRecovery(ctx, admission, func(ctx context.Context) <-chan struct{} {
		close(started)
		stopped := make(chan struct{})
		go func() { <-ctx.Done(); close(stopped) }()
		return stopped
	})
	server := &httpd.Server{}
	order := []string{}
	callback := func(phase string) func(context.Context) error {
		return func(context.Context) error {
			select {
			case <-started:
				t.Fatal("reaper observed before first reconciliation finished")
			default:
			}
			order = append(order, phase)
			return nil
		}
	}
	if err := completeBootRecovery(ctx, server, callback("sessions"), callback("runtime"), func() { close(admission) }); err != nil {
		t.Fatal(err)
	}
	if len(order) != 2 || order[0] != "sessions" || order[1] != "runtime" {
		t.Fatal(order)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("reaper not admitted")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reaper failed to join")
	}
}

func TestBootFailureClassification(t *testing.T) {
	for _, fatal := range []bool{false, true} {
		t.Run(map[bool]string{false: "partial", true: "fatal_inventory"}[fatal], func(t *testing.T) {
			server := &httpd.Server{}
			started := false
			err := completeBootRecovery(context.Background(), server, func(context.Context) error {
				if fatal {
					return sessionmanager.ErrRecoveryUnavailable
				}
				return errors.New("one session failed")
			}, func(context.Context) error { return errors.New("runtime observation failed") }, func() { started = true })
			if fatal {
				if err == nil || started {
					t.Fatal("fatal inventory admitted")
				}
				return
			}
			if err != nil || !started {
				t.Fatalf("partial error blocked recovery: %v", err)
			}
			server.MarkReady()
			state := server.Readiness()
			if state.Ready || state.Status != "degraded" || len(state.Reasons) != 2 {
				t.Fatalf("partial failure hidden: %+v", state)
			}
		})
	}
}

func TestRecoveryBarrierCancellationDoesNotStartReaper(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := startAfterRecovery(ctx, make(chan struct{}), func(context.Context) <-chan struct{} { t.Error("reaper started"); return nil })
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("blocked on never-admitted reaper")
	}
}
