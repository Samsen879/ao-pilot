package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
)

type attemptedSessionReader struct{}

type generatedAttemptReader struct {
	generation int64
	pending    bool
	owner      string
	complete   bool
}

func (s *generatedAttemptReader) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	return attemptedSessionReader{}.GetSession(ctx, id)
}
func (s *generatedAttemptReader) PaneDraftPending(context.Context, domain.SessionID) (bool, error) {
	return s.pending, nil
}
func (s *generatedAttemptReader) SetPaneDraftPending(_ context.Context, _ domain.SessionID, pending bool) error {
	s.pending = pending
	if pending {
		s.owner = ""
		s.complete = false
	}
	return nil
}
func (s *generatedAttemptReader) SetPaneDraftOwned(_ context.Context, _ domain.SessionID, owner string) error {
	s.pending = true
	s.owner = owner
	s.complete = false
	return nil
}
func (s *generatedAttemptReader) MarkPaneDraftComplete(_ context.Context, _ domain.SessionID, owner string) error {
	if s.owner != owner {
		return errors.New("wrong owner")
	}
	s.complete = true
	return nil
}
func (s *generatedAttemptReader) PaneDraftReceipt(context.Context, domain.SessionID) (bool, string, bool, int64, error) {
	return s.pending, s.owner, s.complete, s.generation, nil
}
func (s *generatedAttemptReader) PaneGeneration(context.Context, domain.SessionID) (int64, error) {
	return s.generation, nil
}
func (s *generatedAttemptReader) AdvancePaneGenerationAndClearDraft(context.Context, domain.SessionID) error {
	s.generation++
	s.pending = false
	s.owner = ""
	s.complete = false
	return nil
}

func (attemptedSessionReader) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}, true, nil
}

type attemptedMessenger struct{ messages []string }

type recordingMessenger struct{ messages []string }

func (m *recordingMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.messages = append(m.messages, msg)
	return nil
}

func (m *attemptedMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.messages = append(m.messages, msg)
	if len(m.messages) == 1 {
		return ports.ErrPaneDraftPending
	}
	return nil
}

func TestPartialPaneWriteIsNotRetriedOrClaimedDelivered(t *testing.T) {
	messenger := &attemptedMessenger{}
	store := &generatedAttemptReader{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	for i, want := range []sendOnceOutcome{sendOnceAttempted, sendOnceAccounted, sendOnceAccounted} {
		outcome, err := m.sendOnce(context.Background(), "session", "", "review-key", "sha-and-review", "review text", 0)
		if err != nil || outcome != want {
			t.Fatalf("call %d outcome=%v err=%v", i, outcome, err)
		}
		if i == 0 {
			store.complete = true // the first paste completed; only Enter was withheld
		}
	}
	if len(messenger.messages) != 2 || messenger.messages[0] != "review text" || messenger.messages[1] != "" {
		t.Fatalf("pending draft was repasted: %#v", messenger.messages)
	}
}

func TestChangedSignatureSubmitsOldDraftBeforeNewMessage(t *testing.T) {
	messenger := &attemptedMessenger{}
	store := &generatedAttemptReader{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	for i, input := range []struct {
		sig, text string
		want      sendOnceOutcome
	}{
		{"A", "old text", sendOnceAttempted},
		{"B", "new text", sendOnceSuppressed},
		{"B", "new text", sendOnceAccounted},
	} {
		outcome, err := m.sendOnce(context.Background(), "changed-signature", "", "review-key", input.sig, input.text, 0)
		if err != nil || outcome != input.want {
			t.Fatalf("call %d outcome=%v err=%v", i, outcome, err)
		}
		if i == 0 {
			store.complete = true
		}
	}
	if got := messenger.messages; len(got) != 3 || got[0] != "old text" || got[1] != "" || got[2] != "new text" {
		t.Fatalf("pane writes = %#v", got)
	}
}

func TestPartialReviewDoesNotPressEnterInReplacementWorker(t *testing.T) {
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(&generatedAttemptReader{}, messenger, nil), react: newReactionState()}
	first, err := m.sendOnce(context.Background(), "old-worker", "", "review-key", "A", "old review", 0)
	if err != nil || first != sendOnceAttempted {
		t.Fatalf("first outcome=%v err=%v", first, err)
	}
	moved, err := m.sendOnce(context.Background(), "new-worker", "", "review-key", "A", "new review", 0)
	if err != nil || moved != sendOnceSuppressed || len(messenger.messages) != 1 {
		t.Fatalf("moved outcome=%v err=%v messages=%#v", moved, err, messenger.messages)
	}
}

func TestPaneReplacementRetriesPartialReviewText(t *testing.T) {
	store := &generatedAttemptReader{}
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	id := domain.SessionID("replaced-review-pane")
	if outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "review text", 0); err != nil || outcome != sendOnceAttempted {
		t.Fatalf("first outcome=%v err=%v", outcome, err)
	}
	if _, err := sessionguard.ReplacePane(context.Background(), store, id, func() (ports.RuntimeHandle, error) {
		return ports.RuntimeHandle{ID: string(id)}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "review text", 0); err != nil || outcome != sendOnceSuppressed {
		t.Fatalf("replacement reconciliation outcome=%v err=%v", outcome, err)
	}
	if len(messenger.messages) != 1 {
		t.Fatalf("unexpected Enter into new pane: %#v", messenger.messages)
	}
	if outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "review text", 0); err != nil || outcome != sendOnceAccounted {
		t.Fatalf("retry outcome=%v err=%v", outcome, err)
	}
	if len(messenger.messages) != 2 || messenger.messages[1] != "review text" {
		t.Fatalf("review was not repasted into new pane: %#v", messenger.messages)
	}
}

func TestDurableOwnerRecoversReviewAfterSignatureCrash(t *testing.T) {
	id := domain.SessionID("review-recovery")
	owner := reviewDraftOwner(id, "review-key", "A")
	store := &generatedAttemptReader{pending: true, owner: owner, complete: true}
	messenger := &recordingMessenger{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "full review", 0)
	if err != nil || outcome != sendOnceAccounted || len(messenger.messages) != 1 || messenger.messages[0] != "" {
		t.Fatalf("outcome=%v err=%v messages=%#v", outcome, err, messenger.messages)
	}
}

func TestIncompleteOwnedReviewNeverSubmitsTruncatedText(t *testing.T) {
	id := domain.SessionID("incomplete-review")
	store := &generatedAttemptReader{pending: true, owner: reviewDraftOwner(id, "review-key", "A"), complete: false}
	messenger := &recordingMessenger{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "full review", 0)
	if err != nil || outcome != sendOnceSuppressed || len(messenger.messages) != 0 {
		t.Fatalf("outcome=%v err=%v messages=%#v", outcome, err, messenger.messages)
	}
}

func TestPartialReviewDoesNotSubmitAnotherOwnersDraft(t *testing.T) {
	id := domain.SessionID("review-owner-changed")
	store := &generatedAttemptReader{pending: true, owner: "", complete: true}
	messenger := &recordingMessenger{}
	m := &Manager{guard: sessionguard.New(store, messenger, nil), react: newReactionState()}
	m.react.seen["review-key"] = partialSendSignature(id, 0, "A")
	outcome, err := m.sendOnce(context.Background(), id, "", "review-key", "A", "review text", 0)
	if err != nil || outcome != sendOnceSuppressed || len(messenger.messages) != 0 {
		t.Fatalf("outcome=%v err=%v messages=%#v", outcome, err, messenger.messages)
	}
	if _, retained := m.react.seen["review-key"]; retained {
		t.Fatal("stale partial review marker retained")
	}
}
