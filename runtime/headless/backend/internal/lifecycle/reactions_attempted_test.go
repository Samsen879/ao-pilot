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

type attemptedMessenger struct{ calls int }

func (m *attemptedMessenger) Send(context.Context, domain.SessionID, string) error {
	m.calls++
	return ports.ErrPaneDraftPending
}

func TestPartialPaneWriteIsNotRetriedOrClaimedDelivered(t *testing.T) {
	messenger := &attemptedMessenger{}
	m := &Manager{guard: sessionguard.New(attemptedSessionReader{}, messenger, nil), react: newReactionState()}
	for i := 0; i < 2; i++ {
		outcome, err := m.sendOnce(context.Background(), "session", "", "review-key", "sha-and-review", "review text", 0)
		if err != nil || outcome != sendOnceAttempted {
			t.Fatalf("call %d outcome=%v err=%v", i, outcome, err)
		}
	}
	if messenger.calls != 1 {
		t.Fatalf("partial write retried %d times", messenger.calls)
	}
}
