package sessionmanager

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type bootRecoveryWorkspace struct {
	*fakeWorkspace
	forceDestroyed []domain.SessionID
}

func (w *bootRecoveryWorkspace) ForceDestroy(_ context.Context, info ports.WorkspaceInfo) error {
	w.forceDestroyed = append(w.forceDestroyed, info.SessionID)
	return os.RemoveAll(info.Path)
}

func seedBootRecoverySession(t *testing.T, store *sqlite.Store, root string, index int, kind domain.SessionKind, terminated bool, markerState string) domain.SessionRecord {
	t.Helper()
	stamp := time.Date(2026, 9, 1, 0, index, 0, 0, time.UTC)
	workspacePath := filepath.Join(root, fmt.Sprintf("session-%02d", index))
	if err := os.MkdirAll(workspacePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspacePath, "wip.txt"), []byte("preserve"), 0o600); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(context.Background(), domain.SessionRecord{
		ProjectID:    "fixture",
		Kind:         kind,
		Harness:      "codex",
		Activity:     domain.Activity{State: domain.ActivityIdle, LastActivityAt: stamp},
		IsTerminated: terminated,
		Metadata: domain.SessionMetadata{
			Branch:          fmt.Sprintf("task/session-%02d", index),
			WorkspacePath:   workspacePath,
			RuntimeHandleID: fmt.Sprintf("pane-%02d", index),
			Prompt:          fmt.Sprintf("continue session %02d", index),
		},
		CreatedAt: stamp,
		UpdatedAt: stamp,
	})
	if err != nil {
		t.Fatal(err)
	}
	if markerState != "" {
		if err := store.UpsertSessionWorktree(context.Background(), domain.SessionWorktreeRecord{
			SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName,
			Branch: rec.Metadata.Branch, WorktreePath: workspacePath, State: markerState,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return rec
}

func TestRestoreAllBoundsColdStartAndQuarantinesOverflow(t *testing.T) {
	m, store, runtime, _, _ := newSpawnFixture(t)
	root := t.TempDir()
	var recs []domain.SessionRecord
	for i := 1; i <= 7; i++ {
		kind := domain.KindWorker
		if i == 1 {
			kind = domain.KindOrchestrator
		}
		recs = append(recs, seedBootRecoverySession(t, store, root, i, kind, true, "removed"))
	}

	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("runtime creates=%d, want %d", runtime.creates, bootRestoreLimit)
	}

	restored := map[domain.SessionID]bool{
		recs[0].ID: true, // reserve one controller slot
		recs[4].ID: true,
		recs[5].ID: true,
		recs[6].ID: true,
	}
	for _, rec := range recs {
		got, ok, err := store.GetSession(context.Background(), rec.ID)
		if err != nil || !ok {
			t.Fatalf("get %s: found=%v err=%v", rec.ID, ok, err)
		}
		if got.IsTerminated == restored[rec.ID] {
			t.Fatalf("session %s terminated=%v, restored=%v", rec.ID, got.IsTerminated, restored[rec.ID])
		}
		rows, err := store.ListSessionWorktrees(context.Background(), rec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if restored[rec.ID] {
			if len(rows) != 0 {
				t.Fatalf("restored session %s retained marker: %+v", rec.ID, rows)
			}
		} else if len(rows) != 1 || rows[0].State != "active" {
			t.Fatalf("overflow session %s marker=%+v", rec.ID, rows)
		}
	}

	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("overflow resurrected on later pass: creates=%d", runtime.creates)
	}
}

func TestReconcileBoundsDeadLiveSessionsAndPreservesOverflowWorktrees(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	workspace := &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace}
	m.workspace = workspace
	root := t.TempDir()
	var recs []domain.SessionRecord
	for i := 1; i <= 7; i++ {
		kind := domain.KindWorker
		if i == 1 {
			kind = domain.KindOrchestrator
		}
		recs = append(recs, seedBootRecoverySession(t, store, root, i, kind, false, "active"))
	}

	if err := m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("runtime creates=%d, want %d", runtime.creates, bootRestoreLimit)
	}
	if len(workspace.forceDestroyed) != bootRestoreLimit {
		t.Fatalf("force-destroyed=%v, want %d bounded captures", workspace.forceDestroyed, bootRestoreLimit)
	}

	restored := map[domain.SessionID]bool{
		recs[0].ID: true,
		recs[4].ID: true,
		recs[5].ID: true,
		recs[6].ID: true,
	}
	for _, rec := range recs {
		got, ok, err := store.GetSession(context.Background(), rec.ID)
		if err != nil || !ok {
			t.Fatalf("get %s: found=%v err=%v", rec.ID, ok, err)
		}
		if got.IsTerminated == restored[rec.ID] {
			t.Fatalf("session %s terminated=%v, restored=%v", rec.ID, got.IsTerminated, restored[rec.ID])
		}
		if restored[rec.ID] {
			continue
		}
		if content, err := os.ReadFile(filepath.Join(rec.Metadata.WorkspacePath, "wip.txt")); err != nil || string(content) != "preserve" {
			t.Fatalf("overflow workspace %s lost: content=%q err=%v", rec.ID, content, err)
		}
	}

	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("overflow resurrected on later pass: creates=%d", runtime.creates)
	}
}
