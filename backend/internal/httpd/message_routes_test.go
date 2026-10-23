package httpd

import (
	"context"
	"encoding/json"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type routeMessages struct {
	controllers.SessionService
	sendBudget, ackBudget time.Duration
	calls                 int
}

func (s *routeMessages) SendMessage(ctx context.Context, _ domain.SessionID, _ domain.MessageOptions) (domain.MessageResult, error) {
	deadline, _ := ctx.Deadline()
	s.sendBudget = time.Until(deadline)
	s.calls++
	return domain.MessageResult{MessageID: "id", Outcome: "submitted_unconfirmed", Evidence: domain.MessageEvidence{Code: "FIXTURE", Signal: "none", RecordedAt: "now"}}, nil
}
func (s *routeMessages) AckMessage(ctx context.Context, _ domain.SessionID, _ string) (domain.MessageResult, error) {
	deadline, _ := ctx.Deadline()
	s.ackBudget = time.Until(deadline)
	s.calls++
	return domain.MessageResult{MessageID: "id", Outcome: "acknowledged", Evidence: domain.MessageEvidence{Code: "ACKNOWLEDGED", Signal: "explicit_ack", RecordedAt: "now"}}, nil
}
func TestMessageRoutesCapabilitiesAliasAndDedicatedBudgets(t *testing.T) {
	service := &routeMessages{}
	api := NewAPI(config.Config{RequestTimeout: 110 * time.Second}, APIDeps{Sessions: service})
	router := chi.NewRouter()
	api.Register(router, func() bool { return true })
	for _, path := range []string{"/api/v1/sessions/s/messages", "/api/v1/sessions/s/send"} {
		res := httptest.NewRecorder()
		router.ServeHTTP(res, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"message":"task"}`)))
		if res.Code != 202 {
			t.Fatal(path, res.Code, res.Body.String())
		}
	}
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodPost, "/api/v1/sessions/s/messages/id/ack", strings.NewReader(`{}`)))
	if res.Code != 200 {
		t.Fatal(res.Code, res.Body.String())
	}
	if service.sendBudget < 89*time.Second || service.sendBudget > 90*time.Second || service.ackBudget < 9*time.Second || service.ackBudget > 10*time.Second {
		t.Fatal(service.sendBudget, service.ackBudget)
	}
	res = httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/message-contract", nil))
	var got domain.MessageContract
	if res.Code != 200 || json.Unmarshal(res.Body.Bytes(), &got) != nil || got.SchemaVersion != domain.MessageContractVersion || service.calls != 3 {
		t.Fatal(res.Code, res.Body.String())
	}
}
