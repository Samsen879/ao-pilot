package sessionmanager

import (
	"context"
	"errors"
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
	applied        []string
	applyErr       error
}

func (w *bootRecoveryWorkspace) ForceDestroy(_ context.Context, info ports.WorkspaceInfo) error {
	w.forceDestroyed = append(w.forceDestroyed, info.SessionID)
	return os.RemoveAll(info.Path)
}

func (w *bootRecoveryWorkspace) Restore(_ context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	path := cfg.Path
	if path == "" {
		path = filepath.Join(w.root, string(cfg.SessionID))
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, RepoPath: cfg.RepoPath, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}

func (w *bootRecoveryWorkspace) ApplyPreserved(_ context.Context, info ports.WorkspaceInfo, ref string) error {
	w.applied = append(w.applied, info.Path+"="+ref)
	return w.applyErr
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
	if len(workspace.forceDestroyed) != 0 {
		t.Fatalf("cold recovery destroyed existing directories: %v", workspace.forceDestroyed)
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

func TestRestoreAllPrelaunchFailureDoesNotConsumeRuntimeBudget(t *testing.T) {
	m, store, runtime, _, _ := newSpawnFixture(t)
	root := t.TempDir()
	var recs []domain.SessionRecord
	for i := 1; i <= bootRestoreLimit+1; i++ {
		recs = append(recs, seedBootRecoverySession(t, store, root, i, domain.KindWorker, true, "removed"))
	}
	newest := recs[len(recs)-1]
	newest.Metadata.Prompt = ""
	if err := store.UpdateSession(context.Background(), newest); err != nil {
		t.Fatal(err)
	}

	if err := m.RestoreAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("runtime creates=%d, want %d after one prelaunch failure", runtime.creates, bootRestoreLimit)
	}
	failed, _, err := store.GetSession(context.Background(), newest.ID)
	if err != nil || !failed.IsTerminated {
		t.Fatalf("unresumable session terminal=%v err=%v", failed.IsTerminated, err)
	}
	rows, err := store.ListSessionWorktrees(context.Background(), newest.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "active" {
		t.Fatalf("unresumable marker=%+v err=%v", rows, err)
	}
}

func TestExplicitRestoreAppliesOverflowPreserveRef(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	workspace := &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace}
	m.workspace = workspace
	root := t.TempDir()
	rec := seedBootRecoverySession(t, store, root, 1, domain.KindWorker, true, "active")
	const preserveRef = "refs/ao/preserved/fixture-1"
	if err := store.UpsertSessionWorktree(context.Background(), domain.SessionWorktreeRecord{
		SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName,
		Branch: rec.Metadata.Branch, WorktreePath: rec.Metadata.WorkspacePath,
		PreservedRef: preserveRef, State: "active",
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(rec.Metadata.WorkspacePath); err != nil {
		t.Fatal(err)
	}

	if _, err := m.RestoreWithMode(context.Background(), rec.ID); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != 1 || len(workspace.applied) != 1 || workspace.applied[0] != rec.Metadata.WorkspacePath+"="+preserveRef {
		t.Fatalf("creates=%d applied=%v", runtime.creates, workspace.applied)
	}
	rows, err := store.ListSessionWorktrees(context.Background(), rec.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "active" || rows[0].PreservedRef != "" {
		t.Fatalf("consumed marker=%+v err=%v", rows, err)
	}
}

func TestExplicitRestoreRetainsPreserveRefWhenReplayFails(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	workspace := &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace, applyErr: errors.New("transient replay failure")}
	m.workspace = workspace
	root := t.TempDir()
	rec := seedBootRecoverySession(t, store, root, 1, domain.KindWorker, true, "active")
	const preserveRef = "refs/ao/preserved/fixture-1"
	if err := store.UpsertSessionWorktree(context.Background(), domain.SessionWorktreeRecord{
		SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName,
		Branch: rec.Metadata.Branch, WorktreePath: rec.Metadata.WorkspacePath,
		PreservedRef: preserveRef, State: "active",
	}); err != nil {
		t.Fatal(err)
	}

	if _, err := m.RestoreWithMode(context.Background(), rec.ID); err == nil {
		t.Fatal("failed replay must return an error")
	}
	if runtime.creates != 0 {
		t.Fatalf("runtime creates=%d", runtime.creates)
	}
	rows, err := store.ListSessionWorktrees(context.Background(), rec.ID)
	if err != nil || len(rows) != 1 || rows[0].PreservedRef != preserveRef || rows[0].State != "stray_moved" {
		t.Fatalf("preserve ref lost after replay failure: rows=%+v err=%v", rows, err)
	}
	cleanup, err := m.Cleanup(context.Background(), "fixture")
	if err != nil || len(cleanup.Cleaned) != 0 || len(cleanup.Skipped) != 1 || cleanup.Skipped[0].Reason != "workspace recovery HOLD" {
		t.Fatalf("HOLD bypassed by cleanup: %+v %v", cleanup, err)
	}
	item := m.restoreBatchItem(context.Background(), rec.ID)
	if item.Outcome != "skipped_hold" {
		t.Fatalf("failed recovery auto-retried: %+v", item)
	}

}

func TestExplicitWorkspaceRestoreAppliesEveryOverflowPreserveRef(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	workspace := &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace}
	m.workspace = workspace
	root := t.TempDir()
	rec := seedBootRecoverySession(t, store, root, 1, domain.KindWorker, true, "active")
	projectPath := t.TempDir()
	if err := store.UpsertWorkspaceProject(context.Background(),
		domain.ProjectRecord{ID: "fixture", Path: projectPath, Kind: domain.ProjectKindWorkspace},
		[]domain.WorkspaceRepoRecord{{ProjectID: "fixture", Name: "child", RelativePath: "child"}},
	); err != nil {
		t.Fatal(err)
	}
	rootRef := "refs/ao/preserved/fixture-1-root"
	childRef := "refs/ao/preserved/fixture-1-child"
	childPath := filepath.Join(rec.Metadata.WorkspacePath, "child")
	for _, row := range []domain.SessionWorktreeRecord{
		{SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName, RepoPath: projectPath, Branch: rec.Metadata.Branch, WorktreePath: rec.Metadata.WorkspacePath, PreservedRef: rootRef, State: "active"},
		{SessionID: rec.ID, RepoName: "child", RepoPath: filepath.Join(projectPath, "child"), Branch: rec.Metadata.Branch, WorktreePath: childPath, PreservedRef: childRef, State: "active"},
	} {
		if err := store.UpsertSessionWorktree(context.Background(), row); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.RemoveAll(rec.Metadata.WorkspacePath); err != nil {
		t.Fatal(err)
	}

	if _, err := m.RestoreWithMode(context.Background(), rec.ID); err != nil {
		t.Fatal(err)
	}
	wantApplied := []string{rec.Metadata.WorkspacePath + "=" + rootRef, childPath + "=" + childRef}
	if runtime.creates != 1 || fmt.Sprint(workspace.applied) != fmt.Sprint(wantApplied) {
		t.Fatalf("creates=%d applied=%v want=%v", runtime.creates, workspace.applied, wantApplied)
	}
	rows, err := store.ListSessionWorktrees(context.Background(), rec.ID)
	if err != nil || len(rows) != 2 {
		t.Fatalf("rows=%+v err=%v", rows, err)
	}
	for _, row := range rows {
		if row.State != "active" || row.PreservedRef != "" {
			t.Fatalf("unconsumed workspace marker=%+v", row)
		}
	}
}

func TestRestoreAllRetainsFailedReplayMarker(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	m.workspace = &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace, applyErr: errors.New("replay unavailable")}
	ctx := context.Background()
	rec := seedBootRecoverySession(t, store, t.TempDir(), 1, domain.KindWorker, true, "removed")
	const ref = "refs/ao/preserved/retry"
	rows, err := store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	rows[0].PreservedRef = ref
	if err := store.UpsertSessionWorktree(ctx, rows[0]); err != nil {
		t.Fatal(err)
	}
	if err := m.RestoreAll(ctx); err == nil {
		t.Fatal("partial replay failure must be reported for readiness degradation")
	}
	rows, err = store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil || len(rows) != 1 || rows[0].PreservedRef != ref || rows[0].State != "stray_moved" {
		t.Fatalf("failed replay lost recovery custody: rows=%+v err=%v", rows, err)
	}
	if runtime.creates != 0 {
		t.Fatal("failed replay launched an agent")
	}
}

func TestShutdownRecoveryRanksOriginalActivityNotTeardownOrder(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	m.workspace = &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace}
	ctx := context.Background()
	root := t.TempDir()
	var recs []domain.SessionRecord
	for i := 1; i <= bootRestoreLimit+1; i++ {
		recs = append(recs, seedBootRecoverySession(t, store, root, i, domain.KindWorker, false, ""))
	}
	for i := len(recs) - 1; i >= 0; i-- {
		if err := m.saveAndTeardownOne(ctx, recs[i], false); err != nil {
			t.Fatal(err)
		}
		got, ok, err := store.SessionWorktreesRecoveryActivity(ctx, recs[i].ID)
		if err != nil || !ok || !got.Equal(recs[i].Activity.LastActivityAt) {
			t.Fatalf("recovery timestamp=%v ok=%v err=%v", got, ok, err)
		}
	}
	if err := m.RestoreAll(ctx); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != bootRestoreLimit {
		t.Fatalf("creates=%d", runtime.creates)
	}
	for i, rec := range recs {
		got, _, err := store.GetSession(ctx, rec.ID)
		if err != nil || got.IsTerminated != (i == 0) {
			t.Fatalf("session %s terminated=%v err=%v; oldest must be deferred", rec.ID, got.IsTerminated, err)
		}
	}
}

func TestDeferredBootRestoreWaitsForExplicitOrderedRestore(t *testing.T) {
	m, store, runtime, baseWorkspace, _ := newSpawnFixture(t)
	m.workspace = &bootRecoveryWorkspace{fakeWorkspace: baseWorkspace}
	root := t.TempDir()
	a := seedBootRecoverySession(t, store, root, 1, domain.KindOrchestrator, false, "active")
	b := seedBootRecoverySession(t, store, root, 2, domain.KindWorker, false, "active")
	if err := m.DeferBootRestore(string(b.ID)); err != nil {
		t.Fatal(err)
	}
	if err := m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	first, _, _ := store.GetSession(context.Background(), a.ID)
	deferred, _, _ := store.GetSession(context.Background(), b.ID)
	if first.IsTerminated || !deferred.IsTerminated || runtime.creates != 1 {
		t.Fatalf("early launch: first=%v deferred=%v creates=%d", first.IsTerminated, deferred.IsTerminated, runtime.creates)
	}
	if _, err := m.RestoreWithMode(context.Background(), b.ID); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != 2 {
		t.Fatal("explicit deferred restore did not run")
	}
	if err := m.DeferBootRestore("bad,id,id"); err == nil {
		t.Fatal("duplicate deferred identities accepted")
	}
}
