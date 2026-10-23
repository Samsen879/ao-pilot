package cli

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/legacyimport"
	"github.com/aoagents/agent-orchestrator/backend/internal/ownership"
	"github.com/aoagents/agent-orchestrator/backend/internal/runfile"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type ownershipTransport func(*http.Request) (*http.Response, error)

func (f ownershipTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func ownershipFixture(t *testing.T) (config.Config, *commandContext) {
	root := t.TempDir()
	cfg := config.Config{DataDir: filepath.Join(root, "data"), RunFilePath: filepath.Join(root, "running.json")}
	t.Setenv("AO_DATA_DIR", cfg.DataDir)
	t.Setenv("AO_RUN_FILE", cfg.RunFilePath)
	now := time.Unix(1, 0)
	deps := DefaultDeps()
	deps.Now = func() time.Time { return now }
	deps.Sleep = func(d time.Duration) { now = now.Add(d) }
	deps.OwnerProcessAlive = func(int) (bool, error) { return false, nil }
	deps.HTTPClient = &http.Client{Transport: ownershipTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("unexpected HTTP effect")
		return nil, errors.New("unexpected")
	})}
	return cfg, &commandContext{deps: deps}
}
func TestStopMissingDiscoveryWaitsForOwnership(t *testing.T) {
	cfg, c := ownershipFixture(t)
	p, err := runfile.Admit(cfg.DataDir, cfg.RunFilePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	_, err = c.stopDaemon(context.Background(), stopOptions{timeout: time.Millisecond})
	if !errors.Is(err, ownership.ErrBusy) {
		t.Fatalf("missing discovery bypassed owner: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	st, err := c.stopDaemon(context.Background(), stopOptions{timeout: time.Millisecond})
	if err != nil || st.State != stateStopped {
		t.Fatalf("quiet stop=%+v %v", st, err)
	}
}
func TestStopMissingRecordStillWaitsForOriginalProcess(t *testing.T) {
	cfg, c := ownershipFixture(t)
	for _, probe := range []runfile.ProcessProbe{func(int) (bool, error) { return true, nil }, func(int) (bool, error) { return false, errors.New("unknown") }} {
		c.deps.OwnerProcessAlive = probe
		_, err := c.waitForStopped(context.Background(), &runfile.Info{PID: 42, InstanceID: "old"}, cfg.RunFilePath, cfg.DataDir, time.Millisecond)
		if !errors.Is(err, runfile.ErrOwnerAlive) {
			t.Fatalf("premature stopped: %v", err)
		}
	}
}
func TestStopPreservesSuccessorAndDoesNotSendAnotherShutdown(t *testing.T) {
	cfg, c := ownershipFixture(t)
	p, err := runfile.Admit(cfg.DataDir, cfg.RunFilePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Publish(runfile.Info{PID: 42}); err != nil {
		t.Fatal(err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	_, err = c.waitForStopped(context.Background(), &runfile.Info{PID: 42, InstanceID: "previous"}, cfg.RunFilePath, cfg.DataDir, time.Millisecond)
	if !errors.Is(err, runfile.ErrSuccessor) {
		t.Fatalf("successor=%v", err)
	}
	if info, _ := runfile.Read(cfg.RunFilePath); info == nil || info.InstanceID != p.InstanceID() {
		t.Fatal("successor record removed")
	}
}
func TestImportBusyFailsBeforeSQLiteAndWithoutUsageTelemetry(t *testing.T) {
	cfg, c := ownershipFixture(t)
	p, err := runfile.Admit(cfg.DataDir, cfg.RunFilePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	for _, dry := range []bool{false, true} {
		_, err := c.executeImport(context.Background(), cfg, legacyimport.Options{Root: t.TempDir(), DryRun: dry})
		if !errors.Is(err, ownership.ErrBusy) || ExitCode(err) != 1 {
			t.Fatalf("dry=%v import error=%v", dry, err)
		}
	}
	files, err := os.ReadDir(cfg.DataDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if file.Name() != ".daemon-owner.lock" {
			t.Fatalf("failed admission wrote %s", file.Name())
		}
	}
	cmd := newImportCommand(c)
	if shouldEmitCLIInvocationForImport(cmd.Name()) {
		t.Fatal("import telemetry ran before admission")
	}
}

// Resolve the real registered command path so this tests the production gate.
func shouldEmitCLIInvocationForImport(name string) bool {
	root := NewRootCommand(Deps{})
	cmd, _, _ := root.Find([]string{name})
	return shouldEmitCLIInvocation(cmd)
}
func TestShutdownRequestBindsObservedLaunchAndLegacy(t *testing.T) {
	_, c := ownershipFixture(t)
	for _, instance := range []string{"launch-a", ""} {
		c.deps.HTTPClient = &http.Client{Transport: ownershipTransport(func(req *http.Request) (*http.Response, error) {
			want := instance
			if want == "" {
				want = runfile.LegacyInstance
			}
			if req.Header.Get(runfile.ExpectedInstanceHeader) != want {
				t.Fatalf("header=%q want=%q", req.Header.Get(runfile.ExpectedInstanceHeader), want)
			}
			return &http.Response{StatusCode: 202, Body: io.NopCloser(strings.NewReader("{}"))}, nil
		})}
		if err := c.requestShutdown(context.Background(), 12345, &runfile.Info{InstanceID: instance}); err != nil {
			t.Fatal(err)
		}
	}
}
