package controllers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

const BatchRestoreTimeout = 15 * time.Minute

type BatchRestoreRequest struct {
	Project     string `json:"project" minLength:"1"`
	Concurrency int    `json:"concurrency" minimum:"1" maximum:"16"`
}

type ProjectRestorer interface {
	RestoreProject(context.Context, domain.ProjectID, int) (sessionmanager.BatchRestoreResult, error)
}

func (c *SessionsController) RestoreProject(w http.ResponseWriter, r *http.Request) {
	manager, ok := c.Svc.(ProjectRestorer)
	if !ok {
		apispec.NotImplemented(w, r, "POST", "/api/v1/sessions/restore")
		return
	}
	var request BatchRestoreRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", err.Error(), nil)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "expected exactly one JSON object", nil)
		return
	}
	if strings.TrimSpace(request.Project) == "" || request.Concurrency < 1 || request.Concurrency > sessionmanager.MaxRestoreConcurrency {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_RESTORE_OPTIONS", "project is required; concurrency must be 1..16", nil)
		return
	}
	result, err := manager.RestoreProject(r.Context(), domain.ProjectID(request.Project), request.Concurrency)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	// A successful batch request reports each individual failure explicitly.
	envelope.WriteJSON(w, http.StatusOK, result)
}
