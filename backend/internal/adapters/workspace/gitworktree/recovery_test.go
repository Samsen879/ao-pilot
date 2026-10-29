package gitworktree

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReplayRepairsMissingSparsePatternsWithoutLosingExistingFiles(t *testing.T) {
	for _, mode := range []string{"success", "capacity", "after-set-failure", "no-capacity"} {
		t.Run(mode, func(t *testing.T) {
			_, _, w := newSparseRepoFixture(t)
			ctx := context.Background()
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "missing-patterns", Branch: "feature/missing-patterns", BaseBranch: "main", SparseCheckout: []string{"keep", "outside", "untouched"}}
			info, err := w.Create(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			writeSparseFile(t, info.Path, "outside/edited.txt", "saved WIP\n")
			ref, err := w.StashUncommitted(ctx, info)
			if err != nil {
				t.Fatal(err)
			}
			runGitTest(t, info.Path, "reset", "--hard", "HEAD")
			runGitTest(t, info.Path, "sparse-checkout", "set", "keep", "untouched")
			writeSparseFile(t, info.Path, ".gitignore", "local-private/\n")
			writeSparseFile(t, info.Path, "local-private/db", "unique ignored bytes")
			patterns := runGitTest(t, info.Path, "rev-parse", "--path-format=absolute", "--git-path", "info/sparse-checkout")
			if err := os.Remove(patterns); err != nil {
				t.Fatal(err)
			}
			before, err := recoveryInventory(info.Path)
			if err != nil {
				t.Fatal(err)
			}
			inode, _ := os.Stat(info.Path)
			gitdir := runGitTest(t, info.Path, "rev-parse", "--absolute-git-dir")
			metadata, err := recoveryInventory(gitdir)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "capacity" || mode == "no-capacity" {
				w.minFreeBytes = 1
				w.availableBytes = func(string) (uint64, error) {
					if mode == "no-capacity" {
						return 0, nil
					}
					return 1 << 40, nil
				}
			}
			if mode == "after-set-failure" {
				real := w.run
				w.run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
					out, err := real(ctx, binary, args...)
					if err == nil && len(args) > 3 && args[2] == "sparse-checkout" && args[3] == "set" {
						return out, fmt.Errorf("injected after patterns repair")
					}
					return out, err
				}
			}
			err = w.ApplyPreserved(ctx, info, ref)
			if mode == "after-set-failure" || mode == "no-capacity" {
				if err == nil {
					t.Fatal("expected guarded failure")
				}
				after, e := recoveryInventory(info.Path)
				if e != nil || !reflect.DeepEqual(before, after) {
					t.Fatal("original files changed", e)
				}
				got, e := recoveryInventory(gitdir)
				if e != nil || !reflect.DeepEqual(metadata, got) {
					t.Fatal("Git metadata changed", e)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			after, err := recoveryInventory(info.Path)
			if err != nil {
				t.Fatal(err)
			}
			if !sameRecoveryFiles(before, after, false) {
				t.Fatal("unrelated or ignored files changed")
			}
			if b, _ := os.ReadFile(filepath.Join(info.Path, "outside/edited.txt")); string(b) != "saved WIP\n" {
				t.Fatal("preserved WIP not replayed")
			}
			newInode, _ := os.Stat(info.Path)
			if !os.SameFile(inode, newInode) {
				t.Fatal("worktree rebuilt")
			}
			if !strings.Contains(runGitTest(t, info.Path, "sparse-checkout", "list"), "untouched") {
				t.Fatal("existing materialized directory excluded")
			}
			if err := w.VerifyRestore(ctx, info); err != nil {
				t.Fatal(err)
			}
			if err := w.CommitRestore(ctx, info); err != nil {
				t.Fatal(err)
			}
			runGitTest(t, info.Path, "rev-parse", "--verify", ref)
		})
	}
}

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

func TestReplayRestoresExecutableAndSymlinkTypeChanges(t *testing.T) {
	for _, kind := range []string{"executable", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			_, _, w := newSparseRepoFixture(t)
			ctx := context.Background()
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "mode-1", Branch: "feature/mode", BaseBranch: "main"}
			info, e := w.Create(ctx, cfg)
			if e != nil {
				t.Fatal(e)
			}
			file := filepath.Join(info.Path, "keep/input.json")
			if kind == "executable" {
				if e = os.Chmod(file, 0755); e != nil {
					t.Fatal(e)
				}
			} else {
				if e = os.Remove(file); e != nil {
					t.Fatal(e)
				}
				if e = os.Symlink("{}", file); e != nil {
					t.Fatal(e)
				}
			}
			ref, e := w.StashUncommitted(ctx, info)
			if e != nil || ref == "" {
				t.Fatalf("preserve %s %v", ref, e)
			}
			runGitTest(t, info.Path, "reset", "--hard", "HEAD")
			if e = w.ApplyPreserved(ctx, info, ref); e != nil {
				t.Fatal(e)
			}
			st, e := os.Lstat(file)
			if e != nil {
				t.Fatal(e)
			}
			if kind == "executable" && st.Mode().Perm()&0111 == 0 || kind == "symlink" && st.Mode()&os.ModeSymlink == 0 {
				t.Fatalf("type/mode lost: %v", st.Mode())
			}
			if e = w.VerifyRestore(ctx, info); e != nil {
				t.Fatal(e)
			}
			if e = w.CommitRestore(ctx, info); e != nil {
				t.Fatal(e)
			}
		})
	}
}
func TestReplayAllowsOnlyDirectoriesEmptiedBySavedDeletions(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "delete-1", Branch: "feature/delete", BaseBranch: "main"}
	info, e := w.Create(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	runGitTest(t, info.Path, "rm", "keep/input.json")
	ref, e := w.StashUncommitted(ctx, info)
	if e != nil {
		t.Fatal(e)
	}
	runGitTest(t, info.Path, "reset", "--hard", "HEAD")
	writeSparseFile(t, info.Path, "ignored-local/bytes", "unchanged")
	if e = w.ApplyPreserved(ctx, info, ref); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(filepath.Join(info.Path, "keep/input.json")); !os.IsNotExist(e) {
		t.Fatal("saved deletion lost", e)
	}
	if got, e := os.ReadFile(filepath.Join(info.Path, "ignored-local/bytes")); e != nil || string(got) != "unchanged" {
		t.Fatal("unrelated bytes lost", e)
	}
	if e = w.VerifyRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
}
func TestRecoveryOverlayAcceptsIdenticalTrackedSymlink(t *testing.T) {
	repo, managed, w := newSparseRepoFixture(t)
	if e := os.Symlink("keep/input.json", filepath.Join(repo, "link")); e != nil {
		t.Fatal(e)
	}
	runGitTest(t, repo, "add", "link")
	runGitTest(t, repo, "commit", "-m", "tracked symlink")
	root := filepath.Join(managed, "project", "link-1")
	writeSparseFile(t, root, "unique-private/ignored", "old bytes")
	if e := os.Symlink("keep/input.json", filepath.Join(root, "link")); e != nil {
		t.Fatal(e)
	}
	info, e := w.Restore(context.Background(), ports.WorkspaceConfig{ProjectID: "project", SessionID: "link-1", Branch: "feature/link", BaseBranch: "main", Path: root})
	if e != nil {
		t.Fatal(e)
	}
	if target, e := os.Readlink(filepath.Join(root, "link")); e != nil || target != "keep/input.json" {
		t.Fatal(target, e)
	}
	if e = w.VerifyRestore(context.Background(), info); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(context.Background(), info); e != nil {
		t.Fatal(e)
	}
}
func TestReuseRejectsBothUnownedQuarantineLocations(t *testing.T) {
	for _, suffix := range []string{".ao-recovery-backup", ".ao-recovery-backup.git-metadata"} {
		t.Run(suffix, func(t *testing.T) {
			_, _, w := newSparseRepoFixture(t)
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "unknown-1", Branch: "feature/unknown", BaseBranch: "main"}
			info, e := w.Create(context.Background(), cfg)
			if e != nil {
				t.Fatal(e)
			}
			writeSparseFile(t, info.Path+suffix, "private", "old bytes")
			before, e := recoveryInventory(info.Path)
			if e != nil {
				t.Fatal(e)
			}
			if e = w.VerifyRestore(context.Background(), info); e == nil {
				t.Fatal("unowned quarantine accepted")
			}
			after, e := recoveryInventory(info.Path)
			if e != nil || !reflect.DeepEqual(before, after) {
				t.Fatal("original changed", e)
			}
			if _, e = os.Stat(info.Path + suffix); e != nil {
				t.Fatal(e)
			}
		})
	}
}
func TestRollbackResumesAfterOriginalDirectoryMove(t *testing.T) {
	for _, movedMetadata := range []bool{false, true} {
		t.Run(fmt.Sprint(movedMetadata), func(t *testing.T) {
			_, _, w := newSparseRepoFixture(t)
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "partial-1", Branch: "feature/partial", BaseBranch: "main"}
			info, e := w.Create(context.Background(), cfg)
			if e != nil {
				t.Fatal(e)
			}
			writeSparseFile(t, info.Path, "ignored/unique", "old bytes")
			before, _ := recoveryInventory(info.Path)
			r, e := w.prepareRecovery(context.Background(), info, "copy")
			if e != nil {
				t.Fatal(e)
			}
			writeSparseFile(t, info.Path, "keep/input.json", "failed attempt")
			if e = os.WriteFile(filepath.Join(r.GitDir, "MERGE_MSG"), []byte("failed merge"), 0600); e != nil {
				t.Fatal(e)
			}
			if e = os.Rename(info.Path, info.Path+".failed-before-crash"); e != nil {
				t.Fatal(e)
			}
			if e = os.Rename(r.Backup, info.Path); e != nil {
				t.Fatal(e)
			}
			if movedMetadata {
				if e = os.Rename(r.GitDir, r.Backup+".failed-before-crash.git-metadata"); e != nil {
					t.Fatal(e)
				}
			}
			if e = w.RollbackRestore(context.Background(), info); e != nil {
				t.Fatal(e)
			}
			if e = w.RollbackRestore(context.Background(), info); e != nil {
				t.Fatal("repeat", e)
			}
			after, _ := recoveryInventory(info.Path)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("original bytes changed")
			}
			meta, e := recoveryInventory(r.GitDir)
			if e != nil || !exactRecoveryFiles(r.GitFiles, meta) {
				t.Fatal("metadata not restored", e)
			}
		})
	}
}

