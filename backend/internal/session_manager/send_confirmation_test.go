package sessionmanager

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

type sendConfirmResolver struct{ agent ports.Agent }

func (r sendConfirmResolver) Agent(domain.AgentHarness) (ports.Agent, bool) {
	return r.agent, r.agent != nil
}

type sendConfirmMessenger struct {
	mu       sync.Mutex
	messages []string
	after    func(context.Context, int) error
}

func (m *sendConfirmMessenger) Send(ctx context.Context, _ domain.SessionID, message string) error {
	m.mu.Lock()
	m.messages = append(m.messages, message)
	call := len(m.messages)
	m.mu.Unlock()
	if m.after != nil {
		return m.after(ctx, call)
	}
	return nil
}

func (m *sendConfirmMessenger) snapshot() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]string(nil), m.messages...)
}

func newSendConfirmFixture(t *testing.T, messenger ports.AgentMessenger) (*Manager, *sqlite.Store, domain.SessionRecord) {
	t.Helper()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := context.Background()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "send-confirm", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	rec, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "send-confirm",
		Kind:      domain.KindOrchestrator,
		Harness:   domain.HarnessCodex,
		Activity: domain.Activity{
			State:          domain.ActivityIdle,
			LastActivityAt: time.Now().UTC(),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	m := New(Deps{
		Store:     store,
		Agents:    sendConfirmResolver{agent: codex.New()},
		Messenger: messenger,
	})
	m.sendConfirm = sendConfirmConfig{
		pollInterval:    time.Millisecond,
		attemptDeadline: 5 * time.Millisecond,
		maxAttempts:     3,
	}
	return m, store, rec
}

func TestSendRetriesCodexEnterUntilSubmitSignal(t *testing.T) {
	ctx := context.Background()
	messenger := &sendConfirmMessenger{}
	manager, store, rec := newSendConfirmFixture(t, messenger)
	messenger.after = func(ctx context.Context, call int) error {
		if call != 2 {
			return nil
		}
		current, ok, err := store.GetSession(ctx, rec.ID)
		if err != nil || !ok {
			return err
		}
		current.Activity = domain.Activity{State: domain.ActivityActive, LastActivityAt: time.Now().UTC()}
		return store.UpdateSession(ctx, current)
	}

	message := "continue the governed task\nwith the current handoff"
	if err := manager.Send(ctx, rec.ID, message); err != nil {
		t.Fatal(err)
	}
	got := messenger.snapshot()
	if len(got) != 2 || got[0] != message || got[1] != "" {
		t.Fatalf("send calls = %#v, want initial message followed by one Enter-only retry", got)
	}
}

func TestSendDoesNotRetryCodexEnterAfterPermissionRequest(t *testing.T) {
	ctx := context.Background()
	messenger := &sendConfirmMessenger{}
	manager, store, rec := newSendConfirmFixture(t, messenger)
	messenger.after = func(ctx context.Context, call int) error {
		if call != 1 {
			return nil
		}
		current, ok, err := store.GetSession(ctx, rec.ID)
		if err != nil || !ok {
			return err
		}
		current.Activity = domain.Activity{State: domain.ActivityBlocked, LastActivityAt: time.Now().UTC()}
		return store.UpdateSession(ctx, current)
	}

	if err := manager.Send(ctx, rec.ID, "message delivered as a permission dialog appears"); err != nil {
		t.Fatal(err)
	}
	got := messenger.snapshot()
	if len(got) != 1 {
		t.Fatalf("send calls = %#v, want no Enter retry after blocked activity", got)
	}
}
