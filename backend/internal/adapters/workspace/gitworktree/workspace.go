package gitworktree

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
	"github.com/google/uuid"
)

const (
	defaultGitBinary = "git"
	// defaultBranch is the base branch used when neither the per-project config
	// nor the adapter options name one. It shares domain's single source of truth.
	defaultBranch              = domain.DefaultBranchName
	failedCreateCleanupTimeout = 30 * time.Second
)

// ErrUnsafePath is returned when a resolved worktree path escapes the managed
// root (path traversal guard).
var (
	ErrUnsafePath = errors.New("gitworktree: unsafe workspace path")
)

// ErrPreservedConflict is an adapter-local alias of ports.ErrPreservedConflict.
// Tests inside this package use this name; callers outside use ports.ErrPreservedConflict
// and errors.Is works because the adapter wraps the ports sentinel.
var ErrPreservedConflict = ports.ErrPreservedConflict

// ErrBranchCheckedOutElsewhere and ErrBranchNotFetched are adapter-local aliases
// of the port-level sentinels: they preserve the gitworktree-prefixed message
// while letting the service layer match on ports.ErrWorkspaceBranchCheckedOutElsewhere
// / ports.ErrWorkspaceBranchNotFetched without importing this package. Tests
// inside the adapter use these names; callers outside use the port sentinels.
var (
	ErrBranchCheckedOutElsewhere = ports.ErrWorkspaceBranchCheckedOutElsewhere
	ErrBranchNotFetched          = ports.ErrWorkspaceBranchNotFetched
	ErrBranchInvalid             = ports.ErrWorkspaceBranchInvalid
	// ErrWorktreeLocked is an adapter-local alias of ports.ErrWorkspaceLocked,
	// following the same aliasing convention as the branch sentinels above.
	ErrWorktreeLocked = ports.ErrWorkspaceLocked
)

// RepoResolver maps a project to the absolute path of its source git repo.
type RepoResolver interface {
	RepoPath(projectID domain.ProjectID) (string, error)
}

// StaticRepoResolver is a RepoResolver backed by a fixed project→repo-path map.
type StaticRepoResolver map[domain.ProjectID]string

// RepoPath returns the configured repo path for a project, or an error if none
// is configured.
func (r StaticRepoResolver) RepoPath(projectID domain.ProjectID) (string, error) {
	path := r[projectID]
	if path == "" {
		return "", fmt.Errorf("gitworktree: no repo configured for project %q", projectID)
	}
	return path, nil
}

// Options configures a gitworktree Workspace. ManagedRoot and RepoResolver are
// required; Binary and DefaultBranch fall back to defaults.
type Options struct {
	Binary        string
	ManagedRoot   string
	DefaultBranch string
	RepoResolver  RepoResolver
	// CapacityPath is the filesystem checked before a new checkout is
	// materialized. It may differ from ManagedRoot under virtualized storage.
	CapacityPath string
	// MinFreeBytes is the operator reserve for CapacityPath. Zero disables the
	// guard.
	MinFreeBytes uint64
}

// Workspace creates per-session git worktrees under a managed root. It
// implements ports.Workspace.
type Workspace struct {
	binary         string
	managedRoot    string
	defaultBranch  string
	repos          RepoResolver
	run            commandRunner
	capacityPath   string
	minFreeBytes   uint64
	availableBytes func(string) (uint64, error)
	capacityDevice uint64
	deviceIdentity func(string) (uint64, error)
	materializeMu  sync.Mutex
}

type commandRunner func(ctx context.Context, binary string, args ...string) ([]byte, error)

var _ ports.Workspace = (*Workspace)(nil)
var _ ports.WorkspaceProject = (*Workspace)(nil)

// New builds a gitworktree Workspace, validating that ManagedRoot and
// RepoResolver are set and resolving the root to an absolute, symlink-free path.
func New(opts Options) (*Workspace, error) {
	binary := opts.Binary
	if binary == "" {
		binary = defaultGitBinary
	}
	branch := opts.DefaultBranch
	if branch == "" {
		branch = defaultBranch
	}
	if opts.ManagedRoot == "" {
		return nil, errors.New("gitworktree: ManagedRoot is required")
	}
	if opts.RepoResolver == nil {
		return nil, errors.New("gitworktree: RepoResolver is required")
	}
	root, err := physicalAbs(opts.ManagedRoot)
	if err != nil {
		return nil, fmt.Errorf("gitworktree: managed root: %w", err)
	}
	capacityPath := strings.TrimSpace(opts.CapacityPath)
	if opts.MinFreeBytes > 0 {
		if capacityPath == "" {
			capacityPath = root
		}
		capacityPath, err = physicalAbs(capacityPath)
		if err != nil {
			return nil, fmt.Errorf("gitworktree: capacity path: %w", err)
		}
	}
	var capacityDevice uint64
	if opts.MinFreeBytes > 0 {
		capacityDevice, err = diskIdentity(capacityPath)
		if err != nil {
			return nil, fmt.Errorf("gitworktree: capacity filesystem: %w", err)
		}
	}
	return &Workspace{
		binary:         binary,
		managedRoot:    filepath.Clean(root),
		defaultBranch:  branch,
		repos:          opts.RepoResolver,
		run:            runCommand,
		capacityPath:   capacityPath,
		minFreeBytes:   opts.MinFreeBytes,
		availableBytes: diskAvailableBytes,
		capacityDevice: capacityDevice,
		deviceIdentity: diskIdentity,
	}, nil
}

// Create adds a git worktree for the session under the managed root, checking
// out the requested branch, and returns where it landed.
func (w *Workspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	repo, err := w.repoPath(cfg.ProjectID)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if err := w.validateBranch(ctx, repo, cfg.Branch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	path, err := w.managedPath(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if w.minFreeBytes > 0 {
		w.materializeMu.Lock()
		defer w.materializeMu.Unlock()
	}
	if info, ok, err := w.existingWorktree(ctx, repo, path, cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	} else if ok {
		return info, nil
	}
	requiredBytes, err := w.estimateCheckoutBytes(ctx, repo, cfg.Branch, cfg.BaseBranch, cfg.SparseCheckout)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if err := w.ensureCapacity(requiredBytes); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	createToken := newWorktreeCreateToken()
	if attempted, err := w.addWorktree(ctx, repo, path, cfg.Branch, cfg.BaseBranch, cfg.SparseCheckout, createToken); err != nil {
		if !attempted {
			return ports.WorkspaceInfo{}, err
		}
		// git can materialize most or all of a large checkout before the request
		// context expires. In that case it leaves a locked "initializing"
		// registration and a multi-gigabyte directory behind. Return custody of
		// the allocated path even on failure, and clean only the registration for
		// this exact path/branch under a context that outlives the cancelled
		// request. The caller can make a second rollback attempt from the returned
		// WorkspaceInfo if this best-effort cleanup cannot finish.
		retained, cleanupErr := w.rollbackFailedCreate(ctx, repo, path, createToken)
		if cleanupErr != nil {
			if retained {
				info := ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}
				return info, errors.Join(err, cleanupErr)
			}
			return ports.WorkspaceInfo{}, errors.Join(err, cleanupErr)
		}
		return ports.WorkspaceInfo{}, err
	}
	return ports.WorkspaceInfo{Path: path, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
}

// CreateWorkspaceProject materialises a root-as-repo workspace session: the
// parent repo worktree is created at the session root, then each registered
// child repo is created at its relative path inside that root. All repos share
// one branch name; if the requested branch already exists in any repo, one
// suffixed branch that is free in every repo is selected and used everywhere.
func (w *Workspace) CreateWorkspaceProject(ctx context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	if err := validateWorkspaceProjectConfig(cfg); err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	rootRepo, err := physicalAbs(cfg.RootRepoPath)
	if err != nil {
		return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: root repo path: %w", err)
	}
	rootPath, err := w.managedPath(ports.WorkspaceConfig{
		ProjectID:     cfg.ProjectID,
		SessionID:     cfg.SessionID,
		Kind:          cfg.Kind,
		SessionPrefix: cfg.SessionPrefix,
		Branch:        firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)),
	})
	if err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	repos := make([]workspaceProjectRepo, 0, len(cfg.Repos)+1)
	repos = append(repos, workspaceProjectRepo{
		name:       domain.RootWorkspaceRepoName,
		repoPath:   rootRepo,
		outputPath: rootPath,
		baseBranch: cfg.BaseBranch,
	})
	for _, child := range cfg.Repos {
		repoPath, err := physicalAbs(child.RepoPath)
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q path: %w", child.Name, err)
		}
		rel, err := cleanRelativePath(child.RelativePath)
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q: %w", child.Name, err)
		}
		outPath, err := w.validateManagedPath(filepath.Join(rootPath, filepath.FromSlash(rel)))
		if err != nil {
			return ports.WorkspaceProjectInfo{}, fmt.Errorf("gitworktree: child repo %q path: %w", child.Name, err)
		}
		repos = append(repos, workspaceProjectRepo{
			name:         child.Name,
			relativePath: rel,
			repoPath:     repoPath,
			outputPath:   outPath,
			baseBranch:   firstNonEmpty(child.BaseBranch, cfg.BaseBranch),
		})
	}
	if w.minFreeBytes > 0 {
		w.materializeMu.Lock()
		defer w.materializeMu.Unlock()
	}
	branch, err := w.workspaceProjectBranch(ctx, repos, firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)))
	if err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	created := make([]workspaceProjectRepo, 0, len(repos))
	out := ports.WorkspaceProjectInfo{Worktrees: make([]ports.WorkspaceRepoInfo, 0, len(repos))}
	for _, repo := range repos {
		repo.createToken = newWorktreeCreateToken()
		baseSHA, currentRetained, err := w.createWorkspaceProjectRepo(ctx, repo, branch)
		if err != nil {
			cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), failedCreateCleanupTimeout)
			defer cancel()
			// A failed child add may have lost a race to a different creator.
			// Preserve its parent if any child path is still present, even when
			// that foreign child is not ours to claim as cleanup custody.
			childPathMayExist := false
			if repo.name != domain.RootWorkspaceRepoName {
				_, statErr := os.Lstat(repo.outputPath)
				childPathMayExist = statErr == nil || !errors.Is(statErr, os.ErrNotExist)
			}
			remaining := make([]ports.WorkspaceRepoInfo, 0, len(out.Worktrees)+1)
			if currentRetained {
				remaining = append(remaining, workspaceProjectRepoInfo(cfg, repo, branch, baseSHA))
				if repo.name == domain.RootWorkspaceRepoName {
					out.Root = ports.WorkspaceInfo{Path: repo.outputPath, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo.repoPath}
				}
			}
			var cleanupErr error
			for i := len(created) - 1; i >= 0; i-- {
				if created[i].name == domain.RootWorkspaceRepoName && (len(remaining) > 0 || childPathMayExist) {
					// Every child lives beneath rootPath. Removing the root while
					// any child is retained would erase that child's files.
					remaining = append(remaining, out.Worktrees[i])
					out.Root = ports.WorkspaceInfo{Path: created[i].outputPath, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: created[i].repoPath}
					continue
				}
				retained, rollbackErr := w.rollbackOwnedWorktree(cleanupCtx, created[i].repoPath, created[i].outputPath, branch, created[i].createToken)
				if rollbackErr != nil {
					cleanupErr = errors.Join(cleanupErr, rollbackErr)
					if created[i].name != domain.RootWorkspaceRepoName && !retained {
						// An unregistered path may belong to a new creator. It is not
						// ours to delete, but it still prevents removing its parent.
						_, statErr := os.Lstat(created[i].outputPath)
						childPathMayExist = childPathMayExist || statErr == nil || !errors.Is(statErr, os.ErrNotExist)
					}
				}
				if retained {
					remaining = append(remaining, out.Worktrees[i])
					if created[i].name == domain.RootWorkspaceRepoName {
						out.Root = ports.WorkspaceInfo{Path: created[i].outputPath, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: created[i].repoPath}
					}
				} else if out.Root.Path == created[i].outputPath {
					out.Root = ports.WorkspaceInfo{}
				}
				// Leave the branch ref behind. A same-SHA compare-and-delete
				// cannot prove that a concurrent creator has not claimed it.
			}
			// Cleanup ran in reverse order; restore the public root-first order for
			// any worktrees whose removal failed so the caller retains custody.
			slices.Reverse(remaining)
			out.Worktrees = remaining
			if len(remaining) == 0 {
				out = ports.WorkspaceProjectInfo{}
			}
			return out, errors.Join(err, cleanupErr)
		}
		created = append(created, repo)
		info := workspaceProjectRepoInfo(cfg, repo, branch, baseSHA)
		out.Worktrees = append(out.Worktrees, info)
		if repo.name == domain.RootWorkspaceRepoName {
			out.Root = ports.WorkspaceInfo{Path: repo.outputPath, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo.repoPath}
		}
	}
	unlockCtx, cancelUnlock := failedCreateCleanupContext(ctx)
	defer cancelUnlock()
	for i := len(created) - 1; i >= 0; i-- {
		repo := created[i]
		if err := w.unlockCreatedWorktreeIfOwned(unlockCtx, repo.repoPath, repo.outputPath, repo.createToken); err != nil {
			// All paths already have custody in out. Retain every remaining lock
			// for explicit recovery instead of tearing down a completed checkout.
			return out, fmt.Errorf("gitworktree: unlock workspace repo %q: %w", repo.name, err)
		}
	}
	return out, nil
}

