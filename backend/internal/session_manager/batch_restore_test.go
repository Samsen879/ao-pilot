package sessionmanager

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/reaper"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/google/uuid"
)

type batchTestRuntime struct {
	*fakeRuntime
	mu          sync.Mutex
	ids         []domain.SessionID
	live        map[string]bool
	active, max int
	entered     chan domain.SessionID
	release     <-chan struct{}
}

func (r *batchTestRuntime) Create(ctx context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	r.mu.Lock()
	r.ids = append(r.ids, cfg.SessionID)
	r.active++
	if r.active > r.max {
		r.max = r.active
	}
	r.mu.Unlock()
	if r.entered != nil {
		r.entered <- cfg.SessionID
		select {
		case <-r.release:
		case <-ctx.Done():
		}
	}
	r.mu.Lock()
	r.active--
	r.live[string(cfg.SessionID)] = true
	r.mu.Unlock()
	return ports.RuntimeHandle{ID: string(cfg.SessionID)}, ctx.Err()
}
func (r *batchTestRuntime) IsAlive(_ context.Context, h ports.RuntimeHandle) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.live[h.ID], nil
}
func (r *batchTestRuntime) Destroy(_ context.Context, h ports.RuntimeHandle) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.live, h.ID)
	return nil
}

func TestBatchRestoreOrdersOrchestratorsAndIsIdempotent(t *testing.T) {
	m, store, base, _, _ := newSpawnFixture(t)
	runtime := &batchTestRuntime{fakeRuntime: base, live: map[string]bool{}}
	m.runtime = runtime
	ctx := context.Background()
	root := t.TempDir()
	worker := seedBootRecoverySession(t, store, root, 1, domain.KindWorker, true, "removed")
	first := seedBootRecoverySession(t, store, root, 2, domain.KindOrchestrator, true, "removed")
	second := seedBootRecoverySession(t, store, root, 3, domain.KindOrchestrator, true, "") // explicit recovery does not require auto-restore marker
	result, err := m.RestoreProject(ctx, "fixture", 2)
	if err != nil || len(result.Results) != 3 {
		t.Fatalf("%+v %v", result, err)
	}
	if len(runtime.ids) != 3 || runtime.ids[2] != worker.ID {
		t.Fatalf("workers started before orchestrators finished: %v", runtime.ids)
	}
	for _, item := range result.Results {
		if item.Outcome != "restored" {
			t.Fatalf("%+v", item)
		}
	}
	for _, id := range []domain.SessionID{worker.ID, first.ID, second.ID} {
		rec, found, err := store.GetSession(ctx, id)
		if err != nil || !found || rec.IsTerminated || rec.ID != id {
			t.Fatalf("identity lost: %+v %v", rec, err)
		}
	}
	again, err := m.RestoreProject(ctx, "fixture", 2)
	if err != nil || len(runtime.ids) != 3 {
		t.Fatalf("duplicate runtime: %+v %v", again, err)
	}
	for _, item := range again.Results {
		if item.Outcome != "restored" || item.Reason != "already_running" {
			t.Fatalf("non-idempotent: %+v", item)
		}
	}
}

func TestBatchRestorePreservesHoldFailuresAndCancelledRecords(t *testing.T) {
	m, store, _, base, _ := newSpawnFixture(t)
	m.workspace = &bootRecoveryWorkspace{fakeWorkspace: base, applyErr: errors.New("replay failed")}
	ctx := context.Background()
	root := t.TempDir()
	pending, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker, IsTerminated: true, Metadata: domain.SessionMetadata{SpawnAttemptID: uuid.NewString()}})
	if err != nil {
		t.Fatal(err)
	}
	failed := seedBootRecoverySession(t, store, root, 1, domain.KindWorker, true, "removed")
	rows, _ := store.ListSessionWorktrees(ctx, failed.ID)
	rows[0].PreservedRef = "refs/ao/preserved/retry"
	if err := store.UpsertSessionWorktree(ctx, rows[0]); err != nil {
		t.Fatal(err)
	}
	good := seedBootRecoverySession(t, store, root, 2, domain.KindOrchestrator, true, "removed")
	result, err := m.RestoreProject(ctx, "fixture", 1)
	if err != nil {
		t.Fatal(err)
	}
	byID := map[domain.SessionID]BatchRestoreItem{}
	for _, item := range result.Results {
		byID[item.SessionID] = item
	}
	if byID[pending.ID].Outcome != "skipped_hold" || byID[failed.ID].Outcome != "failed" || byID[good.ID].Outcome != "restored" {
		t.Fatalf("%+v", result)
	}
	rows, err = store.ListSessionWorktrees(ctx, failed.ID)
	if err != nil || len(rows) != 1 || rows[0].PreservedRef != "refs/ao/preserved/retry" {
		t.Fatalf("lost replay custody: %+v %v", rows, err)
	}
	// Cancellation after an inventory has been captured must be an item failure,
	// rather than consuming an otherwise restorable session's recovery marker.
	cancelled := seedBootRecoverySession(t, store, root, 3, domain.KindWorker, true, "removed")
	cancelCtx, cancel := context.WithCancel(ctx)
	cancel()
	item := m.restoreBatchItem(cancelCtx, cancelled.ID)
	if item.Outcome != "failed" || item.Reason == "" {
		t.Fatalf("cancel hidden: %+v", item)
	}
	rows, err = store.ListSessionWorktrees(ctx, cancelled.ID)
	if err != nil || len(rows) != 1 {
		t.Fatalf("cancel lost marker: %+v %v", rows, err)
	}
	if _, err := os.Stat(cancelled.Metadata.WorkspacePath); err != nil {
		t.Fatal("cancel removed worktree", err)
	}
}

