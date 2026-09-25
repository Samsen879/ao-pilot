package sessionguard

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type waitingSignalDuringPaste struct{ store *guardedStateStore }

type missingSessionStore struct{}

func (missingSessionStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return domain.SessionRecord{}, false, nil
}

func TestRejectedSessionIDsDoNotAccumulateLocks(t *testing.T) {
	guard := New(missingSessionStore{}, &partialMessenger{}, nil)
	for i := 0; i < 100; i++ {
		id := domain.SessionID(fmt.Sprintf("missing-%d", i))
		if outcome, err := guard.Deliver(context.Background(), id, "message"); err != nil || outcome != SuppressedNotFound {
			t.Fatalf("id=%s outcome=%s err=%v", id, outcome, err)
		}
	}
	sharedLocks.Lock()
	count := len(sharedLocks.bySession)
	sharedLocks.Unlock()
	if count != 0 {
		t.Fatalf("session lock registry retained %d completed operations", count)
	}
}

func (m waitingSignalDuringPaste) Send(context.Context, domain.SessionID, string) error {
	return nil
}

func (m waitingSignalDuringPaste) SendGuarded(ctx context.Context, _ domain.SessionID, _ string, check func(context.Context) error) error {
	if err := check(ctx); err != nil {
		return err
	}
	m.store.mu.Lock()
	m.store.rec.Activity.LastActivityAt = m.store.rec.Activity.LastActivityAt.Add(time.Second)
	m.store.mu.Unlock()
	if err := check(ctx); err != nil {
		return ports.ErrPaneDraftPending
	}
	return nil
}

func TestNewWaitingInputSignalWithholdsEnter(t *testing.T) {
	store := &guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityWaitingInput, LastActivityAt: time.Now()}}}
	guard := New(store, waitingSignalDuringPaste{store}, nil)
	if outcome, err := guard.Deliver(context.Background(), "codex-waiting", "prompt"); err != nil || outcome != Attempted {
		t.Fatalf("outcome=%s err=%v, want attempted without Enter", outcome, err)
	}
}

type partialMessenger struct{ messages []string }

type durableDraftStore struct {
	guardedStateStore
	pending    bool
	generation int64
}

type ownedDraftStore struct {
	durableDraftStore
	owner string
}

func (s *ownedDraftStore) PaneDraftReceipt(context.Context, domain.SessionID) (bool, string, bool, int64, error) {
	return s.pending, s.owner, true, s.generation, nil
}
func (s *ownedDraftStore) SetPaneDraftOwned(context.Context, domain.SessionID, string) error {
	return nil
}
func (s *ownedDraftStore) MarkPaneDraftComplete(context.Context, domain.SessionID, string) error {
	return nil
}

func TestOwnedPendingEnterRefusesDifferentDraftUnderLock(t *testing.T) {
	store := &ownedDraftStore{durableDraftStore: durableDraftStore{
		guardedStateStore: guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}},
		pending:           true,
	}, owner: "later-user"}
	messenger := &partialMessenger{}
	guard := New(store, messenger, nil)
	generation := int64(0)
	outcome, err := guard.SubmitPendingNudgeOwnedForGeneration(context.Background(), "owner-race", &generation, "original-review")
	if err != nil || outcome != SuppressedDraftPending || len(messenger.messages) != 0 {
		t.Fatalf("outcome=%s err=%v messages=%#v", outcome, err, messenger.messages)
	}
}

func (s *durableDraftStore) PaneGeneration(context.Context, domain.SessionID) (int64, error) {
	return s.generation, nil
}

func (s *durableDraftStore) AdvancePaneGenerationAndClearDraft(context.Context, domain.SessionID) error {
	s.generation++
	s.pending = false
	return nil
}

func (s *durableDraftStore) PaneDraftPending(context.Context, domain.SessionID) (bool, error) {
	return s.pending, nil
}

func (s *durableDraftStore) SetPaneDraftPending(_ context.Context, _ domain.SessionID, pending bool) error {
	s.pending = pending
	return nil
}

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

