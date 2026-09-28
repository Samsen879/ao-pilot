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

func TestCodexOptsIntoGuardedSubmitConfirmation(t *testing.T) {
	p := New()
	if !p.EmitsSubmitActivity() {
		t.Fatal("Codex must expose its user-prompt-submit signal")
	}
	if !p.EmitsBlockedActivity() {
		t.Fatal("Codex must expose permission-request as blocked before Enter retries are enabled")
	}
}
