package session

import (
	"errors"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"testing"
)

func TestOrdinarySendTypedErrorsKeepAPIClassification(t *testing.T) {
	for _, tc := range []struct {
		err  error
		kind apierr.Kind
		code string
	}{
		{sessionmanager.ErrNotFound, apierr.KindNotFound, "SESSION_NOT_FOUND"},
		{sessionmanager.ErrTerminated, apierr.KindConflict, "SESSION_TERMINATED"},
		{sessionmanager.ErrAgentExited, apierr.KindConflict, "AGENT_EXITED"},
		{sessionmanager.ErrAwaitingDecision, apierr.KindConflict, "SESSION_AWAITING_DECISION"},
		{sessionmanager.ErrDraftPending, apierr.KindConflict, "SESSION_DRAFT_PENDING"},
		{sessionmanager.ErrDraftIncomplete, apierr.KindConflict, "SESSION_DRAFT_INCOMPLETE"},
	} {
		t.Run(tc.code, func(t *testing.T) {
			mapped := toAPIError(fmt.Errorf("send fixture: %w", tc.err))
			var failure *apierr.Error
			if !errors.As(mapped, &failure) || failure.Code != tc.code || failure.Kind != tc.kind {
				t.Fatalf("mapped=%+v wanted=%s kind=%v", mapped, tc.code, tc.kind)
			}
		})
	}
}