func TestManualPromptSubmissionClearsPendingPaneDraft(t *testing.T) {
	store := &durableDraftStore{guardedStateStore: guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}}}
	messenger := &partialMessenger{}
	id := domain.SessionID("manually-submitted-draft")
	guard := New(store, messenger, nil)
	if outcome, err := guard.Deliver(context.Background(), id, "first"); err != nil || outcome != Attempted || !store.pending {
		t.Fatalf("partial outcome=%s pending=%v err=%v", outcome, store.pending, err)
	}
	sharedLocks.Lock()
	delete(sharedLocks.pending, id) // simulate a fresh daemon with no process-local marker
	sharedLocks.Unlock()
	if outcome, err := New(store, messenger, nil).Deliver(context.Background(), id, "unsafe repaste"); err != nil || outcome != SuppressedDraftPending {
		t.Fatalf("restarted outcome=%s err=%v", outcome, err)
	}
	if err := ClearPendingPaneDraft(context.Background(), store, id); err != nil || store.pending {
		t.Fatalf("clear pending=%v err=%v", store.pending, err)
	}
	if outcome, err := guard.Deliver(context.Background(), id, "next"); err != nil || outcome != Sent {
		t.Fatalf("next outcome=%s err=%v", outcome, err)
	}
}

func TestRecoveredEnterRequiresOriginalDraftMarker(t *testing.T) {
	store := &durableDraftStore{guardedStateStore: guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}}}
	messenger := &partialMessenger{}
	id := domain.SessionID("recovered-enter")
	guard := New(store, messenger, nil)
	if outcome, err := guard.Deliver(context.Background(), id, "first"); err != nil || outcome != Attempted {
		t.Fatalf("initial send outcome=%s err=%v", outcome, err)
	}
	if err := ClearPendingPaneDraft(context.Background(), store, id); err != nil {
		t.Fatal(err)
	}
	if outcome, err := guard.SubmitPendingNudge(context.Background(), id); err != nil || outcome != AlreadySubmitted {
		t.Fatalf("recovery outcome=%s err=%v", outcome, err)
	}
	if len(messenger.messages) != 1 {
		t.Fatalf("unexpected Enter after manual submission: %#v", messenger.messages)
	}
}

func TestPaneReplacementInvalidatesOldDraft(t *testing.T) {
	store := &durableDraftStore{guardedStateStore: guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}}, pending: true}
	id := domain.SessionID("replacement")
	handle, err := ReplacePane(context.Background(), store, id, func() (ports.RuntimeHandle, error) {
		return ports.RuntimeHandle{ID: string(id)}, nil
	})
	if err != nil || handle.ID != string(id) || store.pending || store.generation != 1 {
		t.Fatalf("replacement handle=%v pending=%v generation=%d err=%v", handle, store.pending, store.generation, err)
	}
	old := int64(0)
	guard := New(store, &partialMessenger{}, nil)
	if outcome, err := guard.SubmitPendingNudgeForGeneration(context.Background(), id, &old); err != nil || outcome != PaneReplaced {
		t.Fatalf("old pane recovery outcome=%s err=%v", outcome, err)
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

func TestManualSubmissionWaitsForPaneSend(t *testing.T) {
	store := &guardedStateStore{rec: domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}}
	messenger := &blockingMessenger{store: store, entered: make(chan struct{}), release: make(chan struct{})}
	id := domain.SessionID("manual-during-send")
	guard := New(store, messenger, nil)
	sent := make(chan struct{})
	go func() {
		_, _ = guard.Deliver(context.Background(), id, "draft")
		close(sent)
	}()
	<-messenger.entered
	updated := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := RecordManualSubmission(context.Background(), store, id, time.Now(), func() error {
			close(updated)
			return nil
		})
		done <- err
	}()
	select {
	case <-updated:
		t.Fatal("manual submit updated state before in-flight pane send completed")
	case <-time.After(20 * time.Millisecond):
	}
	close(messenger.release)
	<-sent
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}