func workspaceProjectRepoInfo(cfg ports.WorkspaceProjectConfig, repo workspaceProjectRepo, branch, baseSHA string) ports.WorkspaceRepoInfo {
	return ports.WorkspaceRepoInfo{
		RepoName: repo.name, RepoPath: repo.repoPath, Path: repo.outputPath,
		Branch: branch, BaseSHA: baseSHA, SessionID: cfg.SessionID,
		ProjectID: cfg.ProjectID, RelativePath: repo.relativePath,
	}
}

// DestroyWorkspaceProject removes every worktree in a workspace project,
// children first and the parent/root last. It uses the same force path as spawn
// rollback because normal interactive cleanup still goes through Destroy and
// the full dirty-preserve matrix is implemented separately.
func (w *Workspace) DestroyWorkspaceProject(ctx context.Context, info ports.WorkspaceProjectInfo) error {
	for i := len(info.Worktrees) - 1; i >= 0; i-- {
		wt := info.Worktrees[i]
		if wt.Path == "" {
			continue
		}
		repoPath := wt.RepoPath
		if repoPath == "" {
			return fmt.Errorf("gitworktree: missing repo path for worktree %q", wt.Path)
		}
		if err := w.forceDestroyPath(ctx, repoPath, wt.Path); err != nil {
			// A retained child must keep its containing root on disk.
			return err
		}
	}
	return nil
}

// Destroy removes the session's worktree and prunes it from the repo, refusing
// (rather than force-deleting) if git still has the path registered afterwards.
func (w *Workspace) Destroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	_, removeErr := w.run(ctx, w.binary, worktreeRemoveArgs(repo, path)...)
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return err
	}
	if _, ok := findWorktree(records, path); ok {
		if removeErr != nil {
			if isLockedWorktreeRemoveError(removeErr) {
				return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune (worktree remove: %w)", path, removeErr)
			}
			// Distinguish the dirty-worktree refusal (uncommitted agent work)
			// from other registration leftovers (e.g. a locked worktree) so the
			// Session Manager can preserve the workspace without erroring.
			dirty, statusErr := w.isDirty(ctx, path)
			if statusErr == nil && dirty {
				return fmt.Errorf("gitworktree: refusing to remove %q: %w (worktree remove: %w)", path, ports.ErrWorkspaceDirty, removeErr)
			}
			if statusErr != nil {
				// A failed probe must stay visible: without it the caller can't
				// tell "not dirty" from "couldn't check".
				return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune (worktree remove: %w; dirty probe: %w)", path, removeErr, statusErr)
			}
			return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune (worktree remove: %w)", path, removeErr)
		}
		return fmt.Errorf("gitworktree: refusing to remove %q: path is still registered after git worktree prune", path)
	}
	if err := removeAllWithRetry(ctx, path); err != nil {
		return fmt.Errorf("gitworktree: remove unregistered path %q: %w", path, err)
	}
	return nil
}

// ForceDestroy removes the session's worktree unconditionally (--force), prunes
// it from git's worktree list, and falls back to os.RemoveAll if any filesystem
// residue remains.
//
// ponytail: only safe to call AFTER the session's uncommitted work has been
// captured via StashUncommitted. Calling it before capture silently
// discards agent work. For interactive teardown (ao session kill, ao cleanup)
// use Destroy, which refuses dirty worktrees via ErrWorkspaceDirty.
func (w *Workspace) ForceDestroy(ctx context.Context, info ports.WorkspaceInfo) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	// --force bypasses git's dirty check; errors here are advisory (the path may
	// already be gone). We proceed to prune regardless.
	_, _ = w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	// os.RemoveAll as a backstop: cleans up filesystem residue left behind if
	// git worktree remove --force still left the directory (e.g. files outside
	// git tracking).
	if err := removeAllWithRetry(ctx, path); err != nil {
		return fmt.Errorf("gitworktree: force remove path %q: %w", path, err)
	}
	return nil
}

