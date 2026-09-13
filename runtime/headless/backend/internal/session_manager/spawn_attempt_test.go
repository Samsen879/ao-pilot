package sessionmanager

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/spawnattempt"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"testing"
)

type fakeAgent struct{ hooks func(context.Context) error }

func (a fakeAgent) GetConfigSpec(context.Context) (ports.ConfigSpec, error) {
	return ports.ConfigSpec{}, nil
}
func (a fakeAgent) GetLaunchCommand(context.Context, ports.LaunchConfig) ([]string, error) {
	return []string{"fixture"}, nil
}
func (a fakeAgent) GetPromptDeliveryStrategy(context.Context, ports.LaunchConfig) (ports.PromptDeliveryStrategy, error) {
	return ports.PromptDeliveryInCommand, nil
}
func (a fakeAgent) GetAgentHooks(ctx context.Context, _ ports.WorkspaceHookConfig) error {
	if a.hooks != nil {
		return a.hooks(ctx)
	}
	return nil
}
func (a fakeAgent) GetRestoreCommand(context.Context, ports.RestoreConfig) ([]string, bool, error) {
	return nil, false, nil
}
func (a fakeAgent) SessionInfo(context.Context, ports.SessionRef) (ports.SessionInfo, bool, error) {
	return ports.SessionInfo{}, false, nil
}
func (a fakeAgent) ExitDetectionMode() ports.AgentExitDetectionMode {
	return ports.AgentExitDetectionSupervisor
}

type fakeResolver struct{ a fakeAgent }

func (r fakeResolver) Agent(domain.AgentHarness) (ports.Agent, bool) { return r.a, true }

type fakeRuntime struct {
	creates, destroys            int
	alive, destroyErr, createErr bool
	onCreate                     func()
}

func (r *fakeRuntime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	r.creates++
	r.alive = true
	if r.onCreate != nil {
		r.onCreate()
	}
	if r.createErr {
		return ports.RuntimeHandle{}, errors.New("partial create")
	}
	return ports.RuntimeHandle{ID: string(cfg.SessionID)}, nil
}
func (r *fakeRuntime) Destroy(ctx context.Context, _ ports.RuntimeHandle) error {
	r.destroys++
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if r.destroyErr {
		return errors.New("still live")
	}
	r.alive = false
	return nil
}
func (r *fakeRuntime) GetOutput(context.Context, ports.RuntimeHandle, int) (string, error) {
	return "", nil
}
func (r *fakeRuntime) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return r.alive, nil
}

type fakeWorkspace struct {
	root     string
	destroys int
	dirty    bool
	onCreate func()
}

func (w *fakeWorkspace) Create(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	p := filepath.Join(w.root, string(cfg.SessionID))
	if err := os.MkdirAll(p, 0700); err != nil {
		return ports.WorkspaceInfo{}, err
	}
	if w.onCreate != nil {
		w.onCreate()
	}
	return ports.WorkspaceInfo{Path: p, Branch: cfg.Branch, SessionID: cfg.SessionID, ProjectID: cfg.ProjectID}, nil
}
func (w *fakeWorkspace) Destroy(ctx context.Context, i ports.WorkspaceInfo) error {
	w.destroys++
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if w.dirty {
		return errors.New("dirty")
	}
	return os.RemoveAll(i.Path)
}
func (w *fakeWorkspace) Restore(ctx context.Context, cfg ports.WorkspaceConfig) (ports.WorkspaceInfo, error) {
	return w.Create(ctx, cfg)
}
func (w *fakeWorkspace) ForceDestroy(context.Context, ports.WorkspaceInfo) error {
	panic("forbidden force destroy")
}
func (w *fakeWorkspace) StashUncommitted(context.Context, ports.WorkspaceInfo) (string, error) {
	return "", nil
}
func (w *fakeWorkspace) ApplyPreserved(context.Context, ports.WorkspaceInfo, string) error {
	return nil
}
func (w *fakeWorkspace) AddExclude(context.Context, ports.WorkspaceInfo, ...string) error { return nil }

type fakeLifecycle struct {
	s         *sqlite.Store
	commitErr bool
}

