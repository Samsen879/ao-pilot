package gitworktree

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestRecoveryReplayFailureRestoresAllBytesIncludingIgnored(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "recovery-1", Branch: "feature/recovery", BaseBranch: "main", SparseCheckout: []string{"keep"}}
	info, e := w.Create(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	writeSparseFile(t, info.Path, "keep/input.json", "preserved change\n")
	ref, e := w.StashUncommitted(ctx, info)
	if e != nil {
		t.Fatal(e)
	}
	runGitTest(t, info.Path, "reset", "--hard", "HEAD")
	writeSparseFile(t, info.Path, "keep/input.json", "conflicting committed line\n")
	runGitTest(t, info.Path, "add", ".")
	runGitTest(t, info.Path, "commit", "-m", "divergent destination")
	writeSparseFile(t, info.Path, ".gitignore", "local-private\n")
	runGitTest(t, info.Path, "add", ".gitignore")
	runGitTest(t, info.Path, "commit", "-m", "ignore fixture")
	writeSparseFile(t, info.Path, "local-private/unique.db", "ignored bytes\x00must survive")
	writeSparseFile(t, info.Path, "outside/untouched-local.txt", "untracked unchanged bytes")
	before, e := recoveryInventory(info.Path)
	if e != nil {
		t.Fatal(e)
	}
	priorUmask := syscall.Umask(0077)
	defer syscall.Umask(priorUmask)
	beforeStatus := runGitTest(t, info.Path, "status", "--porcelain=v2")
	head := runGitTest(t, info.Path, "rev-parse", "HEAD")
	if e = w.ApplyPreserved(ctx, info, ref); e == nil {
		t.Fatal("expected replay failure")
	}
	after, e := recoveryInventory(info.Path)
	if e != nil || !reflect.DeepEqual(before, after) {
		t.Fatalf("rollback changed original files (including ignored): %v", e)
	}
	if got := runGitTest(t, info.Path, "status", "--porcelain=v2"); got != beforeStatus {
		t.Fatal("real index/status not restored")
	}
	if runGitTest(t, info.Path, "rev-parse", "HEAD") != head {
		t.Fatal("HEAD moved")
	}
	runGitTest(t, info.Path, "rev-parse", "--verify", ref)
	if e = w.RollbackRestore(ctx, info); e != nil {
		t.Fatal("rollback not idempotent", e)
	}
}
func TestRecoverySuccessVerifiesManifestBeforeCleanupAndRetainsRef(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "success-1", Branch: "feature/success", BaseBranch: "main", SparseCheckout: []string{"keep"}}
	info, e := w.Create(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	writeSparseFile(t, info.Path, "keep/input.json", "saved WIP\n")
	ref, e := w.StashUncommitted(ctx, info)
	if e != nil {
		t.Fatal(e)
	}
	runGitTest(t, info.Path, "reset", "--hard", "HEAD")
	writeSparseFile(t, info.Path, ".gitignore", "local-private\n")
	writeSparseFile(t, info.Path, "local-private/unique.key", "ignored bytes")
	writeSparseFile(t, info.Path, "outside/new.txt", "outside WIP")
	if e = w.ApplyPreserved(ctx, info, ref); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e == nil {
		t.Fatal("cleanup admitted without verification")
	}
	if e = w.VerifyRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	for name, want := range map[string]string{"keep/input.json": "saved WIP\n", "local-private/unique.key": "ignored bytes", "outside/new.txt": "outside WIP"} {
		got, e := os.ReadFile(filepath.Join(info.Path, name))
		if e != nil || string(got) != want {
			t.Fatalf("%s %q: %v", name, got, e)
		}
	}
	runGitTest(t, info.Path, "rev-parse", "--verify", ref)
	r, e := readRecovery(info.Path)
	if e != nil || r.Phase != "committed" || r.CleanupAt == "" {
		t.Fatalf("cleanup receipt %+v %v", r, e)
	}
	if _, e = os.Lstat(r.Backup); !os.IsNotExist(e) {
		t.Fatal("verified backup not cleaned", e)
	}
	before, _ := recoveryInventory(info.Path)
	if e = w.ApplyPreserved(ctx, info, ref); e != nil {
		t.Fatal("repeat replay not idempotent", e)
	}
	if e = w.VerifyRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	after, _ := recoveryInventory(info.Path)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("repeat changed files")
	}
}
func TestRecoveryQuarantineResidueResumesAndRollsBackWithoutClobber(t *testing.T) {
	repo, managed, w := newSparseRepoFixture(t)
	ctx := context.Background()
	path := filepath.Join(managed, "project", "stray-1")
	writeSparseFile(t, path, "local/ignored.db", "unique ignored old bytes")
	writeSparseFile(t, path, "keep/input.json", "original unregistered WIP")
	info := ports.WorkspaceInfo{Path: path, RepoPath: repo, ProjectID: "project", SessionID: "stray-1"}
	before, e := recoveryInventory(path)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = w.prepareRecovery(ctx, info, "rename"); e != nil {
		t.Fatal(e)
	}
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "stray-1", Branch: "feature/stray", BaseBranch: "main", Path: path, SparseCheckout: []string{"keep"}}
	restored, e := w.Restore(ctx, cfg)
	if e != nil {
		t.Fatal("residual quarantine should resume", e)
	}
	if got, e := os.ReadFile(filepath.Join(restored.Path, "local/ignored.db")); e != nil || string(got) != "unique ignored old bytes" {
		t.Fatalf("ignored file lost: %q %v", got, e)
	}
	if e = w.RollbackRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
	after, e := recoveryInventory(path)
	if e != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("rename rollback changed original directory", e)
	}
	if e = w.RollbackRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
	// Repeat after rollback: no duplicate branch ownership and no deletion of the
	// retained original. An explicit retry can finish the same reconstruction.
	restored, e = w.Restore(ctx, cfg)
	if e != nil {
		t.Fatal("explicit retry after residual recovery", e)
	}
	if e = w.VerifyRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
	for name, f := range before {
		if name == "." {
			continue
		}
		now, e := recoveryInventory(path)
		if e != nil || now[name] != f {
			t.Fatalf("final original file missing: %s %v", name, e)
		}
	}
}
func TestRestoreReusesExistingDirectoryWithoutChangingSparseOrIgnored(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "reuse-1", Branch: "feature/reuse", BaseBranch: "main", SparseCheckout: []string{"keep", "outside"}}
	info, e := w.Create(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	writeSparseFile(t, info.Path, "outside/local.txt", "untracked")
	writeSparseFile(t, info.Path, "keep/input.json", "modified")
	writeSparseFile(t, info.Path, ".gitignore", "outside/local.db\n")
	writeSparseFile(t, info.Path, "outside/local.db", "ignored")
	before, _ := recoveryInventory(info.Path)
	inode, _ := os.Stat(info.Path)
	cfg.Path = info.Path
	cfg.SparseCheckout = []string{"keep"}
	restored, e := w.Restore(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	after, _ := recoveryInventory(restored.Path)
	inode2, _ := os.Stat(restored.Path)
	if !os.SameFile(inode, inode2) || !reflect.DeepEqual(before, after) {
		t.Fatal("existing workspace was rebuilt or narrowed destructively")
	}
}
