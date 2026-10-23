package httpd

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestShutdownRejectsPreviousLaunchBeforeAcknowledging(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   int
		called bool
	}{
		{"previous", http.StatusConflict, false},
		{runfile.LegacyInstance, http.StatusConflict, false},
		{"current", http.StatusAccepted, true},
		{"", http.StatusAccepted, true}, // compatibility only: old callers are unbound.
	} {
		called := false
		r := chi.NewRouter()
		mountControl(r, ControlDeps{InstanceID: "current", RequestShutdown: func() { called = true }})
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/shutdown", nil)
		req.RemoteAddr = "127.0.0.1:4567"
		if tc.header != "" {
			req.Header.Set(runfile.ExpectedInstanceHeader, tc.header)
		}
		res := httptest.NewRecorder()
		r.ServeHTTP(res, req)
		if res.Code != tc.want || called != tc.called {
			t.Fatalf("header=%q code=%d called=%v", tc.header, res.Code, called)
		}
	}
}
