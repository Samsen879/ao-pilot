package sessionmanager

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/google/uuid"
)

type capacityPreview struct {
	stops int
	fail  bool
}

type capacityBrowser struct {
	stops int
	fail  bool
}

func (b *capacityBrowser) DestroySession(context.Context, domain.SessionID) error {
	b.stops++
	if b.fail {
		return errors.New("browser still running")
	}
	return nil
}

func (p *capacityPreview) StopSession(context.Context, domain.SessionID) error {
	p.stops++
	if p.fail {
		return errors.New("preview still running")
	}
	return nil
}

func TestEmergencyStopPreservesWorkspaceAndPreventsAutomaticRestore(t *testing.T) {
	m, store, runtime, workspace, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	important := filepath.Join(rec.Metadata.WorkspacePath, "ignored-output.txt")
	if err := os.WriteFile(important, []byte("preserve me"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertSessionWorktree(ctx, domain.SessionWorktreeRecord{
		SessionID: rec.ID, RepoName: domain.RootWorkspaceRepoName,
		Branch: rec.Metadata.Branch, WorktreePath: rec.Metadata.WorkspacePath,
		State: "active",
	}); err != nil {
		t.Fatal(err)
	}

	stopped, err := m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 || runtime.destroys != 1 || workspace.destroys != 0 {
		t.Fatalf("stopped=%d destroys=%d workspace destroys=%d err=%v", stopped, runtime.destroys, workspace.destroys, err)
	}
	if content, err := os.ReadFile(important); err != nil || string(content) != "preserve me" {
		t.Fatalf("workspace file lost: %q %v", content, err)
	}
	rows, err := store.ListSessionWorktrees(ctx, rec.ID)
	if err != nil || len(rows) != 1 || rows[0].State != "unavailable" {
		t.Fatalf("worktree markers=%+v err=%v", rows, err)
	}
	stored, ok, err := store.GetSession(ctx, rec.ID)
	if err != nil || !ok || !stored.IsTerminated {
		t.Fatalf("session terminal=%v found=%v err=%v", stored.IsTerminated, ok, err)
	}
	if err := m.RestoreAll(ctx); err != nil {
		t.Fatal(err)
	}
	if runtime.creates != 1 {
		t.Fatalf("automatic restore created another runtime: %d", runtime.creates)
	}
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 0 || runtime.destroys != 1 {
		t.Fatalf("second stop=%d destroys=%d err=%v", stopped, runtime.destroys, err)
	}
}

func TestEmergencyStopCancelsInflightSpawnBeforeRuntimeLaunch(t *testing.T) {
	m, _, runtime, workspace, cfg := newSpawnFixture(t)
	created := make(chan struct{})
	release := make(chan struct{})
	workspace.onCreate = func() {
		close(created)
		<-release
	}
	spawnDone := make(chan error, 1)
	go func() {
		_, _, _, err := m.Spawn(context.Background(), cfg)
		spawnDone <- err
	}()
	select {
	case <-created:
	case <-time.After(5 * time.Second):
		close(release)
		t.Fatal("spawn did not reach workspace creation")
	}
	// The seed row has no runtime handle yet. The emergency stop must still
	// cancel its preparation so it cannot launch after this snapshot.
	_, _ = m.EmergencyStopAll(context.Background())
	close(release)
	select {
	case err := <-spawnDone:
		if err == nil {
			t.Fatal("inflight spawn committed after capacity stop")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("inflight spawn did not stop")
	}
	if runtime.creates != 0 {
		t.Fatalf("runtime launched after capacity stop: %d", runtime.creates)
	}
}

func TestEmergencyStopDuringRuntimeCreateDestroysNewHandle(t *testing.T) {
	m, _, runtime, _, cfg := newSpawnFixture(t)
	runtime.onCreate = func() {
		_, _ = m.EmergencyStopAll(context.Background())
	}
	if _, _, _, err := m.Spawn(context.Background(), cfg); err == nil {
		t.Fatal("spawn committed after emergency stop")
	}
	if runtime.creates != 1 || runtime.destroys != 1 || runtime.alive {
		t.Fatalf("runtime creates=%d destroys=%d alive=%v", runtime.creates, runtime.destroys, runtime.alive)
	}
}

func TestEmergencyStopRetriesFailedRuntimeDestroy(t *testing.T) {
	m, store, runtime, workspace, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	runtime.destroyErr = true
	stopped, err := m.EmergencyStopAll(ctx)
	if err == nil || stopped != 0 || workspace.destroys != 0 {
		t.Fatalf("failed destroy stopped=%d workspace destroys=%d err=%v", stopped, workspace.destroys, err)
	}
	stored, _, err := store.GetSession(ctx, rec.ID)
	if err != nil || stored.IsTerminated {
		t.Fatalf("failed destroy marked terminal=%v err=%v", stored.IsTerminated, err)
	}
	runtime.destroyErr = false
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 {
		t.Fatalf("retry stopped=%d err=%v", stopped, err)
	}
}

func TestEmergencyStopRetriesManagedBrowser(t *testing.T) {
	m, store, _, _, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	browser := &capacityBrowser{fail: true}
	m.browser = browser
	stopped, err := m.EmergencyStopAll(ctx)
	if err == nil || stopped != 0 || browser.stops != 1 {
		t.Fatalf("failed browser stop=%d calls=%d err=%v", stopped, browser.stops, err)
	}
	stored, _, err := store.GetSession(ctx, rec.ID)
	if err != nil || stored.IsTerminated {
		t.Fatalf("browser failure terminal=%v err=%v", stored.IsTerminated, err)
	}
	browser.fail = false
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 || browser.stops != 2 {
		t.Fatalf("browser retry stop=%d calls=%d err=%v", stopped, browser.stops, err)
	}
}

func TestEmergencyStopRetriesReviewerRuntime(t *testing.T) {
	m, store, _, _, cfg := newSpawnFixture(t)
	ctx := context.Background()
	rec, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	m.SetReviewerStopper(func(context.Context, domain.SessionID) error {
		calls++
		if calls == 1 {
			return errors.New("reviewer still running")
		}
		return nil
	})
	stopped, err := m.EmergencyStopAll(ctx)
	if err == nil || stopped != 0 || calls != 1 {
		t.Fatalf("failed reviewer stop=%d calls=%d err=%v", stopped, calls, err)
	}
	stored, _, err := store.GetSession(ctx, rec.ID)
	if err != nil || stored.IsTerminated {
		t.Fatalf("reviewer failure terminal=%v err=%v", stored.IsTerminated, err)
	}
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 1 || calls != 2 {
		t.Fatalf("reviewer retry stop=%d calls=%d err=%v", stopped, calls, err)
	}
}

func TestEmergencyStopStopsControllerFirstAndRetriesPreview(t *testing.T) {
	m, store, runtime, _, cfg := newSpawnFixture(t)
	ctx := context.Background()
	worker, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	cfg.AttemptID = uuid.NewString()
	cfg.Kind = domain.KindOrchestrator
	controller, _, _, err := m.Spawn(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	preview := &capacityPreview{fail: true}
	m.preview = preview
	var order []string
	runtime.onDestroy = func(handle ports.RuntimeHandle) { order = append(order, handle.ID) }
	stopped, err := m.EmergencyStopAll(ctx)
	if err == nil || stopped != 0 || len(order) != 2 || order[0] != string(controller.ID) || order[1] != string(worker.ID) {
		t.Fatalf("first stop=%d order=%v err=%v", stopped, order, err)
	}
	for _, id := range []domain.SessionID{controller.ID, worker.ID} {
		rec, _, getErr := store.GetSession(ctx, id)
		if getErr != nil || rec.IsTerminated {
			t.Fatalf("%s terminal after preview failure: %v %v", id, rec.IsTerminated, getErr)
		}
	}
	preview.fail = false
	stopped, err = m.EmergencyStopAll(ctx)
	if err != nil || stopped != 2 || preview.stops != 4 {
		t.Fatalf("retry stop=%d preview stops=%d err=%v", stopped, preview.stops, err)
	}
}
