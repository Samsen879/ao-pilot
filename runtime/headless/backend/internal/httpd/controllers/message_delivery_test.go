package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type messageControllerService struct {
	SessionService
	result domain.MessageResult
	calls  int
}

func (s *messageControllerService) SendMessage(_ context.Context, _ domain.SessionID, o domain.MessageOptions) (domain.MessageResult, error) {
	if err := sessionmanager.ValidateMessageOptions(o); err != nil {
		return domain.MessageResult{}, err
	}
	s.calls++
	return s.result, nil
}
func (s *messageControllerService) AckMessage(_ context.Context, _ domain.SessionID, _ string) (domain.MessageResult, error) {
	s.calls++
	return s.result, nil
}
func TestMessageHTTPAllBusinessOutcomes(t *testing.T) {
	for _, tc := range []struct {
		outcome string
		status  int
	}{{"submitted_confirmed", 200}, {"submitted_unconfirmed", 202}, {"rejected", 409}, {"acknowledged", 200}, {"ack_timeout", 504}} {
		t.Run(tc.outcome, func(t *testing.T) {
			svc := &messageControllerService{result: domain.MessageResult{MessageID: "message", Outcome: tc.outcome, Evidence: domain.MessageEvidence{Code: "FIXTURE", Signal: "none", RecordedAt: "now"}}}
			controller := &SessionsController{Svc: svc}
			res := httptest.NewRecorder()
			controller.SendMessage(res, httptest.NewRequest(http.MethodPost, "/sessions/s/messages", strings.NewReader(`{"message":"task"}`)))
			if res.Code != tc.status || svc.calls != 1 {
				t.Fatal(res.Code, res.Body.String())
			}
			var result domain.MessageResult
			if json.Unmarshal(res.Body.Bytes(), &result) != nil || result != svc.result {
				t.Fatal(res.Body.String())
			}
			if strings.Contains(res.Body.String(), `"ok"`) {
				t.Fatal("legacy success field")
			}
		})
	}
}
func TestMessageHTTPStrictBodyAndSafeAckID(t *testing.T) {
	svc := &messageControllerService{}
	controller := &SessionsController{Svc: svc}
	for _, body := range []string{`{"message":"task","extra":true}`, `{"message":"task"} {}`, `{"message":"task","require_ack":true,"ack_timeout_ms":0}`, `{"message":"task","ack_timeout_ms":1}`, `{"message":"task","require_ack":true,"ack_timeout_ms":null}`} {
		res := httptest.NewRecorder()
		controller.SendMessage(res, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)))
		if res.Code != 400 {
			t.Fatalf("body=%s status=%d body=%s", body, res.Code, res.Body.String())
		}
	}
	if svc.calls != 0 {
		t.Fatal("invalid body had effects")
	}
}
func TestClaimPRSpecificErrorCodes(t *testing.T) {
	for _, tc := range []struct {
		err  error
		code string
	}{{sessionsvc.ErrPRDraft, "PR_DRAFT"}, {sessionsvc.ErrPRMerged, "PR_MERGED"}, {sessionsvc.ErrPRClosed, "PR_CLOSED"}} {
		res := httptest.NewRecorder()
		writeSessionPRError(res, httptest.NewRequest(http.MethodPost, "/", nil), errors.Join(errors.New("wrapped"), tc.err))
		if res.Code != 409 || !strings.Contains(res.Body.String(), tc.code) {
			t.Fatal(res.Code, res.Body.String())
		}
	}
}
func TestAckHTTPRejectsExtraBodyFields(t *testing.T) {
	svc := &messageControllerService{}
	c := &SessionsController{Svc: svc}
	router := chi.NewRouter()
	router.Post("/sessions/{sessionId}/messages/{messageId}/ack", c.AckMessage)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/sessions/s/messages/id/ack", strings.NewReader(`{"message":"not allowed"}`)))
	if res.Code != 400 || svc.calls != 0 {
		t.Fatal(res.Code, svc.calls)
	}
}
