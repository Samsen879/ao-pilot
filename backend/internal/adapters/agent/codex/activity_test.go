package codex

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestPermissionRequestBlocksAutomatedEnter(t *testing.T) {
	state, ok := DeriveActivityState("permission-request", nil)
	if !ok || state != domain.ActivityBlocked {
		t.Fatalf("permission request state = %q, signaled = %v", state, ok)
	}
}