// StashUncommitted captures all uncommitted work in the session's worktree
// into a git commit object WITHOUT mutating the working tree or the global
// stash stack. The commit is stored at refs/ao/preserved/<session-id>.
//
// It builds the preserve commit through a temporary index file so tracked
// edits AND new non-ignored files are captured while .gitignore-d files are
// silently skipped (honoured because we never pass -f/--force to git-add).
//
// Returns the full ref name (e.g. "refs/ao/preserved/sess-1"). Returns an
// empty string (and no error) if the worktree is clean.
func (w *Workspace) StashUncommitted(ctx context.Context, info ports.WorkspaceInfo) (string, error) {
	if info.Path == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if info.SessionID == "" {
		return "", errors.New("gitworktree: session id is required for StashUncommitted")
	}
	repo, err := w.repoPathForInfo(info)
	if err != nil {
		return "", err
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return "", err
	}
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("gitworktree: stale worktree %q: %w", path, ports.ErrWorkspaceStale)
		}
		return "", fmt.Errorf("gitworktree: stat worktree %q: %w", path, err)
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return "", err
	}
	if _, ok := findWorktree(records, path); !ok {
		return "", fmt.Errorf("gitworktree: worktree %q is not registered: %w", path, ports.ErrWorkspaceStale)
	}

	// Early exit for clean worktrees: nothing to preserve.
	dirty, err := w.isDirty(ctx, path)
	if err != nil {
		if isNotGitRepositoryError(err) {
			return "", fmt.Errorf("gitworktree: stale worktree %q: %w", path, ports.ErrWorkspaceStale)
		}
		return "", fmt.Errorf("gitworktree: StashUncommitted dirty check: %w", err)
	}
	if !dirty {
		return "", nil
	}

	// Log the count of ignored paths that will be skipped.
	if skipCount, err := w.countIgnoredPaths(ctx, path); err == nil {
		slog.InfoContext(ctx, "gitworktree: StashUncommitted skipping ignored paths",
			"session", string(info.SessionID),
			"skipped_count", skipCount,
		)
	}

	// Reserve a unique path for the temp index in the system temp dir (not ~/.ao).
	// We must NOT pre-create the file: git requires GIT_INDEX_FILE to either not
	// exist (it creates it) or be a valid git index. os.CreateTemp gives us a
	// unique name; we close and remove it immediately so git gets an absent path.
	tmpIdx, err := os.CreateTemp("", "ao-preserve-idx-*")
	if err != nil {
		return "", fmt.Errorf("gitworktree: reserve temp index path: %w", err)
	}
	tmpIdxPath := tmpIdx.Name()
	_ = tmpIdx.Close()
	// Remove now so git sees an absent path (not a 0-byte corrupt index).
	_ = os.Remove(tmpIdxPath)
	// Deferred remove is a best-effort cleanup in case git leaves the file.
	defer func() { _ = os.Remove(tmpIdxPath) }()

	// Stage all tracked and non-ignored untracked files into the temp index.
	// GIT_INDEX_FILE overrides the index so the real index is never touched.
	addCmd := exec.CommandContext(ctx, w.binary, addAllTempIndexArgs(path)...)
	addCmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+tmpIdxPath)
	if out, err := addCmd.CombinedOutput(); err != nil {
		return "", commandError{args: append([]string{w.binary}, addAllTempIndexArgs(path)...), output: string(out), err: err}
	}

	// Write the staged tree to get a tree SHA.
	writeTreeCmd := exec.CommandContext(ctx, w.binary, writeTreeArgs(path)...)
	writeTreeCmd.Env = append(os.Environ(), "GIT_INDEX_FILE="+tmpIdxPath)
	treeOut, err := writeTreeCmd.CombinedOutput()
	if err != nil {
		return "", commandError{args: append([]string{w.binary}, writeTreeArgs(path)...), output: string(treeOut), err: err}
	}
	treeSHA := strings.TrimSpace(string(treeOut))

	// Resolve HEAD. An unborn HEAD (no commits yet) means we omit the -p flag
	// from commit-tree so the preserve commit has no parent.
	headOut, headErr := w.run(ctx, w.binary, revParseHeadArgs(path)...)
	headSHA := ""
	if headErr == nil {
		headSHA = strings.TrimSpace(string(headOut))
	}
	// headErr != nil means unborn HEAD: headSHA stays empty, commit-tree gets no -p.

	// If the preserve tree SHA equals HEAD's tree SHA the working tree is
	// effectively clean from git's perspective (only ignored files differ).
	if headSHA != "" {
		headTreeOut, err := w.run(ctx, w.binary, "-C", path, "rev-parse", headSHA+"^{tree}")
		if err == nil {
			headTreeSHA := strings.TrimSpace(string(headTreeOut))
			if headTreeSHA == treeSHA {
				// Nothing to preserve beyond ignored files.
				return "", nil
			}
		}
	}

	// Create a commit object that wraps the preserve tree.
	msg := "ao preserved " + string(info.SessionID)
	commitOut, err := w.run(ctx, w.binary, commitTreeArgs(path, treeSHA, headSHA, msg)...)
	if err != nil {
		return "", fmt.Errorf("gitworktree: commit-tree: %w", err)
	}
	commitSHA := strings.TrimSpace(string(commitOut))

	// Point the preserve ref at the commit.
	ref := "refs/ao/preserved/" + string(info.SessionID)
	if _, err := w.run(ctx, w.binary, updateRefArgs(path, ref, commitSHA)...); err != nil {
		return "", fmt.Errorf("gitworktree: update-ref %q: %w", ref, err)
	}
	return ref, nil
}

func isNotGitRepositoryError(err error) bool {
	return strings.Contains(err.Error(), "not a git repository")
}

// countIgnoredPaths returns the number of entries listed by
// "git status --ignored --porcelain" that start with "!!" (ignored).
func (w *Workspace) countIgnoredPaths(ctx context.Context, worktree string) (int, error) {
	out, err := w.run(ctx, w.binary, ignoredCountArgs(worktree)...)
	if err != nil {
		return 0, fmt.Errorf("gitworktree: count ignored: %w", err)
	}
	count := 0
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "!! ") {
			count++
		}
	}
	return count, nil
}

// ApplyPreserved replays the capture created by StashUncommitted onto the
// (freshly re-added) worktree using a true three-way merge (cherry-pick --no-commit).
// On clean success, the preserve ref is deleted.
// On conflict, the ref is kept, conflict markers are left in the affected files,
// and ErrPreservedConflict (wrapped) is returned so the caller can surface it.
//
// NEVER deletes the preserve ref on a failed or conflicted apply.
func (w *Workspace) ApplyPreserved(ctx context.Context, info ports.WorkspaceInfo, ref string) error {
	if info.Path == "" {
		return fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if ref == "" {
		return errors.New("gitworktree: ApplyPreserved: ref must not be empty")
	}

	// Resolve the ref to its commit SHA.
	resolveOut, err := w.run(ctx, w.binary, revParseVerifyArgs(info.Path, ref)...)
	if err != nil {
		return fmt.Errorf("gitworktree: ApplyPreserved resolve ref %q: %w", ref, err)
	}
	commitSHA := strings.TrimSpace(string(resolveOut))

	// Apply the preserve commit via "git cherry-pick --no-commit <sha>".
	// cherry-pick computes the diff between the preserve commit and its parent
	// (the HEAD at save time) and 3-way-merges it onto the current working tree.
	// On conflict it leaves textual conflict markers in the affected files and
	// exits non-zero WITHOUT committing or moving HEAD. Conflict detection uses
	// the exit code only (not output text) to stay locale-independent.
	applyErr := w.runCherryPickNoCommit(ctx, info.Path, commitSHA)
	if applyErr != nil {
		// Any non-zero exit from the merge step is a conflict: keep the ref,
		// leave conflict markers in place, and surface the sentinel.
		return fmt.Errorf("%w: %w", ErrPreservedConflict, applyErr)
	}

	// Clean apply: remove the preserve ref so it is never replayed twice.
	if _, err := w.run(ctx, w.binary, deleteRefArgs(info.Path, ref)...); err != nil {
		// Log but do not fail: the work is already applied. A dangling preserve
		// ref is harmless; the next StashUncommitted will overwrite it.
		slog.WarnContext(ctx, "gitworktree: ApplyPreserved could not delete preserve ref",
			"ref", ref,
			"err", err,
		)
	}
	return nil
}

// AddExclude appends git ignore patterns to the worktree's local info/exclude so
// daemon-generated files never surface as untracked changes. The exclude file is
// resolved via `git rev-parse --git-common-dir`, not `--git-dir`: git reads
// info/exclude from $GIT_COMMON_DIR, and this adapter only ever creates linked
// worktrees, where --git-dir points into .git/worktrees/<name> (per-worktree)
// while --git-common-dir points at the shared main .git. Writing under --git-dir
// would land info/exclude in a directory git never consults, making the exclude a
// no-op. Idempotent: patterns already present are skipped.
func (w *Workspace) AddExclude(ctx context.Context, info ports.WorkspaceInfo, patterns ...string) error {
	if len(patterns) == 0 {
		return nil
	}
	path, err := w.validateManagedPath(info.Path)
	if err != nil {
		return err
	}
	out, err := w.run(ctx, w.binary, "-C", path, "rev-parse", "--git-common-dir")
	if err != nil {
		return fmt.Errorf("gitworktree: AddExclude resolve git common dir: %w", err)
	}
	gitDir := strings.TrimSpace(string(out))
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(path, gitDir)
	}
	infoDir := filepath.Join(gitDir, "info")
	if err := os.MkdirAll(infoDir, 0o750); err != nil {
		return fmt.Errorf("gitworktree: AddExclude create info dir: %w", err)
	}
	excludePath := filepath.Join(infoDir, "exclude")
	existing, _ := os.ReadFile(excludePath)
	var toAdd []string
	for _, p := range patterns {
		if !strings.Contains(string(existing), p) {
			toAdd = append(toAdd, p)
		}
	}
	if len(toAdd) == 0 {
		return nil
	}
	f, err := os.OpenFile(excludePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("gitworktree: AddExclude open exclude: %w", err)
	}
	defer func() { _ = f.Close() }()
	prefix := ""
	if len(existing) > 0 && !strings.HasSuffix(string(existing), "\n") {
		prefix = "\n"
	}
	if _, err := f.WriteString(prefix + strings.Join(toAdd, "\n") + "\n"); err != nil {
		return fmt.Errorf("gitworktree: AddExclude write exclude: %w", err)
	}
	return nil
}

// runCherryPickNoCommit runs "git -C <worktree> cherry-pick --no-commit <sha>"
// and captures combined output so any conflict details are available in the
// returned commandError. Exit code detection happens in the caller.
func (w *Workspace) runCherryPickNoCommit(ctx context.Context, worktree, commitSHA string) error {
	args := cherryPickNoCommitArgs(worktree, commitSHA)
	cmd := exec.CommandContext(ctx, w.binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return commandError{args: append([]string{w.binary}, args...), output: string(out), err: err}
	}
	return nil
}

