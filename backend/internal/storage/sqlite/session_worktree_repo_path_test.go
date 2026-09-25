package sqlite_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestSessionWorktreeKeepsOriginalRepositoryPath(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "project", Path: t.TempDir(), Kind: domain.ProjectKindWorkspace}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "project", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	repoPath := filepath.Join(t.TempDir(), "original-repository")
	row := domain.SessionWorktreeRecord{SessionID: rec.ID, RepoName: "child", RepoPath: repoPath, WorktreePath: filepath.Join(t.TempDir(), "checkout"), State: "active"}
	if err := store.UpsertSessionWorktree(ctx, row); err != nil {
		t.Fatal(err)
	}
	row.RepoPath = "" // lifecycle updates must not erase creation custody
	row.State = "retry_remove"
	if err := store.UpsertSessionWorktree(ctx, row); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.GetSessionWorktree(ctx, rec.ID, "child")
	if err != nil || !ok || got.RepoPath != repoPath {
		t.Fatalf("repository path after update: row=%#v found=%v err=%v", got, ok, err)
	}
}
