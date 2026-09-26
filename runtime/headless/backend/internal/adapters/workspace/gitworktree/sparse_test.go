package gitworktree

import (
	"context"
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