// Restore re-attaches to an existing worktree for the session if one is still
// present, recreating the handle without disturbing its contents.
func (w *Workspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	if err := validateConfig(cfg); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	repo, err := w.repoPathForConfig(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	path, err := w.restorePath(cfg)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if w.minFreeBytes > 0 {
		w.materializeMu.Lock()
		defer w.materializeMu.Unlock()
	}
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	// recreateBranch is the branch used if we fall through to recreate the
	// worktree below. It defaults to cfg.Branch (the "no prior registration"
	// case) but is overridden to the stale registration's own branch when one
	// is found, so a session sitting on a child branch is not silently
	// recreated on cfg.Branch (typically the root branch) instead.
	recreateBranch := cfg.Branch
	if rec, ok := findWorktree(records, path); ok {
		missing, err := registeredWorktreeDirMissing(rec)
		if err != nil {
			return ports.WorkspaceInfo{}, err
		}
		if !missing {
			branch := rec.Branch
			if branch == "" {
				branch = cfg.Branch
			}
			return ports.WorkspaceInfo{Path: path, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
		}
		// The registration outlived its directory (issue #2775: a session's git
		// worktree registration and DB row survived a deletion that removed only
		// the directory). Fall through to recreate the worktree at path below,
		// on the registration's own branch (not cfg.Branch), instead of
		// returning a handle to a directory that does not exist, which
		// previously made `cd <path> || exit` in the tmux launch command exit
		// instantly with no diagnostic. addWorktree re-registers the stale path
		// itself via `worktree add --force`; the registration is left in place
		// until then.
		if rec.Branch != "" {
			recreateBranch = rec.Branch
		}
	}
	if err := w.validateBranch(ctx, repo, recreateBranch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	requiredBytes, err := w.estimateCheckoutBytes(ctx, repo, recreateBranch, cfg.BaseBranch, cfg.SparseCheckout)
	if err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if err := w.ensureCapacity(requiredBytes); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if nonEmpty, err := pathExistsNonEmpty(path); err != nil {
		return ports.WorkspaceInfo{}, err
	} else if nonEmpty {
		if cfg.Path == "" {
			return ports.WorkspaceInfo{}, fmt.Errorf("gitworktree: refusing to restore %q: path exists and is not a registered worktree", path)
		}
		if _, err := moveStrayPathAside(path); err != nil {
			return ports.WorkspaceInfo{}, err
		}
	}
	if err := w.validateBranch(ctx, repo, recreateBranch); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	createToken := newWorktreeCreateToken()
	if attempted, err := w.addWorktree(ctx, repo, path, recreateBranch, cfg.BaseBranch, cfg.SparseCheckout, createToken); err != nil {
		if !attempted {
			return ports.WorkspaceInfo{}, err
		}
		retained, cleanupErr := w.rollbackFailedCreate(ctx, repo, path, createToken)
		if retained {
			return ports.WorkspaceInfo{Path: path, Branch: recreateBranch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, errors.Join(err, cleanupErr)
		}
		return ports.WorkspaceInfo{}, errors.Join(err, cleanupErr)
	}
	return ports.WorkspaceInfo{Path: path, Branch: recreateBranch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoPath: repo}, nil
}

func (w *Workspace) ensureCapacity(checkoutBytes uint64) error {
	if w.minFreeBytes == 0 {
		return nil
	}
	available, err := w.availableCapacityBytes()
	if err != nil {
		return fmt.Errorf("gitworktree: inspect capacity path %q: %w", w.capacityPath, err)
	}
	required := w.minFreeBytes
	if checkoutBytes > ^uint64(0)-required {
		required = ^uint64(0)
	} else {
		required += checkoutBytes
	}
	if available < required {
		return fmt.Errorf("%w: capacity path %q has %d bytes available; require %d bytes (%d reserve + %d estimated checkout) before creating another worktree", ports.ErrWorkspaceInsufficientSpace, w.capacityPath, available, required, w.minFreeBytes, checkoutBytes)
	}
	return nil
}

// CapacityAvailable reports free bytes on the same filesystem used by the
// checkout guard. The daemon polls this while agents are running: a checkout
// can fit at creation time and later writes can still exhaust the host volume.
func (w *Workspace) CapacityAvailable() (uint64, error) {
	if w.minFreeBytes == 0 {
		return 0, nil
	}
	return w.availableCapacityBytes()
}

func (w *Workspace) availableCapacityBytes() (uint64, error) {
	if w.deviceIdentity != nil && w.capacityDevice != 0 {
		device, err := w.deviceIdentity(w.capacityPath)
		if err != nil {
			return 0, err
		}
		if device != w.capacityDevice {
			return 0, fmt.Errorf("configured capacity filesystem changed at %q", w.capacityPath)
		}
	}
	return w.availableBytes(w.capacityPath)
}

const checkoutMetadataHeadroom = uint64(256 << 20)

func (w *Workspace) estimateCheckoutBytes(ctx context.Context, repo, branch, baseBranch string, sparseCheckout []string) (uint64, error) {
	if w.minFreeBytes == 0 {
		return 0, nil
	}
	// Check the reserve before any command that could hydrate a partial clone.
	if err := w.ensureCapacity(0); err != nil {
		return 0, err
	}
	if err := w.rejectPartialClone(ctx, repo); err != nil {
		return 0, err
	}
	ref := "refs/heads/" + branch
	local, err := w.refExists(ctx, repo, ref)
	if err != nil {
		return 0, err
	}
	if !local {
		ref, err = w.resolveBaseRef(ctx, repo, branch, baseBranch)
		if err != nil {
			if errors.Is(err, errNoBaseRef) {
				return 0, fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
			}
			return 0, err
		}
	}
	if err := w.rejectCheckoutTransforms(ctx, repo, ref); err != nil {
		return 0, err
	}
	out, err := w.run(ctx, w.binary, "-C", repo, "ls-tree", "-r", "-l", "-z", ref)
	if err != nil {
		return 0, fmt.Errorf("gitworktree: estimate checkout %q: %w", ref, err)
	}
	var total uint64
	var entries uint64
	for _, record := range strings.Split(string(out), "\x00") {
		meta, treePath, ok := strings.Cut(record, "\t")
		if !ok {
			continue
		}
		if len(sparseCheckout) > 0 && !sparseCheckoutContains(treePath, sparseCheckout) {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) < 4 || fields[3] == "-" {
			continue
		}
		entries++
		size, parseErr := strconv.ParseUint(fields[3], 10, 64)
		if parseErr != nil {
			return 0, fmt.Errorf("gitworktree: parse checkout size %q: %w", fields[3], parseErr)
		}
		if size > ^uint64(0)-total {
			return ^uint64(0), nil
		}
		total += size
	}
	// Allow a conservative allocation unit for every file, in addition to
	// content bytes. ls-tree reports blob bytes, not allocated disk blocks.
	const perFileAllocation = uint64(64 << 10)
	if entries > (^uint64(0)-checkoutMetadataHeadroom)/perFileAllocation {
		return ^uint64(0), nil
	}
	overhead := checkoutMetadataHeadroom + entries*perFileAllocation
	if total/10 > ^uint64(0)-overhead {
		return ^uint64(0), nil
	}
	overhead += total / 10
	if overhead > ^uint64(0)-total {
		return ^uint64(0), nil
	}
	return total + overhead, nil
}

func sparseCheckoutContains(treePath string, directories []string) bool {
	if !strings.Contains(treePath, "/") {
		return true
	}
	cleanPath := filepath.ToSlash(filepath.Clean(treePath))
	for _, directory := range directories {
		cleanDirectory := filepath.ToSlash(filepath.Clean(directory))
		if cleanPath == cleanDirectory || strings.HasPrefix(cleanPath, cleanDirectory+"/") {
			return true
		}
	}
	return false
}

func (w *Workspace) rejectPartialClone(ctx context.Context, repo string) error {
	out, err := w.run(ctx, w.binary, "-C", repo, "config", "--get-regexp", `^(remote\..*\.promisor|extensions\.partialclone)$`)
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil
		}
		return fmt.Errorf("gitworktree: inspect checkout filters for %q: %w", repo, err)
	}
	if strings.TrimSpace(string(out)) != "" {
		return fmt.Errorf("%w: cannot safely estimate checkout for %q because a partial-clone promisor is configured", ports.ErrWorkspaceInsufficientSpace, repo)
	}
	return nil
}

func (w *Workspace) rejectCheckoutTransforms(ctx context.Context, repo, ref string) error {
	// Git also reads attributes outside the selected tree. Refuse admission
	// when those sources can alter checkout bytes without appearing in grep.
	if out, err := w.run(ctx, w.binary, "-C", repo, "config", "--path", "--get", "core.attributesFile"); err == nil {
		if strings.TrimSpace(string(out)) != "" {
			return fmt.Errorf("%w: cannot safely estimate checkout for %q with core.attributesFile configured", ports.ErrWorkspaceInsufficientSpace, repo)
		}
	} else if !isGitConfigMissing(err) {
		return fmt.Errorf("gitworktree: inspect core.attributesFile for %q: %w", repo, err)
	}
	infoPath, err := w.run(ctx, w.binary, "-C", repo, "rev-parse", "--git-path", "info/attributes")
	if err != nil {
		return fmt.Errorf("gitworktree: locate info/attributes for %q: %w", repo, err)
	}
	attributesPath := strings.TrimSpace(string(infoPath))
	if !filepath.IsAbs(attributesPath) {
		attributesPath = filepath.Join(repo, attributesPath)
	}
	if info, err := os.Stat(attributesPath); err == nil {
		if info.Size() > 0 {
			return fmt.Errorf("%w: cannot safely estimate checkout for %q with info/attributes", ports.ErrWorkspaceInsufficientSpace, repo)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("gitworktree: inspect info/attributes for %q: %w", repo, err)
	}
	var coreEOL string
	for _, key := range []string{"core.autocrlf", "core.eol"} {
		out, err := w.run(ctx, w.binary, "-C", repo, "config", "--get", key)
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
				continue
			}
			return fmt.Errorf("gitworktree: inspect %s for %q: %w", key, repo, err)
		}
		value := strings.ToLower(strings.TrimSpace(string(out)))
		if key == "core.eol" {
			coreEOL = value
		}
		if (key == "core.autocrlf" && value == "true") || (key == "core.eol" && value == "crlf") {
			return fmt.Errorf("%w: cannot safely estimate checkout for %q because %s=%s may expand text files", ports.ErrWorkspaceInsufficientSpace, repo, key, value)
		}
	}
	pattern := checkoutExpandingAttributePattern(runtime.GOOS, coreEOL)
	out, err := w.run(ctx, w.binary, "-C", repo, "grep", "-I", "-n", "-E", pattern, ref, "--", ".gitattributes", ":(glob)**/.gitattributes")
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
			return nil
		}
		return fmt.Errorf("gitworktree: inspect checkout attributes for %q at %q: %w", repo, ref, err)
	}
	if strings.TrimSpace(string(out)) != "" {
		return fmt.Errorf("%w: cannot safely estimate checkout for %q because the selected tree uses a checkout-expanding attribute", ports.ErrWorkspaceInsufficientSpace, repo)
	}
	return nil
}

