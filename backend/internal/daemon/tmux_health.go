package daemon

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"time"
)

type tmuxInspector interface {
	InspectServer(context.Context) tmux.ServerDiagnostic
}

func updateTmuxHealth(ctx context.Context, server *httpd.Server, inspector tmuxInspector) {
	diagnostic := inspector.InspectServer(ctx)
	if diagnostic.Status == "ok" {
		for _, code := range []string{"tmux_cgroup_violation", "tmux_identity_unknown", "tmux_unit_unavailable"} {
			server.ClearDegraded(code)
		}
		return
	}
	code := diagnostic.Reason
	if code != "tmux_cgroup_violation" && code != "tmux_unit_unavailable" {
		code = "tmux_identity_unknown"
	}
	// Clear only superseded tmux reasons, never unrelated startup degradation.
	for _, known := range []string{"tmux_cgroup_violation", "tmux_identity_unknown", "tmux_unit_unavailable"} {
		if known != code {
			server.ClearDegraded(known)
		}
	}
	server.MarkDegraded(httpd.ReadinessReason{Code: code, Message: diagnostic.Message})
}

func startTmuxHealthWatch(ctx context.Context, server *httpd.Server, runtime any) <-chan struct{} {
	done := make(chan struct{})
	inspector, ok := runtime.(tmuxInspector)
	if !ok {
		close(done)
		return done
	}
	// First self-check happens synchronously before boot reconciliation, so
	// MarkReady cannot briefly conceal a known bad server membership.
	updateTmuxHealth(ctx, server, inspector)
	go func() {
		defer close(done)
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				updateTmuxHealth(ctx, server, inspector)
			}
		}
	}()
	return done
}