func (l fakeLifecycle) PrepareLaunch(domain.SessionID, string) error { return nil }
func (l fakeLifecycle) CancelLaunch(domain.SessionID, string)        {}
func (l fakeLifecycle) MarkSpawned(ctx context.Context, id domain.SessionID, meta domain.SessionMetadata) error {
	if l.commitErr {
		return errors.New("commit fail")
	}
	r, _, err := l.s.GetSession(ctx, id)
	if err != nil {
		return err
	}
	r.Metadata = meta
	return l.s.UpdateSession(ctx, r)
}
func (l fakeLifecycle) MarkTerminated(ctx context.Context, id domain.SessionID) error {
	r, _, err := l.s.GetSession(ctx, id)
	if err != nil {
		return err
	}
	r.IsTerminated = true
	return l.s.UpdateSession(ctx, r)
}

type fakeMessenger struct{}

func (fakeMessenger) Send(context.Context, domain.SessionID, string) error { return nil }
func newSpawnFixture(t *testing.T) (*Manager, *sqlite.Store, *fakeRuntime, *fakeWorkspace, ports.SpawnConfig) {
	t.Helper()
	root := t.TempDir()
	s, err := sqlite.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	if err := s.UpsertProject(context.Background(), domain.ProjectRecord{ID: "fixture", Path: root, Kind: domain.ProjectKindSingleRepo}); err != nil {
		t.Fatal(err)
	}
	rt := &fakeRuntime{}
	ws := &fakeWorkspace{root: filepath.Join(root, "workspaces")}
	m := New(Deps{Runtime: rt, Workspace: ws, Store: s, Agents: fakeResolver{}, Lifecycle: fakeLifecycle{s: s}, Messenger: fakeMessenger{}, DataDir: root, LookPath: func(n string) (string, error) { return "/fixture/" + n, nil }, Executable: func() (string, error) { return "/fixture/ao", nil }, NewLaunchID: func() string { return "fixture-generation" }})
	return m, s, rt, ws, ports.SpawnConfig{AttemptID: uuid.NewString(), ProjectID: "fixture", Kind: domain.KindWorker, Harness: "codex"}
}
func TestCommittedAttemptReplay(t *testing.T) {
	m, s, rt, _, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	replay, _, _, err := m.Spawn(ctx, cfg)
	if err != nil || replay.ID != rec.ID || rt.creates != 1 {
		t.Fatalf("replay=%s creates=%d err=%v", replay.ID, rt.creates, err)
	}
	changed := cfg
	changed.Prompt = "different"
	if _, _, _, err = m.Spawn(ctx, changed); err == nil {
		t.Fatal("substitution")
	}
	rec.Metadata.RuntimeLaunchID = "replacement"
	s.UpdateSession(ctx, rec)
	if _, _, _, err = m.Spawn(ctx, cfg); err == nil {
		t.Fatal("generation replay")
	}
	if rt.creates != 1 {
		t.Fatal("second writer")
	}
}
func TestCanceledRequestIndependentRollback(t *testing.T) {
	m, s, rt, ws, cfg := newSpawnFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	rt.onCreate = cancel
	if _, _, _, err := m.Spawn(ctx, cfg); err == nil {
		t.Fatal("canceled success")
	}
	if rt.alive || ws.destroys != 1 {
		t.Fatalf("rollback alive=%v destroys=%d", rt.alive, ws.destroys)
	}
	rows, err := s.ListAllSessions(context.Background())
	if err != nil || len(rows) != 1 || !rows[0].IsTerminated {
		t.Fatal("missing terminal")
	}
	a, err := spawnattempt.Read(m.dataDir, cfg.AttemptID)
	if err != nil || a.Outcome != "failed" {
		t.Fatal("missing failed journal")
	}
	if _, _, _, err = m.Spawn(context.Background(), cfg); err == nil || rt.creates != 1 {
		t.Fatal("failed attempt retry")
	}
}
func TestRuntimeDestroyFailureProtectsWorkspaceAndRestore(t *testing.T) {
	m, s, rt, ws, cfg := newSpawnFixture(t)
	m.lcm = fakeLifecycle{s: s, commitErr: true}
	rt.destroyErr = true
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("unexpected success")
	}
	if !rt.alive || ws.destroys != 0 {
		t.Fatal("live workspace destroyed")
	}
	rows, _ := s.ListAllSessions(context.Background())
	if len(rows) != 1 || rows[0].Metadata.WorkspacePath == "" {
		t.Fatal("custody lost")
	}
	s.UpsertSessionWorktree(context.Background(), domain.SessionWorktreeRecord{SessionID: rows[0].ID, RepoName: "__root__", WorktreePath: rows[0].Metadata.WorkspacePath})
	if err := m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.creates != 1 || ws.destroys != 0 {
		t.Fatal("incomplete reconcile effects")
	}
	if _, err := m.RestoreWithMode(context.Background(), rows[0].ID); err == nil {
		t.Fatal("restore bypass")
	}
}
func TestPartialCreatePreservesResources(t *testing.T) {
	m, _, rt, ws, cfg := newSpawnFixture(t)
	rt.createErr = true
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("partial success")
	}
	if ws.destroys != 0 || !rt.alive {
		t.Fatal("ambiguous writer erased")
	}
	d, err := m.InspectSpawnAttempt(context.Background(), cfg.AttemptID)
	if err != nil || d.Action != "HOLD" || !d.Attempt.ResidualsUnknown {
		t.Fatal("false diagnosis")
	}
}
func TestDirtyDestroyRetainsCustody(t *testing.T) {
	m, s, rt, ws, cfg := newSpawnFixture(t)
	ws.dirty = true
	m.lcm = fakeLifecycle{s: s, commitErr: true}
	ws.onCreate = func() {
		s.UpsertSessionWorktree(context.Background(), domain.SessionWorktreeRecord{SessionID: "fixture-1", RepoName: "__root__", WorktreePath: filepath.Join(ws.root, "fixture-1")})
	}
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("success")
	}
	if rt.alive {
		t.Fatal("runtime not rolled back")
	}
	rows, _ := s.ListSessionWorktrees(context.Background(), "fixture-1")
	if len(rows) != 1 {
		t.Fatal("custody erased")
	}
}
func TestPrelaunchCancellationAndJournalFailure(t *testing.T) {
	for _, phase := range []string{"workspace", "prepare", "journal"} {
		t.Run(phase, func(t *testing.T) {
			m, _, rt, ws, cfg := newSpawnFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if phase == "workspace" {
				ws.onCreate = cancel
			}
			if phase == "prepare" {
				m.agents = fakeResolver{a: fakeAgent{hooks: func(ctx context.Context) error { cancel(); return ctx.Err() }}}
			}
			if phase == "journal" {
				m.agents = fakeResolver{a: fakeAgent{hooks: func(context.Context) error {
					return os.Rename(filepath.Join(m.dataDir, "spawn-attempts", cfg.AttemptID), filepath.Join(m.dataDir, "spawn-attempts", cfg.AttemptID+"-lost"))
				}}}
			}
			if _, _, _, err := m.Spawn(ctx, cfg); err == nil {
				t.Fatal("unexpected success")
			}
			if rt.creates != 0 {
				t.Fatal("business runtime launched")
			}
			if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
				t.Fatal("reservation reused")
			}
			if rt.creates != 0 {
				t.Fatal("second runtime")
			}
		})
	}
}
func TestCommitReplayMissingRuntimeAndConfigDrift(t *testing.T) {
	m, s, rt, _, cfg := newSpawnFixture(t)
	ctx := context.Background()
	if _, _, _, err := m.Spawn(ctx, cfg); err != nil {
		t.Fatal(err)
	}
	rt.alive = false
	if _, _, _, err := m.Spawn(ctx, cfg); err == nil {
		t.Fatal("missing runtime replay")
	}
	rt.alive = true
	project, _, _ := s.GetProject(ctx, "fixture")
	project.DisplayName = "changed"
	s.UpsertProject(ctx, project)
	if _, _, _, err := m.Spawn(ctx, cfg); err == nil {
		t.Fatal("config drift replay")
	}
	if rt.creates != 1 {
		t.Fatal("replay relaunched")
	}
}
func TestFailedSeedDoesNotReuseCustodyIdentity(t *testing.T) {
	m, _, rt, _, cfg := newSpawnFixture(t)
	m.agents = fakeResolver{a: fakeAgent{hooks: func(context.Context) error { return errors.New("prepare failed") }}}
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("failed seed succeeded")
	}
	m.agents = fakeResolver{}
	cfg.AttemptID = uuid.NewString()
	rec, _, _, err := m.Spawn(context.Background(), cfg)
	if err != nil || rec.ID != "fixture-2" || rt.creates != 1 {
		t.Fatalf("new attempt id=%s err=%v", rec.ID, err)
	}
}
func TestInitialCommitRequiresLiveRuntime(t *testing.T) {
	m, _, rt, _, cfg := newSpawnFixture(t)
	rt.onCreate = func() { rt.alive = false }
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("dead handle committed")
	}
	a, err := spawnattempt.Read(m.dataDir, cfg.AttemptID)
	if err != nil || a.Outcome == "committed" {
		t.Fatal("false durable commit")
	}
}