func checkoutExpandingAttributePattern(goos, coreEOL string) string {
	pattern := `(^|[[:space:]])(filter(=|[[:space:]])|eol=crlf|working-tree-encoding=|ident($|[[:space:]])`
	if goos == "windows" && (coreEOL == "" || coreEOL == "native") {
		pattern += `|text($|[=[:space:]])`
	}
	return pattern + `)`
}

func isGitConfigMissing(err error) bool {
	var exitErr *exec.ExitError
	return errors.As(err, &exitErr) && exitErr.ExitCode() == 1
}

func (w *Workspace) existingWorktree(ctx context.Context, repo, path string, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, bool, error) {
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return ports.WorkspaceInfo{}, false, err
	}
	if rec, ok := findWorktree(records, path); ok {
		missing, err := registeredWorktreeDirMissing(rec)
		if err != nil {
			return ports.WorkspaceInfo{}, false, err
		}
		if missing {
			// Report "no existing worktree" so Create falls through to
			// addWorktree, which re-registers this stale path in one step via
			// `worktree add --force`.
			//
			// Unlike Restore, Create deliberately recreates on cfg.Branch and
			// not on rec.Branch. Restore is re-attaching to a live session
			// whose branch may have moved on past what AO recorded, so the
			// registration is the better source of truth there; Create is
			// materializing a NEW session, where a registration at this path is
			// a leftover from a prior session of the same name and its branch
			// says nothing about what the caller asked for.
			return ports.WorkspaceInfo{}, false, nil
		}
		branch := rec.Branch
		if branch == "" {
			branch = cfg.Branch
		}
		return ports.WorkspaceInfo{Path: path, Branch: branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, true, nil
	}
	return ports.WorkspaceInfo{}, false, nil
}

// registeredWorktreeDirMissing reports whether a git-registered worktree's
// directory no longer exists on disk. A worktree registration (and the
// session's DB row) can outlive its directory when something removes the path
// out of band of AO's own teardown (issue #2775: session agent-orchestrator-78
// kept its branches and worktree registration but its directory was gone, so
// handing that path straight to the runtime made the tmux launch command's
// `cd <path> || exit` guard exit instantly with no diagnostic). When it reports
// true, the caller materializes a fresh worktree at the same path with
// `git worktree add --force` (see worktreeAddForce), which re-registers the
// path itself: nothing here removes or prunes a registration first.
//
// This is deliberately a pure observation. Recovering by first clearing the
// stale registration would mean either the repo-wide `git worktree prune`,
// which also drops the registration of every OTHER worktree of the repo whose
// directory git currently cannot see (verified against real git: two worktrees
// with their directories both deleted, one prune removes BOTH registrations,
// silently reintroducing the "recreated on the wrong branch" failure
// recreateBranch exists to prevent for a sibling session that never asked to be
// touched), or the target-specific `git worktree remove --force`, which is
// check-then-delete against this stat: if anything materializes the worktree
// between the two, the force-remove deletes a live worktree and any uncommitted
// agent work in it. `worktree add --force` has neither problem: it touches only
// this path's registration, and git refuses it outright when the directory
// exists and is non-empty, so a lost race fails loudly instead of destroying
// work.
//
// If rec is locked (`git worktree lock`), this returns ErrWorktreeLocked
// instead of reporting a recoverable registration. Verified against real git: a
// single `worktree add --force` refuses a missing-but-locked registration (it
// demands `-f -f`), and `git worktree prune` leaves such a registration in
// place too, so attempting recovery here would just relay an opaque git error
// downstream. Locking is an explicit operator signal not to touch a worktree,
// so recovering it automatically would be wrong even if git allowed it.
func registeredWorktreeDirMissing(rec worktreeRecord) (bool, error) {
	info, err := os.Stat(rec.Path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return false, fmt.Errorf("gitworktree: stat registered worktree %q: %w", rec.Path, err)
		}
		if rec.Locked {
			return false, fmt.Errorf(
				"%w: %q (branch %q) is registered but its directory is missing; unlock it (`git worktree unlock %s`) and retry, or remove the registration manually",
				ErrWorktreeLocked, rec.Path, rec.Branch, rec.Path,
			)
		}
		return true, nil
	}
	if !info.IsDir() {
		return false, fmt.Errorf("gitworktree: registered worktree %q is not a directory", rec.Path)
	}
	return false, nil
}

func (w *Workspace) addWorktree(ctx context.Context, repo, path, branch, baseBranch string, sparseCheckout []string, createToken string) (bool, error) {
	// Refuse early if the branch is already checked out in another worktree:
	// `git worktree add` will fail, but its stderr leaks through as an opaque
	// 500. A typed sentinel lets the HTTP layer surface a 409.
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return false, err
	}
	if conflict, ok := findWorktreeByBranch(records, branch); ok && filepath.Clean(conflict.Path) != filepath.Clean(path) {
		return false, fmt.Errorf("%w: %q is checked out at %q", ErrBranchCheckedOutElsewhere, branch, conflict.Path)
	}
	// A registration at path whose directory is gone makes a plain add fail
	// ("is a missing but already registered worktree; use 'add -f' to
	// override"), so re-register it in the same add instead of clearing it
	// first. records is the freshly listed state, so this decision and the add
	// it feeds are as close together as git allows.
	force, err := staleRegistrationForPath(records, path)
	if err != nil {
		return false, err
	}

	localBranch, err := w.refExists(ctx, repo, "refs/heads/"+branch)
	if err != nil {
		return false, err
	}
	if localBranch {
		if _, err := w.runGuardedWorktreeAdd(ctx, worktreeAddBranchArgs(repo, path, branch, force, len(sparseCheckout) > 0, createToken)...); err != nil {
			return true, fmt.Errorf("gitworktree: worktree add existing branch %q: %w", branch, err)
		}
		if err := w.materializeSparseCheckout(ctx, path, sparseCheckout); err != nil {
			return true, err
		}
		return true, w.unlockCreatedWorktree(ctx, repo, path, createToken)
	}

	// `worktree add -b <branch> <path> <base>` creates a fresh local branch from
	// <base>. resolveBaseRef tries `origin/<branch>` first, so a fetched-but-
	// not-checked-out remote branch auto-tracks cleanly via that path. If
	// neither origin/<branch>, the default branch, nor any tag is reachable,
	// the branch genuinely has no base — surface ErrBranchNotFetched so callers
	// can suggest `git fetch`.
	baseRef, err := w.resolveBaseRef(ctx, repo, branch, baseBranch)
	if err != nil {
		if errors.Is(err, errNoBaseRef) {
			return false, fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
		}
		return false, err
	}
	if err := w.addNewBranchWorktree(ctx, repo, branch, path, baseRef, force, len(sparseCheckout) > 0, createToken); err != nil {
		return true, fmt.Errorf("gitworktree: worktree add branch %q from %q: %w", branch, baseRef, err)
	}
	if err := w.materializeSparseCheckout(ctx, path, sparseCheckout); err != nil {
		return true, err
	}
	return true, w.unlockCreatedWorktree(ctx, repo, path, createToken)
}

func (w *Workspace) materializeSparseCheckout(ctx context.Context, path string, directories []string) error {
	if len(directories) == 0 {
		return nil
	}
	if _, err := w.run(ctx, w.binary, sparseCheckoutInitArgs(path)...); err != nil {
		return fmt.Errorf("gitworktree: initialize sparse checkout: %w", err)
	}
	if _, err := w.run(ctx, w.binary, sparseCheckoutSetArgs(path, directories)...); err != nil {
		return fmt.Errorf("gitworktree: set sparse checkout: %w", err)
	}
	if _, err := w.run(ctx, w.binary, resetHardHeadArgs(path)...); err != nil {
		return fmt.Errorf("gitworktree: materialize sparse checkout: %w", err)
	}
	return nil
}

func newWorktreeCreateToken() string { return "ao-create-" + uuid.NewString() }

