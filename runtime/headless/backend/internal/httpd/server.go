package httpd

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

const runFileRepairInterval = 5 * time.Second

// Server is the daemon's HTTP server together with its lifecycle: bind the
// loopback port, publish the running.json handshake, serve until the context
// is cancelled, then shut down gracefully and clean up the handshake file.
type Server struct {
	cfg    config.Config
	log    *slog.Logger
	http   *http.Server
	listen net.Listener

	shutdownRequested chan struct{}
	shutdownOnce      sync.Once
	ready             atomic.Bool
	serveStarted      chan struct{}
	publisher         *runfile.Publisher
}

// NewWithDeps constructs a Server with API dependencies supplied by the daemon
// and binds the listener immediately, before any running.json is written. The
// caller owns the returned Server's lifecycle via Run. termMgr may be nil, in
// which case the /mux terminal surface is not mounted.
//
// If the configured port is already held, it falls back to an OS-assigned
// ephemeral port rather than failing. A genuine peer AO daemon is ruled out
// upstream (the lifetime ownership admission in daemon.Run), so a conflict here
// means a non-AO process owns the port; exiting would only leave the desktop
// supervisor stuck on "daemon not ready". The actual bound port is logged
// ("daemon listening") and written to running.json, both of which the supervisor
// reads, so the fallback propagates to the renderer with no UI changes.
func NewWithDeps(cfg config.Config, log *slog.Logger, termMgr *terminal.Manager, deps APIDeps, publisher *runfile.Publisher) (*Server, error) {
	if publisher == nil {
		return nil, errors.New("daemon publisher is required")
	}
	log = loggerOrDefault(log)
	ln, err := net.Listen("tcp", cfg.Addr())
	if err != nil {
		if !isAddrInUse(err) {
			return nil, fmt.Errorf("bind %s: %w", cfg.Addr(), err)
		}
		// Configured port is taken by a non-AO process: retry on an ephemeral port.
		fallback, ferr := net.Listen("tcp", net.JoinHostPort(cfg.Host, "0"))
		if ferr != nil {
			return nil, fmt.Errorf("bind %s (in use) and ephemeral fallback: %w", cfg.Addr(), ferr)
		}
		log.Warn("configured port in use; bound an ephemeral port instead",
			"configured", cfg.Addr(), "bound", fallback.Addr().String())
		ln = fallback
	}

	srv := &Server{
		cfg:               cfg,
		publisher:         publisher,
		log:               log,
		listen:            ln,
		shutdownRequested: make(chan struct{}),
		serveStarted:      make(chan struct{}),
	}
	srv.http = &http.Server{
		Handler: NewRouterWithControl(cfg, log, termMgr, deps, ControlDeps{
			RequestShutdown: srv.requestShutdown,
			InstanceID:      publisher.InstanceID(),
			IsReady:         srv.ready.Load,
		}),
		// ReadHeaderTimeout guards against slow-loris even on loopback;
		// per-request body/handler timeouts are applied per-surface.
		ReadHeaderTimeout: 10 * time.Second,
	}
	return srv, nil
}

// Addr returns the actual bound address (useful when the configured port was 0
// and the OS chose one — primarily in tests).
func (s *Server) Addr() net.Addr { return s.listen.Addr() }

// Handler returns the loopback server's built router so the daemon can share
// the exact same handler instance with the LAN listener (via NewMobileLAN),
// keeping the loopback and LAN surfaces identical.
func (s *Server) Handler() http.Handler { return s.http.Handler }

// MarkReady opens the REST API and readiness probe after boot reconciliation.
func (s *Server) MarkReady() { s.ready.Store(true) }

// ServeStarted closes once the HTTP server enters its accept loop, after the
// run file is written. Restored agents can then deliver startup hooks.
func (s *Server) ServeStarted() <-chan struct{} { return s.serveStarted }

type servingListener struct {
	net.Listener
	once    sync.Once
	started chan struct{}
}

