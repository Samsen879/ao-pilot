package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestEnsureCapacityRejectsCheckoutBelowReserve(t *testing.T) {
	w := &Workspace{
		capacityPath: "/capacity",
		minFreeBytes: 32,
		availableBytes: func(path string) (uint64, error) {
			if path != "/capacity" {
				t.Fatalf("capacity path = %q", path)
			}
			return 31, nil
		},
	}
	if err := w.ensureCapacity(0); !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("ensureCapacity error = %v, want ErrWorkspaceInsufficientSpace", err)
	}
}

func TestRestoreChecksCapacityBeforeMovingStrayPath(t *testing.T) {
	repo := t.TempDir()
	managed := filepath.Join(t.TempDir(), "worktrees")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(managed, "project", "project-1")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	wantFile := filepath.Join(target, "keep.txt")
	if err := os.WriteFile(wantFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	w, err := New(Options{
		ManagedRoot:  managed,
		RepoResolver: StaticRepoResolver{domain.ProjectID("project"): repo},
		CapacityPath: managed,
		MinFreeBytes: 32,
	})
	if err != nil {
		t.Fatal(err)
	}
	w.availableBytes = func(string) (uint64, error) { return 31, nil }
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\n"), nil
		case strings.Contains(joined, "ls-tree"):
			return []byte("100644 blob abc 4\tkeep.txt\x00"), nil
		default:
			return nil, nil
		}
	}

	_, err = w.Restore(context.Background(), ports.WorkspaceConfig{
		ProjectID: "project", SessionID: "project-1", Kind: domain.KindWorker,
		Branch: "ao/project-1/root", Path: target,
	})
	if !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("Restore error = %v, want ErrWorkspaceInsufficientSpace", err)
	}
	if data, readErr := os.ReadFile(wantFile); readErr != nil || string(data) != "keep" {
		t.Fatalf("stray path moved before capacity rejection: data=%q err=%v", data, readErr)
	}
	matches, globErr := filepath.Glob(target + ".stray*")
	if globErr != nil || len(matches) != 0 {
		t.Fatalf("unexpected stray paths after rejection: %v, %v", matches, globErr)
	}
}

func TestRollbackWorkspaceProjectReposDeletesCreatedBranches(t *testing.T) {
	w := &Workspace{binary: "git", run: func(_ context.Context, _ string, args ...string) ([]byte, error) {
		return nil, nil
	}}
	root := t.TempDir()
	child := t.TempDir()
	created := []workspaceProjectRepo{
		{repoPath: "/repo/root", outputPath: root},
		{repoPath: "/repo/child", outputPath: child},
	}
	var calls []string
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		calls = append(calls, strings.Join(args, " "))
		return nil, nil
	}
	if err := w.rollbackWorkspaceProjectRepos(context.Background(), created, "ao/project-1/root"); err != nil {
		t.Fatal(err)
	}
	for _, repo := range []string{"/repo/root", "/repo/child"} {
		want := repo + " update-ref -d refs/heads/ao/project-1/root"
		if !slices.ContainsFunc(calls, func(call string) bool { return strings.Contains(call, want) }) {
			t.Fatalf("calls %v missing branch cleanup %q", calls, want)
		}
	}
}

func TestEnsureCapacityDisabledDoesNotProbe(t *testing.T) {
	w := &Workspace{availableBytes: func(string) (uint64, error) {
		t.Fatal("disabled capacity guard probed filesystem")
		return 0, nil
	}}
	if err := w.ensureCapacity(123); err != nil {
		t.Fatalf("ensureCapacity error = %v", err)
	}
}

func TestEnsureCapacityIncludesEstimatedCheckout(t *testing.T) {
	w := &Workspace{
		capacityPath: "/capacity",
		minFreeBytes: 32,
		availableBytes: func(string) (uint64, error) {
			return 36, nil
		},
	}
	if err := w.ensureCapacity(5); !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("ensureCapacity error = %v, want checkout estimate to preserve reserve", err)
	}
}

func TestEstimateCheckoutRejectsFiltersBeforeLsTree(t *testing.T) {
	lsTreeCalled := false
	w := &Workspace{
		binary:       "git",
		capacityPath: "/capacity",
		minFreeBytes: 32,
		availableBytes: func(string) (uint64, error) {
			return 1 << 40, nil
		},
	}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "rev-parse --verify --quiet refs/heads/feature") {
			return []byte("abc\n"), nil
		}
		if strings.Contains(joined, " grep ") {
			return []byte(".gitattributes:1:*.bin filter=lfs\n"), nil
		}
		if strings.Contains(joined, " ls-tree ") {
			lsTreeCalled = true
		}
		return nil, nil
	}
	_, err := w.estimateCheckoutBytes(context.Background(), "/repo", "feature", "main")
	if !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("estimateCheckoutBytes error = %v, want fail-closed capacity error", err)
	}
	if lsTreeCalled {
		t.Fatal("ls-tree ran after checkout filter was detected")
	}
}

