package controllers

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/go-chi/chi/v5"
	"net/http"
)

type TaskStore interface {
	TaskOverview(context.Context, string) (domain.TaskOverview, error)
	RecordCheckpoint(context.Context, string, string, domain.TaskCheckpoint) error
	SetProjectPause(context.Context, string, bool) error
}
type TasksController struct{ Store TaskStore }
type ProjectPauseInput struct {
	Paused *bool `json:"paused"`
}
type TaskWriteReceipt struct {
	Recorded bool `json:"recorded"`
}

func (c TasksController) List(w http.ResponseWriter, r *http.Request) {
	overview, err := c.Store.TaskOverview(r.Context(), r.URL.Query().Get("project"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, 200, overview)
}
func (c TasksController) Checkpoint(w http.ResponseWriter, r *http.Request) {
	var e domain.TaskCheckpoint
	id := chi.URLParam(r, "messageId")
	if !domain.ValidMessageID(id) || decodeMessageJSON(w, r, &e) != nil || !e.Valid() {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_CHECKPOINT", "Invalid checkpoint", nil)
		return
	}
	err := c.Store.RecordCheckpoint(r.Context(), string(sessionID(r)), id, e)
	if errors.Is(err, domain.ErrCheckpointConflict) {
		envelope.WriteAPIError(w, r, 409, "conflict", "CHECKPOINT_CONFLICT", "Task, session, pause or first-start precondition failed", nil)
		return
	}
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, 200, TaskWriteReceipt{true})
}
func (c TasksController) Pause(w http.ResponseWriter, r *http.Request) {
	var in ProjectPauseInput
	if decodeMessageJSON(w, r, &in) != nil || in.Paused == nil {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_PAUSE", "Explicit paused boolean required", nil)
		return
	}
	err := c.Store.SetProjectPause(r.Context(), chi.URLParam(r, "id"), *in.Paused)
	if errors.Is(err, domain.ErrMissingProject) {
		envelope.WriteAPIError(w, r, 404, "not_found", "PROJECT_NOT_FOUND", "Unknown project", nil)
		return
	}
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, 200, TaskWriteReceipt{true})
}
