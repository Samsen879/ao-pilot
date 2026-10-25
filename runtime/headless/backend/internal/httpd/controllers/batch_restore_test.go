package controllers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
)

type batchControllerService struct {
	SessionService
	calls   int
	options sessionmanager.BatchRestoreOptions
}

func (s *batchControllerService) RestoreProject(_ context.Context, id domain.ProjectID, options sessionmanager.BatchRestoreOptions) (sessionmanager.BatchRestoreResult, error) {
	s.calls++
	s.options = options
	if id != "fixture" || options.Concurrency != 2 {
		panic("incorrect batch arguments")
	}
	return sessionmanager.BatchRestoreResult{ProjectID: id, Results: []sessionmanager.BatchRestoreItem{{SessionID: "fixture-1", Outcome: "restored", Reason: "already_running"}, {SessionID: "fixture-2", Outcome: "skipped_hold", Reason: "spawn_hold_or_pending"}, {SessionID: "fixture-3", Outcome: "failed", Reason: "replay pending"}}}, nil
}
func TestBatchRestoreHTTPValidatesAndPreservesPerItemOutcomes(t *testing.T) {
	service := &batchControllerService{}
	controller := &SessionsController{Svc: service}
	for _, body := range []string{`{}`, `{"project":"fixture","concurrency":0}`, `{"project":"fixture","concurrency":17}`, `{"project":"fixture","concurrency":2,"extra":true}`, `{"project":"fixture","concurrency":2} {}`} {
		res := httptest.NewRecorder()
		controller.RestoreProject(res, httptest.NewRequest(http.MethodPost, "/api/v1/sessions/restore", strings.NewReader(body)))
		if res.Code != http.StatusBadRequest {
			t.Fatalf("invalid body %s accepted: %d", body, res.Code)
		}
	}
	if service.calls != 0 {
		t.Fatal("invalid requests had effects")
	}
	res := httptest.NewRecorder()
	controller.RestoreProject(res, httptest.NewRequest(http.MethodPost, "/api/v1/sessions/restore", strings.NewReader(`{"project":"fixture","concurrency":2}`)))
	if res.Code != http.StatusOK || service.calls != 1 || service.options.IncludeTerminated || len(service.options.SessionIDs) != 0 {
		t.Fatalf("%d %s", res.Code, res.Body.String())
	}
	for _, outcome := range []string{"restored", "skipped_hold", "failed"} {
		if !strings.Contains(res.Body.String(), outcome) {
			t.Fatal("missing outcome", outcome)
		}
	}
}

func TestBatchRestoreHTTPForwardsExplicitHistoricalOptInAndBoundIDs(t *testing.T) {
	service := &batchControllerService{}
	controller := &SessionsController{Svc: service}
	res := httptest.NewRecorder()
	controller.RestoreProject(res, httptest.NewRequest(http.MethodPost, "/api/v1/sessions/restore", strings.NewReader(`{"project":"fixture","concurrency":2,"includeTerminated":true,"sessionIds":["fixture-1"]}`)))
	if res.Code != 200 || service.calls != 1 || !service.options.IncludeTerminated || len(service.options.SessionIDs) != 1 || service.options.SessionIDs[0] != "fixture-1" {
		t.Fatalf("%d %+v", res.Code, service.options)
	}
}