type fakeMultiWorkspace struct{ *fakeWorkspace }

func (w fakeMultiWorkspace) CreateWorkspaceProject(ctx context.Context, cfg ports.WorkspaceProjectConfig) (ports.WorkspaceProjectInfo, error) {
	root, err := w.Create(ctx, ports.WorkspaceConfig{ProjectID: cfg.ProjectID, SessionID: cfg.SessionID, Branch: cfg.Branch})
	if err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	child := filepath.Join(root.Path, "child")
	if err := os.MkdirAll(child, 0700); err != nil {
		return ports.WorkspaceProjectInfo{}, err
	}
	return ports.WorkspaceProjectInfo{Root: root, Worktrees: []ports.WorkspaceRepoInfo{{SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoName: "__root__", Path: root.Path, Branch: cfg.Branch}, {SessionID: cfg.SessionID, ProjectID: cfg.ProjectID, RepoName: "child", Path: child, Branch: cfg.Branch}}}, nil
}
func (w fakeMultiWorkspace) DestroyWorkspaceProject(context.Context, ports.WorkspaceProjectInfo) error {
	w.destroys++
	return errors.New("dirty child")
}

type failingWorktreeStore struct{ *sqlite.Store }

func (s failingWorktreeStore) UpsertSessionWorktree(ctx context.Context, row domain.SessionWorktreeRecord) error {
	if row.RepoName == "child" {
		return errors.New("bookkeeping failure")
	}
	return s.Store.UpsertSessionWorktree(ctx, row)
}
func TestPartialChildBookkeepingInventoryIsDurable(t *testing.T) {
	m, s, rt, ws, cfg := newSpawnFixture(t)
	project, _, _ := s.GetProject(context.Background(), "fixture")
	project.Kind = domain.ProjectKindWorkspace
	s.UpsertProject(context.Background(), project)
	m.workspace = fakeMultiWorkspace{ws}
	m.store = failingWorktreeStore{s}
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("partial bookkeeping success")
	}
	d, err := m.InspectSpawnAttempt(context.Background(), cfg.AttemptID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Attempt.Worktrees) != 2 || len(d.ObservedPaths) != 2 || !d.ObservedSession || rt.creates != 0 || ws.destroys != 0 {
		t.Fatalf("custody lost: %+v", d)
	}
	for _, state := range d.ObservedPaths {
		if state != "retained" {
			t.Fatal("known child not reconciled")
		}
	}
	if err := m.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
	if rt.creates != 0 || ws.destroys != 0 {
		t.Fatal("incomplete child restored")
	}
}