func TestEstimateCheckoutIgnoresUnusedGlobalFilterDriver(t *testing.T) {
	w := &Workspace{
		binary:         "git",
		capacityPath:   "/capacity",
		minFreeBytes:   32,
		availableBytes: func(string) (uint64, error) { return 1 << 40, nil },
	}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "config --get-regexp"):
			return nil, nil
		case strings.Contains(joined, "config --get core."):
			return nil, nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/feature"):
			return []byte("abc\n"), nil
		case strings.Contains(joined, " grep "):
			return nil, nil
		case strings.Contains(joined, "ls-tree"):
			return []byte("100644 blob abc 4\tfile\x00"), nil
		default:
			return nil, nil
		}
	}
	if _, err := w.estimateCheckoutBytes(context.Background(), "/repo", "feature", "main"); err != nil {
		t.Fatalf("unused global filter rejected checkout: %v", err)
	}
}

func TestEstimateCheckoutRejectsAutoCRLFExpansion(t *testing.T) {
	w := &Workspace{
		binary:         "git",
		capacityPath:   "/capacity",
		minFreeBytes:   32,
		availableBytes: func(string) (uint64, error) { return 1 << 40, nil },
	}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "config --get-regexp"):
			return nil, nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/feature"):
			return []byte("abc\n"), nil
		case strings.Contains(joined, "config --get core.autocrlf"):
			return []byte("true\n"), nil
		default:
			return nil, nil
		}
	}
	_, err := w.estimateCheckoutBytes(context.Background(), "/repo", "feature", "main")
	if !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("estimateCheckoutBytes error = %v, want autocrlf rejection", err)
	}
}

func TestEstimateCheckoutAccountsForTinyFiles(t *testing.T) {
	w := &Workspace{binary: "git", minFreeBytes: 1, availableBytes: func(string) (uint64, error) { return 1 << 40, nil }}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/feature"):
			return []byte("abc\n"), nil
		case strings.Contains(joined, "ls-tree"):
			return []byte("100644 blob abc 1\ta\x00100644 blob def 1\tb\x00"), nil
		default:
			return nil, nil
		}
	}
	estimate, err := w.estimateCheckoutBytes(context.Background(), "/missing", "feature", "main")
	if err != nil {
		t.Fatal(err)
	}
	want := uint64(2 + 2*(64<<10) + checkoutMetadataHeadroom)
	if estimate != want {
		t.Fatalf("estimate=%d want=%d", estimate, want)
	}
}

func TestRejectCheckoutTransformsChecksExternalAttributes(t *testing.T) {
	repo := t.TempDir()
	path := filepath.Join(repo, "attributes")
	if err := os.WriteFile(path, []byte("*.txt filter=expand\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w := &Workspace{binary: "git"}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "rev-parse --git-path info/attributes") {
			return []byte(path + "\n"), nil
		}
		return nil, nil
	}
	if err := w.rejectCheckoutTransforms(context.Background(), repo, "HEAD"); !errors.Is(err, ports.ErrWorkspaceInsufficientSpace) {
		t.Fatalf("external attributes error=%v", err)
	}
}

func TestNativeWindowsEOLRejectsPlainTextAttributes(t *testing.T) {
	line := "*.txt text"
	for _, tc := range []struct {
		goos, eol string
		want      bool
	}{
		{"windows", "", true},
		{"windows", "native", true},
		{"windows", "lf", false},
		{"linux", "", false},
	} {
		matched, err := regexp.MatchString(checkoutExpandingAttributePattern(tc.goos, tc.eol), line)
		if err != nil || matched != tc.want {
			t.Fatalf("%s/%s matched=%v want=%v err=%v", tc.goos, tc.eol, matched, tc.want, err)
		}
	}
}

func TestEstimateCheckoutPrefersExistingLocalBranch(t *testing.T) {
	var estimatedRef string
	w := &Workspace{
		binary:       "git",
		capacityPath: "/capacity",
		minFreeBytes: 32,
		availableBytes: func(string) (uint64, error) {
			return 1 << 40, nil
		},
	}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "config --get-regexp"):
			return nil, nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/feature"):
			return []byte("abc\n"), nil
		case strings.Contains(joined, "ls-tree"):
			estimatedRef = args[len(args)-1]
			return []byte("100644 blob abc 4\tfile\x00"), nil
		default:
			return nil, nil
		}
	}
	if _, err := w.estimateCheckoutBytes(context.Background(), "/repo", "feature", "main"); err != nil {
		t.Fatal(err)
	}
	if estimatedRef != "refs/heads/feature" {
		t.Fatalf("estimated ref = %q, want local branch", estimatedRef)
	}
}