func TestNestedRepositoryVerificationBindsChildReceiptChanges(t *testing.T) {
	repo, _, w := newSparseRepoFixture(t)
	childRepo, _, _ := newSparseRepoFixture(t)
	ctx := context.Background()
	root, e := w.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "nested-1", Branch: "feature/nested", BaseBranch: "main"})
	if e != nil {
		t.Fatal(e)
	}
	root.RepoPath = repo
	childPath := filepath.Join(root.Path, "child")
	runGitTest(t, childRepo, "worktree", "add", "-b", "feature/child", childPath, "main")
	child := ports.WorkspaceInfo{Path: childPath, RepoPath: childRepo, ProjectID: "project", SessionID: "nested-1"}
	root.RecoveryChildren = []string{childPath}
	// Create a root snapshot before child recovery writes its owned sidecar.
	if _, e = w.prepareRecovery(ctx, root, "copy"); e != nil {
		t.Fatal(e)
	}
	if e = w.VerifyRestore(ctx, child); e != nil {
		t.Fatal(e)
	}
	if e = w.VerifyRestore(ctx, root); e != nil {
		t.Fatal("initial coordinated verification", e)
	}
	if e = w.CommitRestore(ctx, child); e != nil {
		t.Fatal(e)
	}
	// Child commit rewrites its receipt; the parent rechecks that bound child
	// manifest and every other original byte before accepting the owned change.
	if e = w.VerifyRestore(ctx, root); e != nil {
		t.Fatal("parent after child commit", e)
	}
	if e = w.CommitRestore(ctx, root); e != nil {
		t.Fatal(e)
	}
	// An undeclared/unverified child is never a wildcard exclusion.
	root.RecoveryChildren = []string{filepath.Join(root.Path, "unknown")}
	if e = w.VerifyRestore(ctx, root); e == nil {
		t.Fatal("unverified child accepted")
	}
}
func TestRenameRollbackResumesRegistrationCleanup(t *testing.T) {
	repo, managed, w := newSparseRepoFixture(t)
	ctx := context.Background()
	path := filepath.Join(managed, "project", "rename-partial")
	writeSparseFile(t, path, "private/unique.db", "old original bytes")
	before, _ := recoveryInventory(path)
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "rename-partial", Branch: "feature/rename-partial", BaseBranch: "main", Path: path}
	info, e := w.Restore(ctx, cfg)
	if e != nil {
		t.Fatal(e)
	}
	r, e := readRecovery(path)
	if e != nil || r.Mode != "rename" {
		t.Fatal(r, e)
	}
	if e = os.Rename(path, path+".failed-at-interruption"); e != nil {
		t.Fatal(e)
	}
	if e = os.Rename(r.Backup, path); e != nil {
		t.Fatal(e)
	}
	if e = w.RollbackRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = w.RollbackRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	after, _ := recoveryInventory(path)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("original directory changed")
	}
	if _, e = os.Stat(r.GitDir); !os.IsNotExist(e) {
		t.Fatal("replacement registration retained", e)
	}
	runGitTest(t, repo, "show-ref", "--verify", "refs/heads/feature/rename-partial")
	restored, e := w.Restore(ctx, cfg)
	if e != nil {
		t.Fatal("retry after partial rename rollback", e)
	}
	if e = w.VerifyRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, restored); e != nil {
		t.Fatal(e)
	}
}

