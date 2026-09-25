package lifecycle_test

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type paneLockingTracker struct{ reached chan struct{} }

func (t paneLockingTracker) ObserveActivity(_ context.Context, _, after domain.SessionRecord, _ string) {
	_ = sessionguard.WithSessionLock(after.ID, func() error {
		close(t.reached)
		return nil
	})
}

func TestSubmitTrackerRunsAfterPaneLockReleased(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store, err := sqlite.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: root}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindOrchestrator})
	if err != nil {
		t.Fatal(err)
	}
	tracker := paneLockingTracker{reached: make(chan struct{})}
	m := lifecycle.New(store, nil, lifecycle.WithOrchestratorReengagement(tracker))
	done := make(chan error, 1)
	go func() {
		done <- m.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{
			Valid: true, State: domain.ActivityActive, Event: "user-prompt-submit", HookObservedAt: time.Now(),
		})
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("submit tracker waited for a pane lock still held by lifecycle")
	}
	select {
	case <-tracker.reached:
	default:
		t.Fatal("tracker did not observe the submission")
	}
}
