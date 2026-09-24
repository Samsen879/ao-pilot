package lifecycle

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
)

type attemptedSessionReader struct{}

func (attemptedSessionReader) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return domain.SessionRecord{Activity: domain.Activity{State: domain.ActivityIdle}}, true, nil
}

type attemptedMessenger struct{ messages []string }

func (m *attemptedMessenger) Send(_ context.Context, _ domain.SessionID, msg string) error {
	m.messages = append(m.messages, msg)
	if len(m.messages) == 1 {
		return ports.ErrPaneDraftPending
	}
	return nil
}

func TestPartialPaneWriteIsNotRetriedOrClaimedDelivered(t *testing.T) {
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(attemptedSessionReader{}, messenger, nil), react: newReactionState()}
	for i, want := range []sendOnceOutcome{sendOnceAttempted, sendOnceAccounted, sendOnceAccounted} {
		outcome, err := m.sendOnce(context.Background(), "session", "", "review-key", "sha-and-review", "review text", 0)
		if err != nil || outcome != want {
			t.Fatalf("call %d outcome=%v err=%v", i, outcome, err)
		}
	}
	if len(messenger.messages) != 2 || messenger.messages[0] != "review text" || messenger.messages[1] != "" {
		t.Fatalf("pending draft was repasted: %#v", messenger.messages)
	}
}

func TestChangedSignatureSubmitsOldDraftBeforeNewMessage(t *testing.T) {
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(attemptedSessionReader{}, messenger, nil), react: newReactionState()}
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
	}
	if got := messenger.messages; len(got) != 3 || got[0] != "old text" || got[1] != "" || got[2] != "new text" {
		t.Fatalf("pane writes = %#v", got)
	}
}

func TestPartialReviewDoesNotPressEnterInReplacementWorker(t *testing.T) {
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(attemptedSessionReader{}, messenger, nil), react: newReactionState()}
	first, err := m.sendOnce(context.Background(), "old-worker", "", "review-key", "A", "old review", 0)
	if err != nil || first != sendOnceAttempted {
		t.Fatalf("first outcome=%v err=%v", first, err)
	}
	moved, err := m.sendOnce(context.Background(), "new-worker", "", "review-key", "A", "new review", 0)
	if err != nil || moved != sendOnceSuppressed || len(messenger.messages) != 1 {
		t.Fatalf("moved outcome=%v err=%v messages=%#v", moved, err, messenger.messages)
	}
}
