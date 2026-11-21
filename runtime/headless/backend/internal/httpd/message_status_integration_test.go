package httpd_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cli"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	sessionmanager "github.com/aoagents/agent-orchestrator/backend/internal/session_manager"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/go-chi/chi/v5"
)

type custodyMessenger struct{ sends atomic.Int32 }

func (m *custodyMessenger) Send(context.Context, domain.SessionID, string) error {
	m.sends.Add(1)
	return nil
}

// This exercises the public Cobra commands, actual HTTP and real temporary
// SQLite. It never starts a daemon, harness, tmux, systemd or product resource.
func TestMessageInspectionCLIHTTPAndSQLiteLateAck(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	store, err := sqlite.Open(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: root}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	messenger := &custodyMessenger{}
	manager := sessionmanager.New(sessionmanager.Deps{Store: store, Messenger: messenger})
	original, err := manager.SendMessage(ctx, session.ID, domain.MessageOptions{
		MessageID: "dispatch", Message: "private test content", RequireAck: true, AckTimeoutMS: 1,
	})
	if err != nil || original.Outcome != "ack_timeout" || messenger.sends.Load() != 1 {
		t.Fatal(original, err, messenger.sends.Load())
	}
	before, _, err := store.GetMessage(ctx, "dispatch")
	if err != nil {
		t.Fatal(err)
	}
	router := chi.NewRouter()
	api := httpd.NewAPI(config.Config{}, httpd.APIDeps{Sessions: sessionsvc.New(manager, store)})
	api.Register(router, func() bool { return false }) // recovery still blocks mutations
	var nonGET, armed atomic.Bool
	ackResult := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			nonGET.Store(true)
		}
		router.ServeHTTP(w, r)
		if r.URL.Path == "/api/v1/sessions/"+string(session.ID)+"/messages/dispatch" && armed.CompareAndSwap(true, false) {
			// The initial snapshot was already written. Only the fixture worker
			// performs the later ACK, independently of the observing command.
			_, err := manager.AckMessage(ctx, session.ID, "dispatch")
			ackResult <- err
		}
	}))
	defer server.Close()
	serverURL, _ := url.Parse(server.URL)
	_, portText, _ := net.SplitHostPort(serverURL.Host)
	port, _ := strconv.Atoi(portText)
	runFile := filepath.Join(root, "running.json")
	runBytes, _ := json.Marshal(map[string]any{"pid": os.Getpid(), "port": port, "startedAt": time.Now().UTC()})
	if err := os.WriteFile(runFile, runBytes, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("AO_RUN_FILE", runFile)
	t.Setenv("AO_SESSION_ID", "")
	run := func(args ...string) (string, error) {
		var out, errOut bytes.Buffer
		deps := cli.DefaultDeps()
		deps.HTTPClient = server.Client()
		command := cli.NewRootCommand(deps)
		command.SetOut(&out)
		command.SetErr(&errOut)
		command.SetArgs(args)
		err := command.Execute()
		return out.String(), err
	}
	shown, err := run("message", "show", "dispatch", "--session", string(session.ID), "--json")
	var shownStatus domain.MessageStatus
	if err != nil || json.Unmarshal([]byte(shown), &shownStatus) != nil || shownStatus.Outcome != "ack_timeout" ||
		strings.Contains(shown, "private test content") || strings.Contains(shown, before.TextSHA256) {
		t.Fatal(shown, err)
	}
	afterRead, _, _ := store.GetMessage(ctx, "dispatch")
	if afterRead != before {
		t.Fatal("HTTP/CLI show mutated persisted custody")
	}
	if _, err := run("message", "show", "dispatch", "--session", "other", "--json"); err == nil {
		t.Fatal("cross-session read succeeded")
	}
	armed.Store(true)
	observed, err := run("message", "watch", "dispatch", "--session", string(session.ID), "--timeout", "2s", "--json")
	if err != nil {
		t.Fatal(observed, err)
	}
	if err := <-ackResult; err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(observed), "\n")
	if len(lines) != 2 {
		t.Fatal("expected timeout and later ACK snapshots", observed)
	}
	var first, last domain.MessageStatus
	if json.Unmarshal([]byte(lines[0]), &first) != nil || json.Unmarshal([]byte(lines[1]), &last) != nil ||
		first.Outcome != "ack_timeout" || last.Outcome != "acknowledged" || last.Version <= first.Version {
		t.Fatal(observed)
	}
	if len(last.Previous) < 3 {
		t.Fatal("missing custody history", last)
	}
	timeout := last.Previous[len(last.Previous)-1]
	if timeout.Outcome != original.Outcome || timeout.Evidence != original.Evidence || timeout.Version != first.Version || last.Previous[0].Phase != "reserved" {
		t.Fatal("lost original timeout or reservation", last)
	}
	if nonGET.Load() || messenger.sends.Load() != 1 {
		t.Fatal("observation performed a mutation or replay", nonGET.Load(), messenger.sends.Load())
	}
}
