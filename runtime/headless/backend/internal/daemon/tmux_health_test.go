package daemon

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"testing"
	"time"
)

type fakeTmuxInspector struct{ status, reason string }

func (f fakeTmuxInspector) InspectServer(context.Context) tmux.ServerDiagnostic {
	return tmux.ServerDiagnostic{Status: f.status, Reason: f.reason, Message: "fixture"}
}
func TestTmuxSelfCheckDegradesAndKeepsOtherDependencyReasons(t *testing.T) {
	server := &httpd.Server{}
	server.MarkDegraded(httpd.ReadinessReason{Code: "session_reconcile_failed", Message: "other dependency"})
	updateTmuxHealth(context.Background(), server, fakeTmuxInspector{"violation", "tmux_cgroup_violation"})
	server.MarkReady()
	if state := server.Readiness(); state.Ready || len(state.Reasons) != 2 {
		t.Fatalf("self-check hidden: %+v", state)
	}
	updateTmuxHealth(context.Background(), server, fakeTmuxInspector{"unknown", "tmux_unit_unavailable"})
	state := server.Readiness()
	if len(state.Reasons) != 2 || state.Reasons[1].Code != "tmux_unit_unavailable" {
		t.Fatalf("superseded reasons not scoped: %+v", state)
	}
	updateTmuxHealth(context.Background(), server, fakeTmuxInspector{"ok", ""})
	state = server.Readiness()
	if state.Ready || len(state.Reasons) != 1 || state.Reasons[0].Code != "session_reconcile_failed" {
		t.Fatalf("unrelated error cleared: %+v", state)
	}
	server.ClearDegraded("session_reconcile_failed")
	if !server.Readiness().Ready {
		t.Fatal("healthy runtime remains degraded")
	}
}
func TestTmuxHealthWatchJoinsAfterCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	server := &httpd.Server{}
	done := startTmuxHealthWatch(ctx, server, fakeTmuxInspector{"unknown", "tmux_identity_unknown"})
	if len(server.Readiness().Reasons) != 1 {
		t.Fatal("startup self-check deferred")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("tmux self-check failed to join")
	}
}
