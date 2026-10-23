package daemon

import (
	"context"
	"errors"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

// Enumeration failures are fatal: no periodic observation or API admission may
// proceed without a known recovery set. Per-session failures remain recoverable.
func completeBootRecovery(ctx context.Context, server *httpd.Server, sessions, runtime func(context.Context) error, startObservations func()) error {
	if err := sessions(ctx); err != nil {
		if errors.Is(err, sessionmanager.ErrRecoveryUnavailable) {
			return err
		}
		server.MarkDegraded(httpd.ReadinessReason{Code: "session_reconcile_failed", Message: err.Error()})
	}
	if err := runtime(ctx); err != nil {
		server.MarkDegraded(httpd.ReadinessReason{Code: "runtime_reconcile_failed", Message: err.Error()})
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("boot recovery cancelled: %w", err)
	}
	startObservations()
	return nil
}
