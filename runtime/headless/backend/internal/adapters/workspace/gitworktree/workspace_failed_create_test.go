package gitworktree

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestFailedCreateCleanupContextGetsFreshDeadline(t *testing.T) {
	parent, cancelParent := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancelParent()
	<-parent.Done()

	cleanup, cancelCleanup := failedCreateCleanupContext(parent)
	defer cancelCleanup()
	if err := cleanup.Err(); err != nil {
		t.Fatalf("cleanup context inherited expired deadline: %v", err)
	}
	deadline, ok := cleanup.Deadline()
	if !ok || time.Until(deadline) <= 0 {
		t.Fatalf("cleanup deadline = %v, %v; want fresh future deadline", deadline, ok)
	}
}

func TestCreateRollsBackInterruptedInitializingWorktree(t *testing.T) {
	repo := t.TempDir()
	managed := filepath.Join(t.TempDir(), "worktrees")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(Options{
		ManagedRoot: managed,
		RepoResolver: StaticRepoResolver{
			domain.ProjectID("project"): repo,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	wantPath := filepath.Join(managed, "project", "project-1")
	partial := false
	createToken := ""
	var calls [][]string
	w.run = func(runCtx context.Context, _ string, args ...string) ([]byte, error) {
		calls = append(calls, slices.Clone(args))
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format --branch"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			out := "worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\n"
			if partial {
				out += "worktree " + wantPath + "\nHEAD def\nbranch refs/heads/ao/project-1/root\nlocked " + createToken + "\n\n"
			}
			return []byte(out), nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/ao/project-1/root"):
			return []byte("def\n"), nil
		case strings.Contains(joined, "worktree add"):
			for i, arg := range args {
				if arg == "--reason" && i+1 < len(args) {
					createToken = args[i+1]
				}
			}
			partial = true
			cancel()
			return nil, context.Canceled
		case strings.Contains(joined, "worktree unlock"):
			if runCtx.Err() != nil {
				t.Fatalf("rollback inherited cancelled request context: %v", runCtx.Err())
			}
			return nil, nil
		case strings.Contains(joined, "worktree remove --force"):
			partial = false
			return nil, nil
		default:
			t.Fatalf("unexpected git call: %v", args)
			return nil, nil
		}
	}

	info, err := w.Create(ctx, ports.WorkspaceConfig{
		ProjectID: "project",
		SessionID: "project-1",
		Kind:      domain.KindWorker,
		Branch:    "ao/project-1/root",
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Create error = %v, want context.Canceled", err)
	}
	if info.Path != "" {
		t.Fatalf("Create returned custody %+v after successful rollback", info)
	}
	joinedCalls := make([]string, 0, len(calls))
	for _, call := range calls {
		joinedCalls = append(joinedCalls, strings.Join(call, " "))
	}
	if !slices.ContainsFunc(joinedCalls, func(call string) bool { return strings.Contains(call, "worktree unlock "+wantPath) }) {
		t.Fatalf("calls %v did not unlock interrupted worktree", joinedCalls)
	}
	if !slices.ContainsFunc(joinedCalls, func(call string) bool { return strings.Contains(call, "worktree remove --force "+wantPath) }) {
		t.Fatalf("calls %v did not remove interrupted worktree", joinedCalls)
	}
	if slices.ContainsFunc(joinedCalls, func(call string) bool { return strings.Contains(call, "worktree prune") }) {
		t.Fatalf("calls %v pruned unrelated worktrees", joinedCalls)
	}
}

func TestCreateReturnsCustodyWhenInterruptedWorktreeCleanupFails(t *testing.T) {
	repo := t.TempDir()
	managed := filepath.Join(t.TempDir(), "worktrees")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(Options{
		ManagedRoot: managed,
		RepoResolver: StaticRepoResolver{
			domain.ProjectID("project"): repo,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	wantPath := filepath.Join(managed, "project", "project-1")
	partial := false
	createToken := ""
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format --branch"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			out := "worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\n"
			if partial {
				out += "worktree " + wantPath + "\nHEAD def\nbranch refs/heads/ao/project-1/root\nlocked " + createToken + "\n\n"
			}
			return []byte(out), nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/ao/project-1/root"):
			return []byte("def\n"), nil
		case strings.Contains(joined, "worktree add"):
			for i, arg := range args {
				if arg == "--reason" && i+1 < len(args) {
					createToken = args[i+1]
				}
			}
			partial = true
			return nil, errors.New("checkout interrupted")
		case strings.Contains(joined, "worktree unlock"):
			return nil, errors.New("unlock failed")
		default:
			t.Fatalf("unexpected git call: %v", args)
			return nil, nil
		}
	}

	info, err := w.Create(context.Background(), ports.WorkspaceConfig{
		ProjectID: "project",
		SessionID: "project-1",
		Kind:      domain.KindWorker,
		Branch:    "ao/project-1/root",
	})
	if err == nil || !strings.Contains(err.Error(), "unlock failed") {
		t.Fatalf("Create error = %v, want cleanup failure", err)
	}
	if info.Path != wantPath || info.Branch != "ao/project-1/root" {
		t.Fatalf("Create custody = %+v, want retained worktree %q", info, wantPath)
	}
}

func TestCreatePreservesUnregisteredDirectoryAfterAddFailure(t *testing.T) {
	repo := t.TempDir()
	managed := filepath.Join(t.TempDir(), "worktrees")
	if err := os.MkdirAll(managed, 0o755); err != nil {
		t.Fatal(err)
	}
	w, err := New(Options{ManagedRoot: managed, RepoResolver: StaticRepoResolver{domain.ProjectID("project"): repo}})
	if err != nil {
		t.Fatal(err)
	}
	wantPath := filepath.Join(managed, "project", "project-1")
	if err := os.MkdirAll(wantPath, 0o755); err != nil {
		t.Fatal(err)
	}
	wantFile := filepath.Join(wantPath, "keep.txt")
	if err := os.WriteFile(wantFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "check-ref-format --branch"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\n"), nil
		case strings.Contains(joined, "rev-parse --verify --quiet refs/heads/ao/project-1/root"):
			return []byte("def\n"), nil
		case strings.Contains(joined, "worktree add"):
			return nil, errors.New("path already exists")
		default:
			return nil, nil
		}
	}

	_, err = w.Create(context.Background(), ports.WorkspaceConfig{ProjectID: "project", SessionID: "project-1", Kind: domain.KindWorker, Branch: "ao/project-1/root"})
	if err == nil || !strings.Contains(err.Error(), "path is not registered") {
		t.Fatalf("Create error = %v, want preserved unregistered path", err)
	}
	data, readErr := os.ReadFile(wantFile)
	if readErr != nil || string(data) != "keep" {
		t.Fatalf("preserved file = %q, %v", data, readErr)
	}
}

func TestFailedCreateNeverRemovesConcurrentCreator(t *testing.T) {
	repo := t.TempDir()
	path := filepath.Join(t.TempDir(), "foreign-worktree")
	w := &Workspace{binary: "git"}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		if strings.Contains(joined, "worktree list --porcelain") {
			return []byte("worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\nworktree " + path + "\nHEAD def\nbranch refs/heads/feature\nlocked ao-create-other-invocation\n\n"), nil
		}
		t.Fatalf("foreign registration was mutated: %v", args)
		return nil, nil
	}
	retained, err := w.rollbackFailedCreate(context.Background(), repo, path, "ao-create-this-invocation")
	if retained || err == nil || !strings.Contains(err.Error(), "ownership marker") {
		t.Fatalf("retained=%v err=%v", retained, err)
	}
}

func TestFailedCreateInspectionFailureRetainsCustody(t *testing.T) {
	w := &Workspace{binary: "git"}
	w.run = func(context.Context, string, ...string) ([]byte, error) {
		return nil, errors.New("worktree list unavailable")
	}
	retained, err := w.rollbackFailedCreate(context.Background(), t.TempDir(), filepath.Join(t.TempDir(), "partial"), "ao-create-test")
	if !retained || err == nil {
		t.Fatalf("retained=%v err=%v; want unknown registration retained", retained, err)
	}
}

func TestOwnedRollbackPreservesLaterExternalLock(t *testing.T) {
	repo := t.TempDir()
	path := filepath.Join(t.TempDir(), "locked-worktree")
	w := &Workspace{binary: "git"}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		if strings.Contains(strings.Join(args, " "), "worktree list --porcelain") {
			return []byte("worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\nworktree " + path + "\nHEAD def\nbranch refs/heads/feature\nlocked operator-lock\n\n"), nil
		}
		t.Fatalf("external lock was mutated: %v", args)
		return nil, nil
	}
	retained, err := w.rollbackOwnedWorktree(context.Background(), repo, path, "feature", "ao-create-original")
	if !retained || err == nil || !strings.Contains(err.Error(), "ownership lock differs") {
		t.Fatalf("retained=%v err=%v", retained, err)
	}
}

func TestRollbackDoesNotDeletePathAfterRegistrationDisappears(t *testing.T) {
	repo := t.TempDir()
	path := filepath.Join(t.TempDir(), "new-owner")
	if err := os.Mkdir(path, 0o755); err != nil {
		t.Fatal(err)
	}
	wantFile := filepath.Join(path, "keep.txt")
	if err := os.WriteFile(wantFile, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := &Workspace{binary: "git"}
	w.run = func(_ context.Context, _ string, args ...string) ([]byte, error) {
		joined := strings.Join(args, " ")
		switch {
		case strings.Contains(joined, "worktree remove --force"):
			return nil, nil
		case strings.Contains(joined, "worktree list --porcelain"):
			return []byte("worktree " + repo + "\nHEAD abc\nbranch refs/heads/main\n\n"), nil
		default:
			t.Fatalf("unexpected git call: %v", args)
			return nil, nil
		}
	}
	retained, err := w.rollbackRegisteredWorktree(context.Background(), repo, path, false)
	if retained || err == nil {
		t.Fatalf("retained=%v err=%v", retained, err)
	}
	if data, err := os.ReadFile(wantFile); err != nil || string(data) != "keep" {
		t.Fatalf("racing path content=%q err=%v", data, err)
	}
}
