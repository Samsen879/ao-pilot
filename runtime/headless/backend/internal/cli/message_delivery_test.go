package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func messageCLIFixture(t *testing.T, transport ownershipTransport) *commandContext {
	t.Helper()
	root := t.TempDir()
	run := filepath.Join(root, "running.json")
	t.Setenv("AO_DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("AO_RUN_FILE", run)
	t.Setenv("AO_SESSION_ID", "")
	if err := os.WriteFile(run, []byte(`{"pid":1234,"port":12345,"startedAt":"2026-10-23T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	deps := DefaultDeps()
	deps.ProcessAlive = func(int) bool { return true }
	deps.HTTPClient = &http.Client{Transport: transport}
	return &commandContext{deps: deps}
}
func messageHTTPResponse(code int, body any) *http.Response {
	b, _ := json.Marshal(body)
	return &http.Response{StatusCode: code, Body: io.NopCloser(bytes.NewReader(b)), Header: make(http.Header)}
}
func TestMessageCLIOutcomesAndExitCodes(t *testing.T) {
	for _, item := range []struct {
		outcome      string
		status, exit int
		signal       string
	}{{"submitted_confirmed", 200, 0, "activity_active"}, {"submitted_unconfirmed", 202, 3, "none"}, {"rejected", 409, 4, "none"}, {"acknowledged", 200, 0, "explicit_ack"}, {"ack_timeout", 504, 5, "none"}} {
		t.Run(item.outcome, func(t *testing.T) {
			calls := 0
			c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
				calls++
				if req.URL.Path == "/api/v1/message-contract" {
					return messageHTTPResponse(200, domain.NativeMessageContract()), nil
				}
				if req.URL.Path != "/api/v1/sessions/fixture-1/messages" {
					t.Fatal("wrong send route", req.URL.Path)
				}
				var body domain.MessageOptions
				if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
					t.Fatal(err)
				}
				if body.Message != "task" || body.MessageID != "id" {
					t.Fatal(body)
				}
				return messageHTTPResponse(item.status, domain.MessageResult{MessageID: "id", Outcome: item.outcome, Evidence: domain.MessageEvidence{Code: "FIXTURE", Signal: item.signal, Attempts: 1, RecordedAt: time.Now().UTC().Format(time.RFC3339Nano)}}), nil
			})
			cmd := newSendCommand(c)
			cmd.SilenceUsage = true
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{"--session", "fixture-1", "--message", "task", "--message-id", "id", "--json"})
			err := cmd.Execute()
			if got := ExitCode(err); got != item.exit {
				t.Fatalf("exit=%d want=%d err=%v output=%s", got, item.exit, err, out.String())
			}
			if !json.Valid(out.Bytes()) || calls != 2 {
				t.Fatalf("calls=%d out=%s", calls, out.String())
			}
		})
	}
	if ExitCode(usageError{fmt.Errorf("bad")}) != 2 || ExitCode(fmt.Errorf("infra")) != 1 {
		t.Fatal("generic exits changed")
	}
}
func TestMessageCLIHandshakeThenOldDaemonNeverUsesLegacySend(t *testing.T) {
	legacy, modern := 0, 0
	c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
		switch req.URL.Path {
		case "/api/v1/message-contract":
			return messageHTTPResponse(200, domain.NativeMessageContract()), nil
		case "/api/v1/sessions/s/messages":
			modern++
			return messageHTTPResponse(404, map[string]string{"code": "NOT_FOUND"}), nil
		case "/api/v1/sessions/s/send":
			legacy++
			return messageHTTPResponse(200, map[string]bool{"ok": true}), nil
		default:
			t.Fatal(req.URL.Path)
			return nil, nil
		}
	})
	cmd := newSendCommand(c)
	cmd.SilenceUsage = true
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)
	cmd.SetArgs([]string{"--session", "s", "--message", "task", "--require-ack"})
	if err := cmd.Execute(); ExitCode(err) != 1 {
		t.Fatal(err)
	}
	if modern != 1 || legacy != 0 {
		t.Fatalf("modern=%d legacy injections=%d", modern, legacy)
	}
}
func TestMessageCLIRejectsUnsafeInputAndMissingCapabilityBeforeMutation(t *testing.T) {
	calls := 0
	c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
		calls++
		if req.Method != http.MethodGet {
			t.Fatal("mutation without capability")
		}
		return messageHTTPResponse(404, map[string]string{"code": "NOT_FOUND"}), nil
	})
	for _, args := range [][]string{{"--session", "s", "--message", "task", "--message-id", ""}, {"--session", "s", "--message", "task", "--message-id", "x;exit"}, {"--session", "s", "--message", "task", "--ack-timeout", "2s"}, {"--session", "s", "--message", "task", "--require-ack", "--ack-timeout", "61s"}} {
		cmd := newSendCommand(c)
		cmd.SilenceUsage = true
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetArgs(args)
		if err := cmd.Execute(); ExitCode(err) != 2 {
			t.Fatal(err)
		}
	}
	if calls != 0 {
		t.Fatal("invalid args performed HTTP")
	}
	cmd := newSendCommand(c)
	cmd.SilenceUsage = true
	cmd.SetArgs([]string{"--session", "s", "--message", "task"})
	cmd.SetErr(io.Discard)
	if err := cmd.Execute(); ExitCode(err) != 1 {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestAckCLIUsesBoundSessionAndDedicatedRoute(t *testing.T) {
	c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
		if req.URL.Path == "/api/v1/message-contract" {
			return messageHTTPResponse(200, domain.NativeMessageContract()), nil
		}
		if req.URL.Path != "/api/v1/sessions/worker/messages/id/ack" {
			t.Fatal(req.URL)
		}
		return messageHTTPResponse(200, domain.MessageResult{MessageID: "id", Outcome: "acknowledged", Evidence: domain.MessageEvidence{Code: "ACKNOWLEDGED", Signal: "explicit_ack", RecordedAt: "now"}}), nil
	})
	t.Setenv("AO_SESSION_ID", "worker")
	cmd := newAckCommand(c)
	cmd.SilenceUsage = true
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"id", "--json"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "acknowledged") {
		t.Fatal(out.String())
	}
	cmd = newAckCommand(c)
	cmd.SetArgs([]string{"id", "--session", "different"})
	cmd.SetErr(io.Discard)
	if err := cmd.Execute(); ExitCode(err) != 4 {
		t.Fatal(err)
	}
}
func TestMessageRequestBudgets(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) { return nil, req.Context().Err() })
	if err := c.checkMessageContract(ctx); err == nil {
		t.Fatal("ignored parent cancellation")
	}
}
