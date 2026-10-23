package sessionmanager

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type rollbackBarrierStore struct {
	*sqlite.Store
	reached, release chan struct{}
}

func (s *rollbackBarrierStore) wait(ctx context.Context) error {
	close(s.reached)
	select {
	case <-s.release:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *rollbackBarrierStore) PreserveFailedSpawnWorkspace(ctx context.Context, id domain.SessionID, branch, workspace, repo string, clear bool) error {
	if err := s.wait(ctx); err != nil {
		return err
	}
	return s.Store.PreserveFailedSpawnWorkspace(ctx, id, branch, workspace, repo, clear)
}
func (s *rollbackBarrierStore) ClearFailedSpawnWorkspace(ctx context.Context, id domain.SessionID) error {
	if err := s.wait(ctx); err != nil {
		return err
	}
	return s.Store.ClearFailedSpawnWorkspace(ctx, id)
}

func TestRollbackOnlyWritesOwnedFields(t *testing.T) {
	for _, mode := range []string{"preserve-live-runtime", "preserve-destroyed-runtime", "clear-workspace"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			m, s, _, _, _ := newSpawnFixture(t)
			rec, err := s.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker})
			if err != nil {
				t.Fatal(err)
			}
			barrier := &rollbackBarrierStore{Store: s, reached: make(chan struct{}), release: make(chan struct{})}
			m.store = barrier
			done := make(chan struct{})
			go func() {
				defer close(done)
				if mode == "clear-workspace" {
					m.markSpawnFailedTerminatedWithoutWorkspace(ctx, rec.ID)
				} else {
					m.preserveFailedSpawnWorkspace(ctx, rec.ID, ports.WorkspaceInfo{Branch: "retained", Path: "/retained", RepoPath: "/repo"}, mode == "preserve-destroyed-runtime")
				}
			}()
			select {
			case <-barrier.reached:
			case <-ctx.Done():
				t.Fatal("rollback did not reach write barrier")
			}
			lc := lifecycle.New(s, nil)
			if err := lc.MarkSpawned(ctx, rec.ID, domain.SessionMetadata{RuntimeHandleID: "latest-handle", RuntimeLaunchID: "latest-launch", AgentSessionID: "latest-agent"}); err != nil {
				t.Fatal(err)
			}
			if err := lc.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, LaunchID: "latest-launch"}); err != nil {
				t.Fatal(err)
			}
			if _, err := s.RenameSession(ctx, rec.ID, "User name", time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SetSessionPreviewURL(ctx, rec.ID, "http://new", time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, err := s.SetSessionTerminateOnPRMerge(ctx, rec.ID, true, time.Now()); err != nil {
				t.Fatal(err)
			}
			if err := s.SetPaneDraftOwned(ctx, rec.ID, "new-draft"); err != nil {
				t.Fatal(err)
			}
			close(barrier.release)
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("rollback did not finish")
			}
			got, ok, err := s.GetSession(ctx, rec.ID)
			if err != nil || !ok {
				t.Fatalf("read: %v %v", ok, err)
			}
			if got.Activity.State != domain.ActivityActive || got.IsTerminated || got.FirstSignalAt.IsZero() {
				t.Fatalf("rollback overwrote lifecycle: %+v", got)
			}
			if got.DisplayName != "User name" || got.Metadata.PreviewURL != "http://new" || got.Metadata.PreviewRevision != 1 || !got.TerminateOnPRMerge {
				t.Fatalf("rollback overwrote user settings: %+v", got)
			}
			if mode == "preserve-live-runtime" && (got.Metadata.RuntimeHandleID != "latest-handle" || got.Metadata.RuntimeLaunchID != "latest-launch") {
				t.Fatal("preserve rewrote live runtime handles")
			}
			if mode == "preserve-destroyed-runtime" && (got.Metadata.RuntimeHandleID != "" || got.Metadata.RuntimeLaunchID != "") {
				t.Fatal("destroyed runtime handles retained")
			}
			if mode != "clear-workspace" && (got.Metadata.AgentSessionID != "latest-agent" || got.Metadata.WorkspacePath != "/retained" || got.Metadata.WorkspaceRepoPath != "/repo") {
				t.Fatal("preserved workspace/agent custody mismatch")
			}
			if mode == "clear-workspace" && (got.Metadata.WorkspacePath != "" || got.Metadata.Branch != "" || got.Metadata.RuntimeHandleID != "" || got.Metadata.AgentSessionID != "") {
				t.Fatal("destroyed workspace handles retained")
			}
			pending, owner, _, generation, err := s.PaneDraftReceipt(ctx, rec.ID)
			if err != nil || !pending || owner != "new-draft" || generation != 0 {
				t.Fatal("rollback modified pane draft")
			}
		})
	}
}