func (w *Workspace) unlockCreatedWorktree(parent context.Context, repo, path, createToken string) error {
	cleanupCtx, cancel := failedCreateCleanupContext(parent)
	defer cancel()
	return w.unlockCreatedWorktreeIfOwned(cleanupCtx, repo, path, createToken)
}

func (w *Workspace) unlockCreatedWorktreeWithContext(ctx context.Context, repo, path string) error {
	if _, err := w.run(ctx, w.binary, worktreeUnlockArgs(repo, path)...); err != nil {
		return fmt.Errorf("gitworktree: unlock created worktree %q: %w", path, err)
	}
	return nil
}

func (w *Workspace) unlockCreatedWorktreeIfOwned(ctx context.Context, repo, path, createToken string) error {
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return fmt.Errorf("gitworktree: inspect creation lock %q: %w", path, err)
	}
	rec, registered := findWorktree(records, path)
	if !registered || !rec.Locked || rec.LockReason != createToken {
		return fmt.Errorf("gitworktree: preserve worktree %q: creation lock no longer belongs to this invocation", path)
	}
	return w.unlockCreatedWorktreeWithContext(ctx, repo, path)
}

// staleRegistrationForPath reports whether records carries a registration for
// path whose directory is gone, i.e. whether an add at path needs git's
// `--force` override to re-register it. No registration at all is not stale.
func staleRegistrationForPath(records []worktreeRecord, path string) (bool, error) {
	rec, ok := findWorktree(records, path)
	if !ok {
		return false, nil
	}
	return registeredWorktreeDirMissing(rec)
}

// addNewBranchWorktree runs `git worktree add [--force] -b <branch> <path>
// <baseRef>` and recovers when git rejects path as a stale registration that
// the caller's own pre-check did not see (the directory vanished between that
// check and this add).
//
// The retry deliberately does NOT repeat the `-b` form. git creates
// refs/heads/<branch> BEFORE it validates the target path, so a `-b` attempt
// that fails on the stale registration still leaves the branch behind:
// verified against git 2.54, the failed add prints "Preparing worktree (new
// branch '<branch>')", exits 128, and `show-ref` then finds the branch. A
// `--force -b` retry therefore never recovers, it fails with "a branch named
// '<branch>' already exists" (exit 255), which is the bug this addresses.
// Retrying on the existing-branch form `worktree add --force <path> <branch>`
// checks out the branch the first attempt just created, at baseRef, which is
// exactly what the `-b` form would have produced.
//
// Both callers reach the `-b` form only after confirming refs/heads/<branch>
// did not exist (addWorktree via refExists, createWorkspaceProjectRepo via
// workspaceProjectBranchFree), so a branch present after the failed attempt is
// the one that attempt created, never a pre-existing branch this would hijack.
// The ref is re-read rather than assumed, so a future caller that skips that
// precondition still gets the correct form.
//
// A recovery that fails outright leaves the created branch ref behind. That is
// deliberate: the failure that matters here is "path exists and is non-empty",
// which means something else materialized the worktree at path first, possibly
// checked out on this very branch, and deleting the ref would then damage the
// worktree that won. The leftover ref is harmless and self-correcting: the next
// addWorktree for it takes the existing-branch path, and workspaceProjectBranch
// simply picks the next free candidate.
func (w *Workspace) addNewBranchWorktree(ctx context.Context, repo, branch, path, baseRef string, force, noCheckout bool, createToken string) error {
	_, err := w.runGuardedWorktreeAdd(ctx, worktreeAddNewBranchArgs(repo, branch, path, baseRef, force, noCheckout, createToken)...)
	if err == nil {
		return nil
	}
	// --force was already in play, so the stale registration is not what failed.
	if force || !isMissingRegisteredWorktreeError(err) {
		return err
	}
	// Report the recovery failure alongside the original: on its own, the
	// original ("is a missing but already registered worktree") names the
	// condition recovery was FOR, not the reason recovery failed, and the two
	// are routinely different. The interesting ones are "'<path>' already
	// exists" (another restore materialized the worktree first, so this one
	// lost the race and must not be read as a stale registration) and "missing
	// but locked" (a registration that acquired a lock after the caller's
	// pre-check). Joining keeps errors.Is working for both.
	created, refErr := w.refExists(ctx, repo, "refs/heads/"+branch)
	if refErr != nil {
		return errors.Join(err, refErr)
	}
	retryArgs := worktreeAddNewBranchArgs(repo, branch, path, baseRef, true, noCheckout, createToken)
	if created {
		retryArgs = worktreeAddBranchArgs(repo, path, branch, true, noCheckout, createToken)
	}
	if _, retryErr := w.runGuardedWorktreeAdd(ctx, retryArgs...); retryErr != nil {
		return errors.Join(err, retryErr)
	}
	return nil
}

func (w *Workspace) runGuardedWorktreeAdd(ctx context.Context, args ...string) ([]byte, error) {
	if w.minFreeBytes == 0 {
		return w.run(ctx, w.binary, args...)
	}
	// A post-checkout hook can write arbitrarily more than the admitted tree
	// size. Override hooks for this single materialization with a private empty
	// directory, while leaving the repository's own configuration untouched.
	emptyHooks, err := os.MkdirTemp("", "ao-empty-hooks-")
	if err != nil {
		return nil, fmt.Errorf("gitworktree: isolate checkout hooks: %w", err)
	}
	defer os.RemoveAll(emptyHooks)
	guarded := append([]string{"-c", "core.hooksPath=" + emptyHooks}, args...)
	return w.run(ctx, w.binary, guarded...)
}

type workspaceProjectRepo struct {
	name         string
	relativePath string
	repoPath     string
	outputPath   string
	baseBranch   string
	createToken  string
}

