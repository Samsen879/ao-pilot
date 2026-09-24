package sessionguard

import (
	"context"
	"sync"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type partialMessenger struct{ messages []string }

func (m *partialMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.messages = append(m.messages, msg)
	if len(m.messages) == 1 {
		return ports.ErrPaneDraftPending
	}
	return nil
}

func TestPendingPaneDraftBlocksOtherMessagesAcrossGuards(t *testing.T) {
	store := &guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}}
	messenger := &partialMessenger{}
	id := domain.SessionID("pending-draft-cross-guard")
	first := New(store, messenger, nil)
	second := New(store, messenger, nil)
	if outcome, err := first.Deliver(context.Background(), id, "first"); err != nil || outcome != Attempted {
		t.Fatalf("first outcome=%s err=%v", outcome, err)
	}
	if outcome, err := second.Deliver(context.Background(), id, "second"); err != nil || outcome != SuppressedDraftPending {
		t.Fatalf("second outcome=%s err=%v", outcome, err)
	}
	if outcome, err := second.Deliver(context.Background(), id, ""); err != nil || outcome != Sent {
		t.Fatalf("enter outcome=%s err=%v", outcome, err)
	}
	if outcome, err := second.Deliver(context.Background(), id, "second"); err != nil || outcome != Sent {
		t.Fatalf("resumed outcome=%s err=%v", outcome, err)
	}
	if got := messenger.messages; len(got) != 3 || got[0] != "first" || got[1] != "" || got[2] != "second" {
		t.Fatalf("pane writes = %#v", got)
	}
}

type guardedStateStore struct {
	mu  sync.Mutex
	rec domain.SessionRecord
}

func (s *guardedStateStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rec, true, nil
}

func (s *guardedStateStore) block() {
	s.mu.Lock()
	s.rec.Activity.State = domain.ActivityBlocked
	s.mu.Unlock()
}

type blockingMessenger struct {
	store   *guardedStateStore
	entered chan struct{}
	release chan struct{}
}

func (m *blockingMessenger) Send(context.Context, domain.SessionID, string) error {
	close(m.entered)
	<-m.release
	m.store.block()
	return nil
}

func TestQueuedNudgeRechecksStateAfterPriorSend(t *testing.T) {
	store := &guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityWaitingInput}}}
	messenger := &blockingMessenger{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	firstGuard := New(store, messenger, nil)
	secondGuard := New(store, messenger, nil)

	firstDone := make(chan struct{})
	go func() {
		defer close(firstDone)
		_, _ = firstGuard.Deliver(context.Background(), "session", "message")
	}()
	<-messenger.entered

	result := make(chan Outcome, 1)
	go func() {
		outcome, _ := secondGuard.Nudge(context.Background(), "session", "")
		result <- outcome
	}()
	close(messenger.release)
	<-firstDone
	if outcome := <-result; outcome != SuppressedAwaitingUser {
		t.Fatalf("queued nudge outcome = %s, want %s", outcome, SuppressedAwaitingUser)
	}
}
