package gitworktree

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func runGitTest(t *testing.T, cwd string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = cwd
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestCreateMaterializesConfiguredSparseCheckout(t *testing.T) {
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	managed := filepath.Join(root, "worktrees")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repo, "init", "--initial-branch=main")
	runGitTest(t, repo, "config", "user.name", "AO Test")
	runGitTest(t, repo, "config", "user.email", "ao@example.com")
	if err := os.MkdirAll(filepath.Join(repo, "keep"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repo, "omit"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string]string{
		"README.md":       "root files stay available\n",
		"keep/input.json": "{}\n",
		"omit/large.bin":  "must remain absent\n",
	} {
		if err := os.WriteFile(filepath.Join(repo, name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	runGitTest(t, repo, "add", ".")
	runGitTest(t, repo, "commit", "-m", "seed")

	projectID := domain.ProjectID("project")
	workspace, err := New(Options{
		ManagedRoot:  managed,
		RepoResolver: StaticRepoResolver{projectID: repo},
	})
	if err != nil {
		t.Fatal(err)
	}
	info, err := workspace.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID:      projectID,
		SessionID:      domain.SessionID("project-1"),
		Kind:           domain.KindWorker,
		Branch:         "feature/sparse",
		BaseBranch:     "main",
		SparseCheckout: []string{"keep"},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{"README.md", "keep/input.json"} {
		if _, err := os.Stat(filepath.Join(info.Path, expected)); err != nil {
			t.Fatalf("expected sparse path %s: %v", expected, err)
		}
	}
	if _, err := os.Stat(filepath.Join(info.Path, "omit", "large.bin")); !os.IsNotExist(err) {
		t.Fatalf("omitted path was materialized: %v", err)
	}
	if got := runGitTest(t, info.Path, "sparse-checkout", "list"); got != "keep" {
		t.Fatalf("sparse-checkout list=%q want keep", got)
	}
	if got := runGitTest(t, info.Path, "status", "--porcelain"); got != "" {
		t.Fatalf("sparse worktree is dirty: %s", got)
	}
}

func TestNestedConeIncludesAncestorFilesInCapacityEstimate(t *testing.T) {
	for _, name := range []string{"README.md", "src/large.bin", "src/deep/middle.bin", "src/deep/keep/input.json"} {
		if !sparseCheckoutContains(name, []string{"src/deep/keep"}) {
			t.Errorf("materialized ancestor %s omitted", name)
		}
	}
	if sparseCheckoutContains("src/other/large.bin", []string{"src/deep/keep"}) {
		t.Fatal("unrelated subtree included")
	}
}

func TestOptionNamedSparseDirectoryIsMaterialized(t *testing.T) {
	repo, _, workspace := newSparseRepoFixture(t)
	writeSparseFile(t, repo, "--stdin/input.json", "literal option directory")
	runGitTest(t, repo, "add", ".")
	runGitTest(t, repo, "commit", "-m", "option directory")
	info, err := workspace.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID: "project", SessionID: "literal-1", Branch: "feature/literal", BaseBranch: "main", SparseCheckout: []string{"--stdin"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(info.Path, "--stdin/input.json")); err != nil || string(data) != "literal option directory" {
		t.Fatalf("literal directory lost: %q %v", data, err)
	}
}

func newSparseRepoFixture(t *testing.T) (string, string, *Workspace) {
	t.Helper()
	root := t.TempDir()
	repo, managed := filepath.Join(root, "repo"), filepath.Join(root, "worktrees")
	if err := os.MkdirAll(repo, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(managed, 0755); err != nil {
		t.Fatal(err)
	}
	runGitTest(t, repo, "init", "--initial-branch=main")
	runGitTest(t, repo, "config", "user.name", "AO Test")
	runGitTest(t, repo, "config", "user.email", "ao@example.com")
	for name, data := range map[string]string{"README.md": "root", "keep/input.json": "{}", "outside/edited.txt": "original", "outside/deleted.txt": "delete later", "untouched/hidden.txt": "must survive"} {
		writeSparseFile(t, repo, name, data)
	}
	runGitTest(t, repo, "add", ".")
	runGitTest(t, repo, "commit", "-m", "seed")
	workspace, err := New(Options{ManagedRoot: managed, RepoResolver: StaticRepoResolver{"project": repo}})
	if err != nil {
		t.Fatal(err)
	}
	return repo, managed, workspace
}

func writeSparseFile(t *testing.T, root, name, content string) {
	t.Helper()
	target := filepath.Join(root, name)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreMaterializesPreservedChangesOutsideNarrowedCone(t *testing.T) {
	_, _, workspace := newSparseRepoFixture(t)
	ctx := context.Background()
	cfg := ports.WorkspaceConfig{ProjectID: "project", SessionID: "sparse-1", Branch: "feature/preserve", BaseBranch: "main", SparseCheckout: []string{"keep", "outside"}}
	info, err := workspace.Create(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	writeSparseFile(t, info.Path, "outside/edited.txt", "edited WIP")
	writeSparseFile(t, info.Path, "outside/new.txt", "new WIP")
	if err := os.Remove(filepath.Join(info.Path, "outside/deleted.txt")); err != nil {
		t.Fatal(err)
	}
	ref, err := workspace.StashUncommitted(ctx, info)
	if err != nil || ref == "" {
		t.Fatalf("preserve=%s %v", ref, err)
	}
	if err := workspace.ForceDestroy(ctx, info); err != nil {
		t.Fatal(err)
	}
	cfg.Path, cfg.SparseCheckout = info.Path, []string{"keep"}
	restored, err := workspace.Restore(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(restored.Path, "outside/edited.txt")); !os.IsNotExist(err) {
		t.Fatalf("restore fixture not sparse: %v", err)
	}
	workspace.minFreeBytes = 1
	workspace.capacityPath = restored.Path
	workspace.availableBytes = func(string) (uint64, error) { return 1, nil }
	if err := workspace.ApplyPreserved(ctx, restored, ref); !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("cone expansion bypassed reserve: %v", err)
	}
	runGitTest(t, restored.Path, "rev-parse", "--verify", ref)
	workspace.availableBytes = func(string) (uint64, error) { return 1 << 40, nil }
	if err := workspace.ApplyPreserved(ctx, restored, ref); err != nil {
		t.Fatal(err)
	}
	if got := runGitTest(t, restored.Path, "show", ":untouched/hidden.txt"); got != "must survive" {
		t.Fatalf("unrelated hidden file lost: %q", got)
	}
	for name, want := range map[string]string{"outside/edited.txt": "edited WIP", "outside/new.txt": "new WIP"} {
		got, err := os.ReadFile(filepath.Join(restored.Path, name))
		if err != nil || string(got) != want {
			t.Fatalf("restored %s = %q %v", name, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(restored.Path, "outside/deleted.txt")); !os.IsNotExist(err) {
		t.Fatalf("deleted WIP reappeared: %v", err)
	}
	if status := runGitTest(t, restored.Path, "status", "--porcelain"); !strings.Contains(status, "outside/new.txt") || !strings.Contains(status, "outside/edited.txt") {
		t.Fatalf("WIP not retained: %s", status)
	}
}

func TestCapacityEstimateCountsRealNestedConeCheckout(t *testing.T) {
	repo, _, workspace := newSparseRepoFixture(t)
	for name, data := range map[string]string{"src/large.bin": strings.Repeat("x", 128<<10), "src/deep/middle.txt": "middle", "src/deep/keep/input.json": "{}", "src/other/omitted.bin": "omit"} {
		writeSparseFile(t, repo, name, data)
	}
	runGitTest(t, repo, "add", ".")
	runGitTest(t, repo, "commit", "-m", "nested fixture")
	workspace.minFreeBytes = 1
	workspace.capacityPath = repo
	workspace.availableBytes = func(string) (uint64, error) { return 1 << 40, nil }
	estimate, err := workspace.estimateCheckoutBytes(context.Background(), repo, "feature/nested", "main", []string{"src/deep/keep"})
	if err != nil {
		t.Fatal(err)
	}
	total := uint64(len("root") + (128 << 10) + len("middle") + len("{}"))
	want := total + checkoutMetadataHeadroom + 4*(64<<10) + total/10
	if estimate != want {
		t.Fatalf("estimate=%d want=%d including all cone ancestor files", estimate, want)
	}
	workspace.availableBytes = func(string) (uint64, error) { return want, nil }
	if err := workspace.ensureCapacity(estimate); err == nil {
		t.Fatal("checkout consumed configured reserve")
	}
}
