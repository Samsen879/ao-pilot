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