func TestBatchRestoreBoundsConcurrentLaunches(t *testing.T) {
	m, store, base, _, _ := newSpawnFixture(t)
	ctx := context.Background()
	release := make(chan struct{})
	entered := make(chan domain.SessionID, 4)
	runtime := &batchTestRuntime{fakeRuntime: base, live: map[string]bool{}, entered: entered, release: release}
	m.runtime = runtime
	for i := 1; i <= 4; i++ {
		seedBootRecoverySession(t, store, t.TempDir(), i, domain.KindWorker, true, "removed")
	}
	done := make(chan error, 1)
	go func() { _, err := m.RestoreProject(ctx, "fixture", 2); done <- err }()
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("two launches not admitted")
		}
	}
	runtime.mu.Lock()
	active := runtime.active
	runtime.mu.Unlock()
	if active != 2 {
		t.Fatalf("active=%d", active)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if runtime.max != 2 {
		t.Fatalf("concurrency cap bypassed: %d", runtime.max)
	}
}

func TestReconcileBeforeReaperPreservesAutomaticRecovery(t *testing.T) {
	for _, early := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordered", true: "old_interleaving"}[early], func(t *testing.T) {
			m, store, runtime, workspace, _ := newSpawnFixture(t)
			m.workspace = &bootRecoveryWorkspace{fakeWorkspace: workspace}
			rec := seedBootRecoverySession(t, store, t.TempDir(), 1, domain.KindWorker, false, "")
			observer := reaper.New(lifecycle.New(store, nil), store, runtime, reaper.Config{})
			if early {
				if err := observer.Tick(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.Reconcile(context.Background()); err != nil {
				t.Fatal(err)
			}
			if !early {
				if err := observer.Tick(context.Background()); err != nil {
					t.Fatal(err)
				}
			}
			restored, _, _ := store.GetSession(context.Background(), rec.ID)
			if early {
				if runtime.creates != 0 || !restored.IsTerminated {
					t.Fatal("old race not reproduced")
				}
			} else if runtime.creates != 1 || restored.IsTerminated {
				t.Fatal("ordered recovery eligibility consumed")
			}
		})
	}
}

type nativeResumeAgent struct {
	fakeAgent
	t            *testing.T
	id           domain.SessionID
	conversation string
}

func (a nativeResumeAgent) GetRestoreCommand(_ context.Context, cfg ports.RestoreConfig) ([]string, bool, error) {
	if cfg.Session.ID != string(a.id) || cfg.Session.Metadata[ports.MetadataKeyAgentSessionID] != a.conversation {
		a.t.Fatalf("native identity drift: %+v", cfg.Session)
	}
	return []string{"fake-resume", a.conversation}, true, nil
}

type nativeResumeResolver struct{ agent ports.Agent }

func (r nativeResumeResolver) Agent(domain.AgentHarness) (ports.Agent, bool) { return r.agent, true }
func TestBatchRestoreKeepsNativeConversationIdentity(t *testing.T) {
	m, store, _, _, _ := newSpawnFixture(t)
	ctx := context.Background()
	rec := seedBootRecoverySession(t, store, t.TempDir(), 1, domain.KindWorker, true, "")
	rec.Metadata.AgentSessionID = "native-conversation-unchanged"
	if err := store.UpdateSession(ctx, rec); err != nil {
		t.Fatal(err)
	}
	m.agents = nativeResumeResolver{nativeResumeAgent{t: t, id: rec.ID, conversation: rec.Metadata.AgentSessionID}}
	result, err := m.RestoreProject(ctx, "fixture", 1)
	if err != nil || len(result.Results) != 1 || result.Results[0].RestoreMode != RestoreModeNative {
		t.Fatalf("%+v %v", result, err)
	}
	got, _, err := store.GetSession(ctx, rec.ID)
	if err != nil || got.ID != rec.ID || got.Metadata.AgentSessionID != rec.Metadata.AgentSessionID {
		t.Fatalf("identity drift: %+v %v", got, err)
	}
}

func TestBatchCancellationReportsEveryCapturedItem(t *testing.T) {
	m, store, base, _, _ := newSpawnFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan domain.SessionID, 1)
	m.runtime = &batchTestRuntime{fakeRuntime: base, live: map[string]bool{}, entered: entered, release: make(chan struct{})}
	root := t.TempDir()
	for i := 1; i <= 3; i++ {
		seedBootRecoverySession(t, store, root, i, domain.KindWorker, true, "removed")
	}
	done := make(chan BatchRestoreResult, 1)
	go func() {
		result, err := m.RestoreProject(ctx, "fixture", 1)
		if err != nil {
			t.Error(err)
		}
		done <- result
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("restore did not start")
	}
	cancel()
	result := <-done
	if len(result.Results) != 3 {
		t.Fatalf("lost captured items: %+v", result)
	}
	for _, item := range result.Results {
		if item.Outcome != "failed" || item.Reason == "" {
			t.Fatalf("cancel hidden: %+v", item)
		}
		rows, err := store.ListSessionWorktrees(context.Background(), item.SessionID)
		if err != nil || len(rows) != 1 {
			t.Fatalf("cancel lost recovery custody: %+v %v", rows, err)
		}
	}
}
