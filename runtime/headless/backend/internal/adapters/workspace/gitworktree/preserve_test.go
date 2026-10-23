package gitworktree

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestSparseDriftPreserveRoundTrip(t *testing.T) {
	repo, _, workspace := newSparseRepoFixture(t)
	for name, data := range map[string]string{"keep/delete.txt": "delete", "keep/recreated.txt": "same", "keep/rename.txt": "rename", "keep/.hidden": "hidden", "keep/unchanged.txt": "same"} {
		writeSparseFile(t, repo, name, data)
	}
	runGitTest(t, repo, "add", ".")
	runGitTest(t, repo, "commit", "-m", "roundtrip fixture")
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "drift-1", Branch: "feature/drift", BaseBranch: "main", SparseCheckout: []string{"keep"}}
	info, err := workspace.Create(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"keep/input.json":         "modified\x00bytes\n",
		"keep/new.txt":            "new inside",
		"keep/.hidden":            "hidden edited",
		"outside/edited.txt":      "materialized tracked WIP",
		"outside/new.txt":         "new outside",
		"outside/有 空格.txt":        "non ASCII\n",
		"outside/line\nbreak.txt": "newline",
		"outside/:(glob)*.txt":    "literal pathspec",
		"keep/renamed.txt":        "rename",
	}
	for name, data := range want {
		writeSparseFile(t, info.Path, name, data)
	}
	for _, name := range []string{"keep/delete.txt", "keep/rename.txt"} {
		if err := os.Remove(filepath.Join(info.Path, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("../keep/input.json", filepath.Join(info.Path, "outside/link")); err != nil {
		t.Fatal(err)
	}
	// Preserve final bytes when the index has a different staged state.
	writeSparseFile(t, info.Path, "keep/unchanged.txt", "staged then reverted")
	runGitTest(t, info.Path, "add", "--", "keep/unchanged.txt")
	writeSparseFile(t, info.Path, "keep/unchanged.txt", "same")
	writeSparseFile(t, info.Path, "keep/transient.txt", "staged then deleted")
	runGitTest(t, info.Path, "add", "--", "keep/transient.txt")
	if err := os.Remove(filepath.Join(info.Path, "keep/transient.txt")); err != nil {
		t.Fatal(err)
	}
	// Also cover staged renames and delete-then-recreate against HEAD.
	runGitTest(t, info.Path, "add", "--", "keep/rename.txt", "keep/renamed.txt")
	runGitTest(t, info.Path, "rm", "--", "keep/recreated.txt")
	writeSparseFile(t, info.Path, "keep/recreated.txt", "same")
	writeSparseFile(t, info.Path, "keep/.ignored", "ignored")
	writeSparseFile(t, info.Path, ".gitignore", "keep/.ignored\n")
	want[".gitignore"] = "keep/.ignored\n"
	// Status must see a materialized skip-worktree entry, but never classify
	// the unrelated, still absent untouched/hidden.txt as a deletion.
	before := runGitTest(t, info.Path, "diff", "--cached", "--binary")
	ref, err := workspace.StashUncommitted(ctx, info)
	if err != nil || ref == "" {
		t.Fatalf("preserve %q: %v", ref, err)
	}
	if after := runGitTest(t, info.Path, "diff", "--cached", "--binary"); before != after {
		t.Fatal("preserve changed the real staged state")
	}
	message := runGitTest(t, info.Path, "show", "-s", "--format=%B", ref)
	_, body, ok := strings.Cut(message, "\n\n")
	var receipt preserveReceipt
	if !ok || json.Unmarshal([]byte(body), &receipt) != nil {
		t.Fatalf("missing receipt: %s", message)
	}
	expectedDrift := []string{"outside/:(glob)*.txt", "outside/edited.txt", "outside/line\nbreak.txt", "outside/link", "outside/new.txt", "outside/有 空格.txt"}
	if !reflect.DeepEqual(receipt.ConeDrift, expectedDrift) {
		t.Fatalf("cone_drift=%q want %q", receipt.ConeDrift, expectedDrift)
	}
	changed := runGitTest(t, info.Path, "diff", "--name-only", "HEAD", ref)
	if strings.Contains(changed, "untouched") || strings.Contains(changed, "unchanged") || strings.Contains(changed, "transient") {
		t.Fatalf("false change: %s", changed)
	}
	if err := workspace.ForceDestroy(ctx, info); err != nil {
		t.Fatal(err)
	}
	// Use a different cone in a newly created worktree. Replay must expand it
	// before cherry-pick, then leave every changed byte physically readable.
	cfg.Path, cfg.SparseCheckout = info.Path, []string{"untouched"}
	restored, err := workspace.Restore(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := workspace.ApplyPreserved(ctx, restored, ref); err != nil {
		t.Fatal(err)
	}
	for name, data := range want {
		got, err := os.ReadFile(filepath.Join(restored.Path, name))
		if err != nil || string(got) != data {
			t.Errorf("%q bytes=%q err=%v", name, got, err)
		}
	}
	for _, name := range []string{"keep/delete.txt", "keep/rename.txt", "keep/transient.txt"} {
		if _, err := os.Lstat(filepath.Join(restored.Path, name)); !os.IsNotExist(err) {
			t.Errorf("deletion %q not restored: %v", name, err)
		}
	}
	if target, err := os.Readlink(filepath.Join(restored.Path, "outside/link")); err != nil || target != "../keep/input.json" {
		t.Fatalf("symlink=%q %v", target, err)
	}
	if data, err := os.ReadFile(filepath.Join(restored.Path, "untouched/hidden.txt")); err != nil || string(data) != "must survive" {
		t.Fatalf("unmaterialized path was deleted: %q %v", data, err)
	}
}

func TestPreserveAssertionFailureRetainsWorktreeAndPriorRef(t *testing.T) {
	for _, kind := range []string{"names", "bytes"} {
		t.Run(kind, func(t *testing.T) {
			_, _, workspace := newSparseRepoFixture(t)
			ctx := context.Background()
			info, err := workspace.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "assert-1", Branch: "feature/assert", BaseBranch: "main", SparseCheckout: []string{"keep"}})
			if err != nil {
				t.Fatal(err)
			}
			writeSparseFile(t, info.Path, "keep/input.json", "first save")
			ref, err := workspace.StashUncommitted(ctx, info)
			if err != nil {
				t.Fatal(err)
			}
			prior := runGitTest(t, info.Path, "rev-parse", ref)
			writeSparseFile(t, info.Path, "keep/input.json", "second save")
			originalRun := workspace.run
			// Deterministic real-Git race: alter the worktree immediately before
			// read-tree seeds the temporary index, after the snapshot was captured.
			workspace.run = func(ctx context.Context, binary string, args ...string) ([]byte, error) {
				out, err := originalRun(ctx, binary, args...)
				if len(args) == 4 && args[2] == "rev-parse" && args[3] == "--verify" {
					t.Fatal("unexpected args")
				}
				if len(args) == 5 && args[2] == "rev-parse" && args[3] == "--verify" && args[4] == "HEAD" {
					if kind == "names" {
						// A status-to-add race that removes an expected new path changes
						// the resulting name/status set, rather than only its bytes.
						if err := os.Remove(filepath.Join(info.Path, "keep/input.json")); err != nil {
							t.Fatal(err)
						}
					} else {
						writeSparseFile(t, info.Path, "keep/input.json", "third writer")
					}
				}
				return out, err
			}
			got, err := workspace.StashUncommitted(ctx, info)
			if err == nil || got != "" || !strings.Contains(err.Error(), "worktree retained") {
				t.Fatalf("assertion did not fail closed: %q %v", got, err)
			}
			if _, err := os.Stat(info.Path); err != nil {
				t.Fatal("worktree removed", err)
			}
			if current := runGitTest(t, info.Path, "rev-parse", ref); current != prior {
				t.Fatal("prior preserve ref overwritten")
			}
		})
	}
}

func TestPreserveGitModeConfiguration(t *testing.T) {
	for _, test := range []struct {
		name     string
		symlinks bool
		wantMode string
	}{
		{"untracked_executable_filemode_false", false, "100644"},
		{"tracked_symlink_as_regular_file", true, "120000"},
	} {
		t.Run(test.name, func(t *testing.T) {
			repo, _, workspace := newSparseRepoFixture(t)
			name := "keep/mode-file"
			if test.symlinks {
				if err := os.Symlink("old-target", filepath.Join(repo, name)); err != nil {
					t.Fatal(err)
				}
				runGitTest(t, repo, "add", ".")
				runGitTest(t, repo, "commit", "-m", "symlink fixture")
				runGitTest(t, repo, "config", "core.symlinks", "false")
			}
			ctx := context.Background()
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "mode-1", Branch: "feature/mode", BaseBranch: "main", SparseCheckout: []string{"keep"}}
			info, err := workspace.Create(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			runGitTest(t, info.Path, "config", "core.fileMode", "false")
			writeSparseFile(t, info.Path, name, "new-target")
			if err := os.Chmod(filepath.Join(info.Path, name), 0755); err != nil {
				t.Fatal(err)
			}
			ref, err := workspace.StashUncommitted(ctx, info)
			if err != nil || ref == "" {
				t.Fatalf("preserve %q: %v", ref, err)
			}
			entry := runGitTest(t, info.Path, "ls-tree", ref, "--", name)
			if !strings.HasPrefix(entry, test.wantMode+" ") {
				t.Fatalf("git mode=%s want %s", entry, test.wantMode)
			}
			if err := workspace.ForceDestroy(ctx, info); err != nil {
				t.Fatal(err)
			}
			cfg.Path = info.Path
			restored, err := workspace.Restore(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := workspace.ApplyPreserved(ctx, restored, ref); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(restored.Path, name))
			if err != nil || string(data) != "new-target" {
				t.Fatalf("bytes %q: %v", data, err)
			}
		})
	}
}

func TestPreserveFileDirectoryTransitions(t *testing.T) {
	for _, direction := range []string{"file_to_directory", "directory_to_file"} {
		t.Run(direction, func(t *testing.T) {
			repo, _, workspace := newSparseRepoFixture(t)
			name := "keep/transition"
			if direction == "directory_to_file" {
				name += "/child"
			}
			writeSparseFile(t, repo, name, "old")
			runGitTest(t, repo, "add", ".")
			runGitTest(t, repo, "commit", "-m", "type fixture")
			ctx := context.Background()
			cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "type-1", Branch: "feature/type", BaseBranch: "main", SparseCheckout: []string{"keep"}}
			info, err := workspace.Create(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.RemoveAll(filepath.Join(info.Path, "keep/transition")); err != nil {
				t.Fatal(err)
			}
			name = "keep/transition"
			if direction == "file_to_directory" {
				name += "/child"
			}
			writeSparseFile(t, info.Path, name, "new")
			ref, err := workspace.StashUncommitted(ctx, info)
			if err != nil || ref == "" {
				t.Fatalf("preserve %q: %v", ref, err)
			}
			if err := workspace.ForceDestroy(ctx, info); err != nil {
				t.Fatal(err)
			}
			cfg.Path = info.Path
			restored, err := workspace.Restore(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			if err := workspace.ApplyPreserved(ctx, restored, ref); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(filepath.Join(restored.Path, name))
			if err != nil || string(data) != "new" {
				t.Fatalf("bytes %q: %v", data, err)
			}
		})
	}
}

func TestPreserveUnknownHEADRetainsWorktree(t *testing.T) {
	_, _, workspace := newSparseRepoFixture(t)
	ctx := context.Background()
	info, err := workspace.Create(ctx, ports.WorkspaceConfig{ProjectID: "project", SessionID: "head-1", Branch: "feature/head", BaseBranch: "main", SparseCheckout: []string{"keep"}})
	if err != nil {
		t.Fatal(err)
	}
	writeSparseFile(t, info.Path, "keep/new.txt", "first")
	ref, err := workspace.StashUncommitted(ctx, info)
	if err != nil {
		t.Fatal(err)
	}
	prior := runGitTest(t, info.Path, "rev-parse", ref)
	writeSparseFile(t, info.Path, "keep/new.txt", "second")
	// Inject a real executable failure at exactly the HEAD probe; every other
	// operation still runs real git. Existing HEAD must not become unborn.
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	wrapper := filepath.Join(t.TempDir(), "git-fail-head")
	source := fmt.Sprintf("#!/bin/sh\nif [ \"$3\" = rev-parse ] && [ \"$4\" = --verify ] && [ \"$5\" = HEAD ]; then exit 77; fi\nexec %q \"$@\"\n", realGit)
	if err := os.WriteFile(wrapper, []byte(source), 0755); err != nil {
		t.Fatal(err)
	}
	workspace.binary = wrapper
	got, err := workspace.StashUncommitted(ctx, info)
	if err == nil || got != "" || !strings.Contains(err.Error(), "cannot establish preserve HEAD") {
		t.Fatalf("unknown HEAD accepted: %q %v", got, err)
	}
	if current := runGitTest(t, info.Path, "rev-parse", ref); current != prior {
		t.Fatal("prior ref changed")
	}
	if data, err := os.ReadFile(filepath.Join(info.Path, "keep/new.txt")); err != nil || string(data) != "second" {
		t.Fatalf("worktree bytes changed: %q %v", data, err)
	}
}

func TestPreserveProvenUnbornHEAD(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	if err := os.Mkdir(repo, 0755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repo, "init", "--initial-branch=main")
	runGitTest(t, repo, "config", "user.name", "AO Test")
	runGitTest(t, repo, "config", "user.email", "ao@example.invalid")
	workspace, err := New(Options{ManagedRoot: root, RepoResolver: StaticRepoResolver{"project": repo}})
	if err != nil {
		t.Fatal(err)
	}
	writeSparseFile(t, repo, "new.txt", "unborn")
	ref, err := workspace.StashUncommitted(context.Background(), ports.WorkspaceInfo{ProjectID: "project", SessionID: "unborn-1", Path: repo})
	if err != nil || ref == "" {
		t.Fatalf("unborn preserve %q: %v", ref, err)
	}
	if got := runGitTest(t, repo, "show", ref+":new.txt"); got != "unborn" {
		t.Fatalf("unborn bytes %q", got)
	}
	if parents := runGitTest(t, repo, "show", "-s", "--format=%P", ref); parents != "" {
		t.Fatalf("unborn parent %q", parents)
	}
}