func (w *Workspace) workspaceProjectBranch(ctx context.Context, repos []workspaceProjectRepo, requested string) (string, error) {
	branch := strings.TrimSpace(requested)
	if branch == "" {
		return "", errors.New("gitworktree: branch is required")
	}
	for i := 0; i < 100; i++ {
		candidate := branch
		if i > 0 {
			candidate = fmt.Sprintf("%s-%d", branch, i+1)
		}
		free, err := w.workspaceProjectBranchFree(ctx, repos, candidate)
		if err != nil {
			return "", err
		}
		if free {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("gitworktree: could not find free workspace branch for %q", branch)
}

func (w *Workspace) workspaceProjectBranchFree(ctx context.Context, repos []workspaceProjectRepo, branch string) (bool, error) {
	for _, repo := range repos {
		if err := w.validateBranch(ctx, repo.repoPath, branch); err != nil {
			return false, err
		}
		exists, err := w.refExists(ctx, repo.repoPath, "refs/heads/"+branch)
		if err != nil {
			return false, err
		}
		if exists {
			return false, nil
		}
		records, err := w.listRecords(ctx, repo.repoPath)
		if err != nil {
			return false, err
		}
		if conflict, ok := findWorktreeByBranch(records, branch); ok && filepath.Clean(conflict.Path) != filepath.Clean(repo.outputPath) {
			return false, nil
		}
	}
	return true, nil
}

func (w *Workspace) createWorkspaceProjectRepo(ctx context.Context, repo workspaceProjectRepo, branch string) (string, bool, error) {
	createToken := repo.createToken
	if createToken == "" {
		createToken = newWorktreeCreateToken()
	}
	baseRef, err := w.resolveBaseRef(ctx, repo.repoPath, branch, repo.baseBranch)
	if err != nil {
		if errors.Is(err, errNoBaseRef) {
			return "", false, fmt.Errorf("%w: %q has no local head, no remote, and no tag — run `git fetch` then retry", ErrBranchNotFetched, branch)
		}
		return "", false, err
	}
	baseSHA, err := w.revParse(ctx, repo.repoPath, baseRef)
	if err != nil {
		return "", false, err
	}
	requiredBytes, err := w.estimateCheckoutBytes(ctx, repo.repoPath, branch, repo.baseBranch, nil)
	if err != nil {
		return "", false, err
	}
	if err := w.ensureCapacity(requiredBytes); err != nil {
		return "", false, err
	}
	// Same up-front stale-registration check addWorktree does, so the ordinary
	// #2775 shape (registration outlived its directory) is handled by the first
	// add and never reaches the recovery below. Without it every recovery here
	// had to go through a failed `-b` attempt, which leaves a stray branch ref
	// behind even when it succeeds.
	records, err := w.listRecords(ctx, repo.repoPath)
	if err != nil {
		return "", false, err
	}
	force, err := staleRegistrationForPath(records, repo.outputPath)
	if err != nil {
		return "", false, err
	}
	// Recovery from a registration that only goes stale after that check is
	// addNewBranchWorktree's job: git's own --force override, not the repo-wide
	// prune this used to run, which would also drop sibling sessions'
	// registrations.
	if err := w.addNewBranchWorktree(ctx, repo.repoPath, branch, repo.outputPath, baseRef, force, false, createToken); err != nil {
		createErr := fmt.Errorf("gitworktree: workspace repo %q worktree add branch %q from %q: %w", repo.name, branch, baseRef, err)
		retained, cleanupErr := w.rollbackFailedCreate(ctx, repo.repoPath, repo.outputPath, createToken)
		if cleanupErr != nil {
			return baseSHA, retained, errors.Join(createErr, cleanupErr)
		}
		return baseSHA, false, createErr
	}
	return baseSHA, false, nil
}

// rollbackFailedCreate removes a partially materialized worktree after git
// worktree add fails. A cancelled request is the common case for large repos,
// so teardown uses a detached, bounded context. The registration must carry
// this invocation's unique lock reason; path, branch, and Git's generic
// "initializing" marker cannot distinguish a concurrent creator.
func (w *Workspace) rollbackFailedCreate(parent context.Context, repo, path, createToken string) (bool, error) {
	cleanupCtx, cancel := failedCreateCleanupContext(parent)
	defer cancel()

	records, err := w.listRecords(cleanupCtx, repo)
	if err != nil {
		// Registration is unknown; return custody and keep ancestor worktrees.
		return true, fmt.Errorf("gitworktree: inspect failed create %q: %w", path, err)
	}
	rec, registered := findWorktree(records, path)
	if !registered {
		if _, statErr := os.Lstat(path); statErr == nil {
			return false, fmt.Errorf("gitworktree: preserve failed create %q: path is not registered", path)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return false, fmt.Errorf("gitworktree: inspect failed create path %q: %w", path, statErr)
		}
		return false, nil
	}
	if !rec.Locked || rec.LockReason != createToken {
		return false, fmt.Errorf("gitworktree: preserve failed create %q: registration lacks this invocation's ownership marker", path)
	}
	return w.rollbackRegisteredWorktree(cleanupCtx, repo, path, true)
}

func failedCreateCleanupContext(parent context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(parent), failedCreateCleanupTimeout)
}

func (w *Workspace) rollbackOwnedWorktree(ctx context.Context, repo, path, branch, createToken string) (bool, error) {
	records, err := w.listRecords(ctx, repo)
	if err != nil {
		return true, fmt.Errorf("gitworktree: inspect owned rollback %q: %w", path, err)
	}
	rec, registered := findWorktree(records, path)
	if !registered {
		if _, statErr := os.Lstat(path); statErr == nil {
			return false, fmt.Errorf("gitworktree: preserve unregistered path %q without claiming cleanup custody", path)
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return false, fmt.Errorf("gitworktree: inspect owned rollback path %q: %w", path, statErr)
		}
		return false, nil
	}
	if rec.Branch != branch {
		return true, fmt.Errorf("gitworktree: preserve owned rollback %q: registered branch %q differs from created branch %q", path, rec.Branch, branch)
	}
	if !rec.Locked || rec.LockReason != createToken {
		return true, fmt.Errorf("gitworktree: preserve owned rollback %q: ownership lock differs from this creation", path)
	}
	return w.rollbackRegisteredWorktree(ctx, repo, path, true)
}

func (w *Workspace) rollbackRegisteredWorktree(ctx context.Context, repo, path string, unlock bool) (bool, error) {
	if unlock {
		if _, err := w.run(ctx, w.binary, worktreeUnlockArgs(repo, path)...); err != nil {
			return true, fmt.Errorf("gitworktree: unlock failed create %q: %w", path, err)
		}
	}
	removeOut, removeErr := w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	records, inspectErr := w.listRecords(ctx, repo)
	if inspectErr != nil {
		return true, fmt.Errorf("gitworktree: inspect rollback result %q: %w", path, inspectErr)
	}
	if _, stillRegistered := findWorktree(records, path); stillRegistered {
		if removeErr != nil {
			return true, fmt.Errorf("gitworktree: rollback failed create %q: %w: %s", path, removeErr, strings.TrimSpace(string(removeOut)))
		}
		return true, fmt.Errorf("gitworktree: rollback failed create %q: worktree remains registered", path)
	}
	// Git removes its own worktree directory. A path that reappears after the
	// registration check may belong to a new creator, so never RemoveAll here.
	if _, err := os.Lstat(path); err == nil {
		return false, fmt.Errorf("gitworktree: preserve unregistered path %q after rollback without claiming cleanup custody", path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, fmt.Errorf("gitworktree: inspect path %q after rollback: %w", path, err)
	}
	return false, nil
}

func (w *Workspace) rollbackWorkspaceProjectRepos(ctx context.Context, created []workspaceProjectRepo, branch string) error {
	var rollbackErr error
	for i := len(created) - 1; i >= 0; i-- {
		repo := created[i]
		if err := w.forceDestroyPath(ctx, repo.repoPath, repo.outputPath); err != nil {
			rollbackErr = errors.Join(rollbackErr, err)
			continue
		}
		if _, err := w.run(ctx, w.binary, deleteRefArgs(repo.repoPath, "refs/heads/"+branch)...); err != nil {
			rollbackErr = errors.Join(rollbackErr, fmt.Errorf("gitworktree: delete rolled-back branch %q in %q: %w", branch, repo.repoPath, err))
		}
	}
	return rollbackErr
}

func (w *Workspace) forceDestroyPath(ctx context.Context, repo, path string) error {
	_, _ = w.run(ctx, w.binary, worktreeForceRemoveArgs(repo, path)...)
	if err := w.pruneWorktrees(ctx, repo); err != nil {
		return err
	}
	if err := removeAllWithRetry(ctx, path); err != nil {
		return fmt.Errorf("gitworktree: force remove path %q: %w", path, err)
	}
	return nil
}

func (w *Workspace) pruneWorktrees(ctx context.Context, repo string) error {
	if _, err := w.run(ctx, w.binary, worktreePruneArgs(repo)...); err != nil {
		return fmt.Errorf("gitworktree: worktree prune: %w", err)
	}
	return nil
}

func isMissingRegisteredWorktreeError(err error) bool {
	return strings.Contains(err.Error(), "is a missing but already registered worktree")
}

func isLockedWorktreeRemoveError(err error) bool {
	return strings.Contains(err.Error(), "cannot remove a locked working tree")
}

func (w *Workspace) revParse(ctx context.Context, repo, ref string) (string, error) {
	out, err := w.run(ctx, w.binary, "-C", repo, "rev-parse", "--verify", ref)
	if err != nil {
		return "", fmt.Errorf("gitworktree: rev-parse %q: %w", ref, err)
	}
	return strings.TrimSpace(string(out)), nil
}

func (w *Workspace) validateBranch(ctx context.Context, repo, branch string) error {
	if _, err := w.run(ctx, w.binary, checkRefFormatBranchArgs(repo, branch)...); err != nil {
		return fmt.Errorf("%w: %q (%w)", ErrBranchInvalid, branch, err)
	}
	return nil
}

// errNoBaseRef is an internal sentinel: every candidate base ref is missing.
// addWorktree translates it into ErrBranchNotFetched.
var errNoBaseRef = errors.New("gitworktree: no base ref found")

func (w *Workspace) resolveBaseRef(ctx context.Context, repo, branch, baseBranch string) (string, error) {
	if strings.TrimSpace(baseBranch) != "" {
		return w.resolveBaseRefFromDefault(ctx, repo, branch, baseBranch)
	}
	defaultBranch := w.inferRepoDefaultBranch(ctx, repo)
	return w.resolveBaseRefFromDefault(ctx, repo, branch, defaultBranch)
}

func (w *Workspace) resolveBaseRefFromDefault(ctx context.Context, repo, branch, defaultBranch string) (string, error) {
	candidates := baseRefCandidates(branch, defaultBranch)
	for _, ref := range candidates {
		exists, err := w.refExists(ctx, repo, ref)
		if err != nil {
			return "", err
		}
		if exists {
			return ref, nil
		}
	}
	// Also probe a same-named tag so requests like `--branch v1.2.3` can
	// auto-track when the tag is fetched but no branch ref exists.
	tagRef := "refs/tags/" + branch
	exists, err := w.refExists(ctx, repo, tagRef)
	if err != nil {
		return "", err
	}
	if exists {
		return tagRef, nil
	}
	return "", fmt.Errorf("%w for branch %q (tried %s, %s)", errNoBaseRef, branch, strings.Join(candidates, ", "), tagRef)
}

func (w *Workspace) inferRepoDefaultBranch(ctx context.Context, repo string) string {
	for _, args := range [][]string{
		{"symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"},
		{"branch", "--show-current"},
	} {
		out, err := w.run(ctx, w.binary, append([]string{"-C", repo}, args...)...)
		if err != nil {
			continue
		}
		branch := strings.TrimSpace(string(out))
		branch = strings.TrimPrefix(branch, "origin/")
		if branch != "" {
			return branch
		}
	}
	return w.defaultBranch
}

func (w *Workspace) refExists(ctx context.Context, repo, ref string) (bool, error) {
	_, err := w.run(ctx, w.binary, revParseVerifyArgs(repo, ref)...)
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		return false, nil
	}
	return false, fmt.Errorf("gitworktree: verify ref %q: %w", ref, err)
}

// isDirty reports whether the worktree at path has uncommitted changes or
// untracked files — the same check `git worktree remove` performs before
// refusing without --force.
func (w *Workspace) isDirty(ctx context.Context, path string) (bool, error) {
	out, err := w.run(ctx, w.binary, statusPorcelainArgs(path)...)
	if err != nil {
		return false, fmt.Errorf("gitworktree: status %q: %w", path, err)
	}
	return strings.TrimSpace(string(out)) != "", nil
}

func (w *Workspace) listRecords(ctx context.Context, repo string) ([]worktreeRecord, error) {
	out, err := w.run(ctx, w.binary, worktreeListPorcelainArgs(repo)...)
	if err != nil {
		return nil, fmt.Errorf("gitworktree: worktree list: %w", err)
	}
	records, err := parseWorktreePorcelain(string(out))
	if err != nil {
		return nil, fmt.Errorf("gitworktree: parse worktree list: %w", err)
	}
	return records, nil
}

func (w *Workspace) repoPath(project domain.ProjectID) (string, error) {
	repo, err := w.repos.RepoPath(project)
	if err != nil {
		return "", err
	}
	if repo == "" {
		return "", fmt.Errorf("gitworktree: no repo configured for project %q", project)
	}
	abs, err := physicalAbs(repo)
	if err != nil {
		return "", fmt.Errorf("gitworktree: repo path: %w", err)
	}
	return abs, nil
}

func (w *Workspace) repoPathForInfo(info ports.WorkspaceInfo) (string, error) {
	if info.RepoPath != "" {
		repo, err := physicalAbs(info.RepoPath)
		if err != nil {
			return "", fmt.Errorf("gitworktree: repo path: %w", err)
		}
		return repo, nil
	}
	if info.ProjectID == "" {
		return "", errors.New("gitworktree: project id is required")
	}
	return w.repoPath(info.ProjectID)
}

func (w *Workspace) repoPathForConfig(cfg ports.WorkspaceConfig) (string, error) {
	if cfg.RepoPath != "" {
		repo, err := physicalAbs(cfg.RepoPath)
		if err != nil {
			return "", fmt.Errorf("gitworktree: repo path: %w", err)
		}
		return repo, nil
	}
	return w.repoPath(cfg.ProjectID)
}

func physicalAbs(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return filepath.Clean(resolved), nil
	}
	parent := filepath.Dir(abs)
	base := filepath.Base(abs)
	for parent != "." && parent != string(os.PathSeparator) {
		if resolved, err := filepath.EvalSymlinks(parent); err == nil {
			return filepath.Join(resolved, base), nil
		}
		base = filepath.Join(filepath.Base(parent), base)
		parent = filepath.Dir(parent)
	}
	if resolved, err := filepath.EvalSymlinks(parent); err == nil {
		return filepath.Join(resolved, base), nil
	}
	return abs, nil
}