// Inject persisted checkpoints and reopen production SQLite. This is a recovery
// matrix, not a real kill/large HTTP materialization experiment.
func TestPersistedCheckpointRestartMatrix(t *testing.T) {
	for _, phase := range []string{"seed", "system_prompt", "workspace", "workspace_created", "workspace_bookkeeping", "provision", "prepare", "runtime", "commit"} {
		t.Run(phase, func(t *testing.T) {
			m, db, rt, _, cfg := newSpawnFixture(t)
			rec, _, _, err := m.Spawn(context.Background(), cfg)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint, err := spawnattempt.Read(m.dataDir, cfg.AttemptID)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint.Phase = phase
			checkpoint.Outcome = "running"
			checkpoint.ResidualsUnknown = true
			bytes, err := json.Marshal(checkpoint)
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(m.dataDir, "spawn-attempts", cfg.AttemptID, "record.json"), bytes, 0600); err != nil {
				t.Fatal(err)
			}
			db.Close()
			reopened, err := sqlite.Open(m.dataDir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			m.store = reopened
			m.lcm = fakeLifecycle{s: reopened}
			if _, _, _, err = m.Spawn(context.Background(), cfg); err == nil {
				t.Fatal("checkpoint retry")
			}
			if _, err = m.RestoreWithMode(context.Background(), rec.ID); err == nil {
				t.Fatal("checkpoint restore")
			}
			m.Reconcile(context.Background())
			m.RestoreAll(context.Background())
			m.SaveAndTeardownAll(context.Background())
			if rt.creates != 1 || rt.destroys != 0 {
				t.Fatal("checkpoint resource effect")
			}
			diagnosis, err := m.InspectSpawnAttempt(context.Background(), cfg.AttemptID)
			if err != nil || diagnosis.Action != "HOLD" || !diagnosis.ObservedSession {
				t.Fatalf("missing custody: %+v %v", diagnosis, err)
			}
		})
	}
}
