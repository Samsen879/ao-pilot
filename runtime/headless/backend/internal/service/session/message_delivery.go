package session

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

type messageCommander interface {
	SendMessage(context.Context, domain.SessionID, domain.MessageOptions) (domain.MessageResult, error)
	AckMessage(context.Context, domain.SessionID, string) (domain.MessageResult, error)
}

func (s *Service) GetMessageStatus(ctx context.Context, id domain.SessionID, messageID string) (domain.MessageStatus, bool, error) {
	reader, ok := s.manager.(interface {
		GetMessageStatus(context.Context, domain.SessionID, string) (domain.MessageStatus, bool, error)
	})
	if !ok {
		return domain.MessageStatus{}, false, apierr.Internal("MESSAGE_CUSTODY_UNAVAILABLE", "message custody is unavailable")
	}
	status, found, err := reader.GetMessageStatus(ctx, id, messageID)
	var validation sessionmanager.MessageValidationError
	if errors.As(err, &validation) {
		return status, false, apierr.Invalid("INVALID_MESSAGE_ID", err.Error(), nil)
	}
	return status, found, err
}

func (s *Service) SendMessage(ctx context.Context, id domain.SessionID, o domain.MessageOptions) (domain.MessageResult, error) {
	manager, ok := s.manager.(messageCommander)
	if !ok {
		return domain.MessageResult{}, apierr.Internal("MESSAGE_CUSTODY_UNAVAILABLE", "message custody is unavailable")
	}
	result, err := manager.SendMessage(ctx, id, o)
	var validation sessionmanager.MessageValidationError
	if errors.As(err, &validation) {
		return result, apierr.Invalid("INVALID_MESSAGE", err.Error(), nil)
	}
	return result, err
}
func (s *Service) AckMessage(ctx context.Context, id domain.SessionID, messageID string) (domain.MessageResult, error) {
	manager, ok := s.manager.(messageCommander)
	if !ok {
		return domain.MessageResult{}, apierr.Internal("MESSAGE_CUSTODY_UNAVAILABLE", "message custody is unavailable")
	}
	result, err := manager.AckMessage(ctx, id, messageID)
	var validation sessionmanager.MessageValidationError
	if errors.As(err, &validation) {
		return result, apierr.Invalid("INVALID_MESSAGE_ID", err.Error(), nil)
	}
	return result, err
}
