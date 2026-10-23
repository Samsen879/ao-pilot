package session

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

func (s *Service) RestoreProject(ctx context.Context, project domain.ProjectID, concurrency int) (sessionmanager.BatchRestoreResult, error) {
	manager, ok := s.manager.(interface {
		RestoreProject(context.Context, domain.ProjectID, int) (sessionmanager.BatchRestoreResult, error)
	})
	if !ok {
		return sessionmanager.BatchRestoreResult{}, apierr.Internal("RESTORE_PROJECT_UNAVAILABLE", "batch restore is unavailable")
	}
	result, err := manager.RestoreProject(ctx, project, concurrency)
	if err != nil {
		return result, toAPIError(err)
	}
	return result, nil
}
