package httpd

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
)

func TestReadinessAndRESTStayClosedDuringRecovery(t *testing.T) {
	ready := false
	router := NewRouterWithControl(config.Config{}, nil, nil, APIDeps{Mobile: &controllers.MobileController{}}, ControlDeps{
		IsReady: func() bool { return ready },
	})

	assertStatus := func(path string, want int) {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("GET %s status = %d, want %d; body=%s", path, res.Code, want, res.Body.String())
		}
	}

	assertStatus("/healthz", http.StatusOK)
	assertStatus("/readyz", http.StatusServiceUnavailable)
	assertStatus("/api/v1/sessions", http.StatusServiceUnavailable)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/mobile/enable", nil)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST /api/v1/mobile/enable status = %d, want %d; body=%s", res.Code, http.StatusServiceUnavailable, res.Body.String())
	}

	ready = true
	assertStatus("/readyz", http.StatusOK)
}