func (l *servingListener) Accept() (net.Conn, error) {
	l.once.Do(func() { close(l.started) })
	return l.Listener.Accept()
}

// Run serves until ctx is cancelled (SIGINT/SIGTERM via signal.NotifyContext),
// then performs a graceful shutdown bounded by cfg.ShutdownTimeout. It writes
// running.json before serving and removes it on the way out. Run blocks until
// shutdown is complete.
func (s *Server) Run(ctx context.Context) error {
	if s.publisher == nil {
		return errors.New("daemon publisher is required")
	}
	info := runfile.Info{
		PID:                   os.Getpid(),
		Port:                  s.boundPort(),
		StartedAt:             time.Now().UTC(),
		Owner:                 os.Getenv("AO_OWNER"),
		BrowserRuntimeToken:   os.Getenv("AO_BROWSER_RUNTIME_TOKEN"),
		BrowserRuntimeAddress: os.Getenv("AO_BROWSER_RUNTIME_ADDRESS"),
	}
	if err := s.publisher.Publish(info); err != nil {
		_ = s.listen.Close()
		return fmt.Errorf("write run-file: %w", err)
	}
	repairCtx, cancelRepair := context.WithCancel(ctx)
	repairDone := make(chan struct{})
	go s.maintainRunFile(repairCtx, repairDone, info)
	defer func() {
		cancelRepair()
		<-repairDone
		if err := s.publisher.Remove(); err != nil {
			s.log.Warn("failed to remove run-file", "path", s.cfg.RunFilePath, "err", err)
		}
	}()

	serveErr := make(chan error, 1)
	go func() {
		s.log.Info("daemon listening", "addr", s.Addr().String(), "pid", info.PID)
		// Serve returns ErrServerClosed on a clean Shutdown; that is success.
		if err := s.http.Serve(&servingListener{Listener: s.listen, started: s.serveStarted}); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serveErr <- err
			return
		}
		serveErr <- nil
	}()

	select {
	case err := <-serveErr:
		// Serve died on its own (bind already happened, so this is a real
		// runtime failure) before any shutdown signal.
		return err
	case <-s.shutdownRequested:
		s.log.Info("shutdown requested over HTTP", "timeout", s.cfg.ShutdownTimeout)
	case <-ctx.Done():
		s.log.Info("shutdown signal received, draining connections", "timeout", s.cfg.ShutdownTimeout)
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), s.cfg.ShutdownTimeout)
	defer cancel()

	if err := s.http.Shutdown(shutdownCtx); err != nil {
		// The deadline elapsed with connections still open; force them closed.
		s.log.Warn("graceful shutdown timed out, forcing close", "err", err)
		_ = s.http.Close()
		return fmt.Errorf("graceful shutdown exceeded %s: %w", s.cfg.ShutdownTimeout, err)
	}

	s.log.Info("daemon stopped cleanly")
	return <-serveErr
}

func (s *Server) maintainRunFile(ctx context.Context, done chan<- struct{}, info runfile.Info) {
	defer close(done)
	ticker := time.NewTicker(runFileRepairInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			restored, err := s.publisher.Restore(info)
			if err != nil {
				s.log.Warn("failed to inspect daemon run-file", "path", s.cfg.RunFilePath, "err", err)
				continue
			}
			if restored {
				s.log.Warn("restored missing daemon run-file", "path", s.cfg.RunFilePath, "pid", info.PID)
			}
		}
	}
}

func (s *Server) boundPort() int {
	if tcp, ok := s.listen.Addr().(*net.TCPAddr); ok {
		return tcp.Port
	}
	return s.cfg.Port
}

func (s *Server) requestShutdown() {
	s.shutdownOnce.Do(func() {
		close(s.shutdownRequested)
	})
}

// RequestShutdown triggers the same clean shutdown as POST /shutdown: it makes
// Run return so the daemon exits without tearing down sessions. Idempotent.
func (s *Server) RequestShutdown() { s.requestShutdown() }
