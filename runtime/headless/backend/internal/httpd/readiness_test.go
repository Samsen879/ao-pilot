package httpd

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
)

type blockedListener struct {
	closed chan struct{}
	once   sync.Once
}

func (l *blockedListener) Accept() (net.Conn, error) { <-l.closed; return nil, net.ErrClosed }
func (l *blockedListener) Close() error              { l.once.Do(func() { close(l.closed) }); return nil }
func (l *blockedListener) Addr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 12345}
}

func TestServeStartsAfterRunFilePublication(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	publisher, err := runfile.Admit(filepath.Join(filepath.Dir(path), "data"), path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer publisher.Close()
	listener := &blockedListener{closed: make(chan struct{})}
	srv := &Server{
		cfg:               config.Config{RunFilePath: path, ShutdownTimeout: time.Second},
		publisher:         publisher,
		log:               slog.New(slog.NewTextHandler(os.Stderr, nil)),
		http:              &http.Server{Handler: http.NewServeMux()},
		listen:            listener,
		shutdownRequested: make(chan struct{}),
		serveStarted:      make(chan struct{}),
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- srv.Run(ctx) }()
	select {
	case <-srv.ServeStarted():
		info, err := runfile.Read(path)
		if err != nil || info == nil || info.Port != 12345 {
			t.Fatalf("run file at serve start: info=%v err=%v", info, err)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not enter accept loop")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

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
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/restored/activity", nil)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code == http.StatusServiceUnavailable {
		t.Fatalf("restored-agent activity hook was gated during recovery: %s", res.Body.String())
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/mobile/enable", nil)
	res = httptest.NewRecorder()
	router.ServeHTTP(res, req)
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("POST /api/v1/mobile/enable status = %d, want %d; body=%s", res.Code, http.StatusServiceUnavailable, res.Body.String())
	}

	ready = true
	assertStatus("/readyz", http.StatusOK)
}
