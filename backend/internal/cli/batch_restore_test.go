package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/daemonmeta"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBatchRestoreCLI(t *testing.T) {
	for _, failed := range []bool{false, true} {
		for _, include := range []bool{false, true} {
			t.Run(fmt.Sprint(failed, include), func(t *testing.T) {
				root := t.TempDir()
				path := filepath.Join(root, "running.json")
				t.Setenv("AO_DATA_DIR", filepath.Join(root, "data"))
				t.Setenv("AO_RUN_FILE", path)
				if err := os.WriteFile(path, []byte(`{"pid":1234,"port":12345,"startedAt":"2026-10-23T00:00:00Z"}`), 0600); err != nil {
					t.Fatal(err)
				}
				deps := DefaultDeps()
				deps.ProcessAlive = func(int) bool { return true }
				deps.HTTPClient = &http.Client{Transport: ownershipTransport(func(req *http.Request) (*http.Response, error) {
					if req.URL.Path != "/api/v1/sessions/restore" || req.Method != http.MethodPost {
						t.Fatal("wrong route", req.URL)
					}
					var body struct {
						Project           string   `json:"project"`
						Concurrency       int      `json:"concurrency"`
						IncludeTerminated bool     `json:"includeTerminated"`
						SessionIDs        []string `json:"sessionIds"`
					}
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil || body.Project != "fixture" || body.Concurrency != 2 || body.IncludeTerminated != include || (include && (len(body.SessionIDs) != 1 || body.SessionIDs[0] != "fixture-1")) {
						t.Fatalf("request %+v %v", body, err)
					}
					outcome := "restored"
					if failed {
						outcome = "failed"
					}
					response := fmt.Sprintf(`{"projectId":"fixture","results":[{"sessionId":"fixture-1","outcome":%q,"reason":"fixture"}]}`, outcome)
					return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(response)), Header: make(http.Header)}, nil
				})}
				ctx := &commandContext{deps: deps}
				cmd := newSessionRestoreCommand(ctx)
				cmd.SilenceUsage, cmd.SilenceErrors = true, true
				var output bytes.Buffer
				cmd.SetOut(&output)
				cmd.SetErr(io.Discard)
				args := []string{"--project", "fixture", "--all", "--concurrency", "2", "--json"}
				if include {
					args = append(args, "--include-terminated", "--session-id", "fixture-1")
				}
				cmd.SetArgs(args)
				err := cmd.Execute()
				if (err != nil) != failed {
					t.Fatalf("wrong result %v output=%s", err, output.String())
				}
				if !json.Valid(output.Bytes()) || !strings.Contains(output.String(), "fixture-1") {
					t.Fatalf("invalid output %s", output.String())
				}
			})
		}
	}
}
func TestBatchRestoreCLIRejectsAmbiguousScope(t *testing.T) {
	for _, args := range [][]string{{"--all"}, {"id", "--all", "--project", "fixture"}, {"--all", "--project", "fixture", "--concurrency", "0"}, {"id", "--concurrency", "2"}, {"id", "--include-terminated"}, {"id", "--session-id", "fixture-1"}} {
		cmd := newSessionRestoreCommand(&commandContext{deps: DefaultDeps()})
		cmd.SetOut(io.Discard)
		cmd.SetErr(io.Discard)
		cmd.SetArgs(args)
		if err := cmd.Execute(); ExitCode(err) != 2 {
			t.Fatalf("%v error=%v code=%d", args, err, ExitCode(err))
		}
	}
}

func TestDegradedStatusIncludesStructuredReasons(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "running.json")
	t.Setenv("AO_DATA_DIR", filepath.Join(root, "data"))
	t.Setenv("AO_RUN_FILE", path)
	if err := os.WriteFile(path, []byte(`{"pid":1234,"port":12345,"startedAt":"2026-10-23T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	deps := DefaultDeps()
	deps.ProcessAlive = func(int) bool { return true }
	deps.HTTPClient = &http.Client{Transport: ownershipTransport(func(req *http.Request) (*http.Response, error) {
		status, code := "ok", 200
		reason := ""
		if req.URL.Path == "/readyz" {
			status, code = "degraded", 503
			reason = `,"reasons":[{"code":"session_reconcile_failed","message":"fixture"}]`
		}
		payload := fmt.Sprintf(`{"status":%q,"service":%q,"pid":1234%s}`, status, daemonmeta.ServiceName, reason)
		return &http.Response{StatusCode: code, Body: io.NopCloser(strings.NewReader(payload)), Header: make(http.Header)}, nil
	})}
	result, err := (&commandContext{deps: deps}).inspectDaemon(context.Background())
	if err != nil || result.State != stateDegraded || len(result.Reasons) != 1 || result.Reasons[0].Code != "session_reconcile_failed" {
		t.Fatalf("%+v %v", result, err)
	}
}
