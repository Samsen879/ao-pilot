package sessionmanager

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestEmergencyStopPreservesWorkspaceAndPreventsAutomaticRestore(t *testing.T) {
	m, store, runtime, workspace, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	important := filepath.Join(rec.Metadata.WorkspacePath, "ignored-output.txt")
	if err := os.WriteFile(important, []byte("preserve me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSessionWorktree(ctx, domain.SessionWorktreeRecord{
		SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName,
		Branch: rec.Metadata.Branch, WorktreePath: rec.Metadata.WorkspacePath,
		State: "active",
	}); err != nil {
		t.Fatal(err)
	}

	stopped, err := m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 || runtime.destroys != 1 || workspace.destroys != 0 {
		t.Fatalf("stopped=%d destroys=%d workspace destroys=%d err=%v", stopped, runtime.destroys, workspace.destroys, err)
	}
	if content, err := os.ReadFile(important); err != nil || string(content) != "preserve me" {
		t.Fatalf("workspace file lost: %q %v", content, err)
	}
	rows, err := store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "unavailable" {
		t.Fatalf("worktree markers=%+v err=%v", rows, err)
	}
	stored, ok, err := store.GetSession(ctx, rec.ID)
	if err != nil || !ok || !stored.IsTerminated {
		t.Fatalf("session terminal=%v found=%v err=%v", stored.IsTerminated, ok, err)
	}
	if err := m.RestoreAll(ctx); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != 1 {
		t.Fatalf("automatic restore created another runtime: %d", runtime.creates)
	}
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 0 || runtime.destroys != 1 {
		t.Fatalf("second stop=%d destroys=%d err=%v", stopped, runtime.destroys, err)
	}
}

func TestEmergencyStopRetriesFailedRuntimeDestroy(t *testing.T) {
	m, store, runtime, workspace, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	runtime.destroyErr = true
	stopped, err := m.EmergencyStopAll(ctx)
	if err == nil || stopped != 0 || workspace.destroys != 0 {
		t.Fatalf("failed destroy stopped=%d workspace destroys=%d err=%v", stopped, workspace.destroys, err)
	}
	stored, _, err := store.GetSession(ctx, rec.ID)
	if err != nil || stored.IsTerminated {
		t.Fatalf("failed destroy marked terminal=%v err=%v", stored.IsTerminated, err)
	}
	runtime.destroyErr = false
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 {
		t.Fatalf("retry stopped=%d err=%v", stopped, err)
	}
}