func TestVerifiedReuseStillRejectsNewUnownedBackups(t *testing.T) {
	for _, suffix := range []string{".ao-recovery-backup", ".ao-recovery-backup.git-metadata"} {
		t.Run(suffix, func(t *testing.T) {
			_, _, w := newSparseRepoFixture(t)
			ctx := context.Background()
			info, e := w.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "reuse-unknown", Branch: "feature/reuse-unknown", BaseBranch: "main"})
			if e != nil {
				t.Fatal(e)
			}
			if e = w.VerifyRestore(ctx, info); e != nil {
				t.Fatal(e)
			}
			writeSparseFile(t, info.Path+suffix, "original-private", "unowned original bytes")
			if e = w.VerifyRestore(ctx, info); e == nil {
				t.Fatal("verified reuse adopted unknown backup")
			}
			if e = w.CommitRestore(ctx, info); e == nil {
				t.Fatal("reuse committed unexplained quarantine")
			}
			if got, e := os.ReadFile(filepath.Join(info.Path+suffix, "original-private")); e != nil || string(got) != "unowned original bytes" {
				t.Fatal("unknown backup lost", e)
			}
		})
	}
}
func TestCommitRetainsBackupWhenInventoryHasSpecialFile(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	info, e := w.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "special-backup", Branch: "feature/special-backup", BaseBranch: "main"})
	if e != nil {
		t.Fatal(e)
	}
	r, e := w.prepareRecovery(ctx, info, "copy")
	if e != nil {
		t.Fatal(e)
	}
	if e = w.VerifyRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = syscall.Mkfifo(filepath.Join(r.Backup, "unexpected-fifo"), 0600); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e == nil {
		t.Fatal("unreadable inventory was deleted")
	}
	if _, e = os.Lstat(filepath.Join(r.Backup, "unexpected-fifo")); e != nil {
		t.Fatal("quarantine deleted", e)
	}
	record, e := readRecovery(info.Path)
	if e != nil || record.Phase == "committed" || record.CleanupStartedAt != "" {
		t.Fatal("invalid success checkpoint", record, e)
	}
}
func TestCleanupResumesOnlyAfterDurableVerifiedCheckpoint(t *testing.T) {
	_, _, w := newSparseRepoFixture(t)
	ctx := context.Background()
	info, e := w.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "cleanup-partial", Branch: "feature/cleanup-partial", BaseBranch: "main"})
	if e != nil {
		t.Fatal(e)
	}
	r, e := w.prepareRecovery(ctx, info, "copy")
	if e != nil {
		t.Fatal(e)
	}
	if e = w.VerifyRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	r, e = readRecovery(info.Path)
	if e != nil {
		t.Fatal(e)
	}
	r.CleanupStartedAt = "2026-10-25T00:00:00Z"
	if e = writeRecovery(*r); e != nil {
		t.Fatal(e)
	}
	if e = os.RemoveAll(r.Backup); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	if e = w.CommitRestore(ctx, info); e != nil {
		t.Fatal(e)
	}
	record, e := readRecovery(info.Path)
	if e != nil || record.Phase != "committed" {
		t.Fatal(record, e)
	}
}
