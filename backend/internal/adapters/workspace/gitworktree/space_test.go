package gitworktree

import (
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestEnsureCapacityRejectsCheckoutBelowReserve(t *testing.T) {
	w := &Workspace{
		capacityPath:  "/capacity",
		minFreeBytes:  32,
		availableBytes: func(path string) (uint64, error) {
			if path != "/capacity" {
				t.Fatalf("capacity path = %q", path)
			}
			return 31, nil
		},
	}
	if err := w.ensureCapacity(); !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("ensureCapacity error = %v, want ErrWorkspaceInsufficientSpace", err)
	}
}

func TestEnsureCapacityDisabledDoesNotProbe(t *testing.T) {
	w := &Workspace{availableBytes: func(string) (uint64, error) {
		t.Fatal("disabled capacity guard probed filesystem")
		return 0, nil
	}}
	if err := w.ensureCapacity(); err != nil {
		t.Fatalf("ensureCapacity error = %v", err)
	}
}
