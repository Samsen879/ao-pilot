package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/go-chi/chi/v5"
)

type messageReaderFixture struct {
	SessionService
	status domain.MessageStatus
	found  bool
	err    error
	calls  int
	id     domain.SessionID
	msgID  string
}

func (s *messageReaderFixture) GetMessageStatus(_ context.Context, id domain.SessionID, messageID string) (domain.MessageStatus, bool, error) {
	s.calls++
	s.id, s.msgID = id, messageID
	return s.status, s.found, s.err
}

func TestMessageStatusHTTPReadContractAndFailures(t *testing.T) {
	for _, tc := range []struct {
		name, id string
		found    bool
		err      error
		code     int
	}{
		{"found", "message", true, nil, 200},
		{"missing", "message", false, nil, 404},
		{"invalid", "bad;id", true, nil, 400},
		{"storage_failure", "message", false, errors.New("PRIVATE_DATABASE_PATH"), 500},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc := &messageReaderFixture{found: tc.found, err: tc.err, status: domain.MessageStatus{
				SchemaVersion: domain.MessageStatusVersion, SessionID: "worker",
				MessageResult: domain.MessageResult{MessageID: "message", Outcome: "ack_timeout"},
			}}
			c := &SessionsController{Svc: svc}
			router := chi.NewRouter()
			router.Get("/sessions/{sessionId}/messages/{messageId}", c.GetMessageStatus)
			res := httptest.NewRecorder()
			router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/sessions/worker/messages/"+tc.id, nil))
			if res.Code != tc.code || strings.Contains(res.Body.String(), "PRIVATE_DATABASE_PATH") {
				t.Fatal(res.Code, res.Body.String())
			}
			if tc.code == 400 {
				if svc.calls != 0 {
					t.Fatal("invalid ID reached storage")
				}
			} else if svc.calls != 1 || svc.id != "worker" || svc.msgID != tc.id {
				t.Fatal(svc.calls, svc.id, svc.msgID)
			}
			if tc.code == 200 {
				var got domain.MessageStatus
				if json.Unmarshal(res.Body.Bytes(), &got) != nil || got != svc.status {
					t.Fatal(res.Body.String())
				}
			}
		})
	}
}

func TestMessageStatusHTTPUnavailableDoesNotUseMutatingService(t *testing.T) {
	svc := &messageControllerService{}
	c := &SessionsController{Svc: svc}
	router := chi.NewRouter()
	router.Get("/sessions/{sessionId}/messages/{messageId}", c.GetMessageStatus)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/sessions/worker/messages/message", nil))
	if res.Code != 503 || svc.calls != 0 {
		t.Fatal(res.Code, res.Body.String(), svc.calls)
	}
}
