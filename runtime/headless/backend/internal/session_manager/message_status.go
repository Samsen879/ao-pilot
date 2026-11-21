package sessionmanager

import (
	"context"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// GetMessageStatus consults custody only. Historical records remain readable
// after the agent exits; neither session liveness nor admission is mutated.
func (m *Manager) GetMessageStatus(ctx context.Context, id domain.SessionID, messageID string) (domain.MessageStatus, bool, error) {
	if strings.TrimSpace(string(id)) == "" || !domain.ValidMessageID(messageID) {
		return domain.MessageStatus{}, false, MessageValidationError{"session and safe message_id are required"}
	}
	store, ok := m.store.(interface {
		GetMessage(context.Context, string) (domain.MessageRecord, bool, error)
		MessageHistory(context.Context, string, int64) ([]domain.MessageRevision, error)
	})
	if !ok {
		return domain.MessageStatus{}, false, errors.New("message custody unavailable")
	}
	record, found, err := store.GetMessage(ctx, messageID)
	if err != nil {
		return domain.MessageStatus{}, false, err
	}
	// Do not disclose whether another session owns this ID.
	if !found || record.SessionID != id {
		return domain.MessageStatus{}, false, nil
	}
	history, err := store.MessageHistory(ctx, messageID, record.Version)
	if err != nil {
		return domain.MessageStatus{}, false, err
	}
	return domain.MessageStatus{
		Previous:      history,
		SchemaVersion: domain.MessageStatusVersion, MessageResult: record.MessageResult,
		SessionID: record.SessionID, RequireAck: record.RequireAck, Phase: record.Phase,
		Version: record.Version, CreatedAt: record.CreatedAt,
	}, true, nil
}