func validateConfig(cfg ports.WorkspaceConfig) error {
	if cfg.ProjectID == "" {
		return errors.New("gitworktree: project id is required")
	}
	if err := validatePathComponent("project id", string(cfg.ProjectID)); err != nil {
		return err
	}
	if cfg.Kind == domain.KindOrchestrator {
		prefix := resolvedSessionPrefix(cfg)
		if err := validatePathComponent("session prefix", prefix); err != nil {
			return err
		}
	} else {
		if cfg.SessionID == "" {
			return errors.New("gitworktree: session id is required")
		}
		if err := validatePathComponent("session id", string(cfg.SessionID)); err != nil {
			return err
		}
	}
	if cfg.Branch == "" {
		return errors.New("gitworktree: branch is required")
	}
	for _, directory := range cfg.SparseCheckout {
		if _, err := cleanRelativePath(directory); err != nil {
			return fmt.Errorf("gitworktree: sparse checkout path %q: %w", directory, err)
		}
	}
	return nil
}

func validateWorkspaceProjectConfig(cfg ports.WorkspaceProjectConfig) error {
	if err := validateConfig(ports.WorkspaceConfig{
		ProjectID:     cfg.ProjectID,
		SessionID:     cfg.SessionID,
		Kind:          cfg.Kind,
		SessionPrefix: cfg.SessionPrefix,
		Branch:        firstNonEmpty(cfg.Branch, defaultSessionBranchName(cfg.SessionID)),
		BaseBranch:    cfg.BaseBranch,
	}); err != nil {
		return err
	}
	if strings.TrimSpace(cfg.RootRepoPath) == "" {
		return errors.New("gitworktree: root repo path is required")
	}
	for _, repo := range cfg.Repos {
		if strings.TrimSpace(repo.Name) == "" {
			return errors.New("gitworktree: child repo name is required")
		}
		if err := validatePathComponent("child repo name", repo.Name); err != nil {
			return err
		}
		if strings.TrimSpace(repo.RepoPath) == "" {
			return fmt.Errorf("gitworktree: child repo %q path is required", repo.Name)
		}
		if _, err := cleanRelativePath(repo.RelativePath); err != nil {
			return fmt.Errorf("gitworktree: child repo %q: %w", repo.Name, err)
		}
	}
	return nil
}

// validatePathComponent rejects id values that could escape the managed root
// once joined into a path. filepath.Join cleans `..` before validateManagedPath
// runs, so a session id of "../other" would otherwise resolve back inside
// managedRoot while breaking per-project isolation. Reject any path separator
// or the special `.`/`..` components at the source.
func validatePathComponent(name, value string) error {
	if strings.ContainsAny(value, `/\`) {
		return fmt.Errorf("%w: %s %q must not contain path separators", ErrUnsafePath, name, value)
	}
	if value == "." || value == ".." {
		return fmt.Errorf("%w: %s %q must not be a path-traversal component", ErrUnsafePath, name, value)
	}
	return nil
}

func (w *Workspace) managedPath(cfg ports.WorkspaceConfig) (string, error) {
	var path string
	if cfg.Kind == domain.KindOrchestrator {
		prefix := resolvedSessionPrefix(cfg)
		path = filepath.Join(w.managedRoot, string(cfg.ProjectID), "orchestrator", prefix+"-orchestrator")
	} else {
		path = filepath.Join(w.managedRoot, string(cfg.ProjectID), string(cfg.SessionID))
	}
	return w.validateManagedPath(path)
}

func (w *Workspace) restorePath(cfg ports.WorkspaceConfig) (string, error) {
	if cfg.Path != "" {
		return w.validateManagedPath(cfg.Path)
	}
	return w.managedPath(cfg)
}

// resolvedSessionPrefix returns cfg.SessionPrefix when set, otherwise the first
// 12 characters of the project ID (matching the display-prefix convention).
func resolvedSessionPrefix(cfg ports.WorkspaceConfig) string {
	if p := strings.TrimSpace(cfg.SessionPrefix); p != "" {
		return p
	}
	id := string(cfg.ProjectID)
	if len(id) <= 12 {
		return id
	}
	return id[:12]
}

func defaultSessionBranchName(id domain.SessionID) string {
	return "ao/" + string(id)
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func cleanRelativePath(path string) (string, error) {
	rel := filepath.ToSlash(strings.TrimSpace(path))
	if rel == "" {
		return "", errors.New("relative path is required")
	}
	if strings.HasPrefix(rel, "/") {
		return "", fmt.Errorf("%w: relative path %q must not be absolute", ErrUnsafePath, path)
	}
	clean := filepath.ToSlash(filepath.Clean(filepath.FromSlash(rel)))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("%w: relative path %q escapes the workspace root", ErrUnsafePath, path)
	}
	return clean, nil
}

func (w *Workspace) validateManagedPath(path string) (string, error) {
	if path == "" {
		return "", fmt.Errorf("%w: empty path", ErrUnsafePath)
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("%w: %q is not absolute", ErrUnsafePath, path)
	}
	clean := filepath.Clean(path)
	if clean != path {
		return "", fmt.Errorf("%w: %q is not clean", ErrUnsafePath, path)
	}
	physical, err := physicalAbs(clean)
	if err != nil {
		return "", fmt.Errorf("gitworktree: resolve path %q: %w", path, err)
	}
	clean = physical
	inside, err := pathWithin(w.managedRoot, clean)
	if err != nil {
		return "", err
	}
	if !inside || clean == w.managedRoot {
		return "", fmt.Errorf("%w: %q is outside managed root %q", ErrUnsafePath, clean, w.managedRoot)
	}
	return clean, nil
}

func pathWithin(root, path string) (bool, error) {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false, fmt.Errorf("gitworktree: compare paths: %w", err)
	}
	return rel == "." || (rel != "" && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))), nil
}

func findWorktree(records []worktreeRecord, path string) (worktreeRecord, bool) {
	clean := filepath.Clean(path)
	for _, rec := range records {
		if filepath.Clean(rec.Path) == clean {
			return rec, true
		}
	}
	return worktreeRecord{}, false
}

func findWorktreeByBranch(records []worktreeRecord, branch string) (worktreeRecord, bool) {
	for _, rec := range records {
		if rec.Branch == branch {
			return rec, true
		}
	}
	return worktreeRecord{}, false
}

func pathExistsNonEmpty(path string) (bool, error) {
	entries, err := os.ReadDir(path)
	if err == nil {
		return len(entries) > 0, nil
	}
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	return false, fmt.Errorf("gitworktree: inspect path %q: %w", path, err)
}

func moveStrayPathAside(path string) (string, error) {
	for i := 0; i < 100; i++ {
		candidate := path + ".stray"
		if i > 0 {
			candidate = fmt.Sprintf("%s.stray-%d", path, i+1)
		}
		if _, err := os.Lstat(candidate); err == nil {
			continue
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("gitworktree: inspect stray destination %q: %w", candidate, err)
		}
		if err := os.Rename(path, candidate); err != nil {
			return "", fmt.Errorf("gitworktree: move stray path %q aside to %q: %w", path, candidate, err)
		}
		return candidate, nil
	}
	return "", fmt.Errorf("gitworktree: move stray path %q aside: no available destination", path)
}

func runCommand(ctx context.Context, binary string, args ...string) ([]byte, error) {
	cmd := aoprocess.CommandContext(ctx, binary, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return out, commandError{args: append([]string{binary}, args...), output: string(out), err: err}
	}
	return out, nil
}

type commandError struct {
	args   []string
	output string
	err    error
}

func (e commandError) Error() string {
	if strings.TrimSpace(e.output) == "" {
		return fmt.Sprintf("%s: %v", strings.Join(e.args, " "), e.err)
	}
	return fmt.Sprintf("%s: %v: %s", strings.Join(e.args, " "), e.err, strings.TrimSpace(e.output))
}

func (e commandError) Unwrap() error { return e.err }
