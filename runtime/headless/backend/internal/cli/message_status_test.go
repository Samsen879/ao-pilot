package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/spf13/cobra"
)

func statusFixture(outcome string, version int64) domain.MessageStatus {
	signal := "none"
	if outcome == "acknowledged" {
		signal = "explicit_ack"
	}
	if outcome == "submitted_confirmed" {
		signal = "activity_active"
	}
	return domain.MessageStatus{
		SchemaVersion: domain.MessageStatusVersion, SessionID: "worker", RequireAck: true,
		Phase: "final", CreatedAt: "2026-11-14T00:00:00Z", Version: version,
		MessageResult: domain.MessageResult{MessageID: "id", Outcome: outcome,
			Evidence: domain.MessageEvidence{Code: "FIXTURE", Signal: signal, RecordedAt: "2026-11-14T00:00:01Z"}},
	}
}

func TestMessageShowReadsExistingOutcomeWithoutBusinessExitOrMutation(t *testing.T) {
	for _, outcome := range domain.NativeMessageContract().Outcomes {
		t.Run(outcome, func(t *testing.T) {
			calls := 0
			want := statusFixture(outcome, 2)
			c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
				calls++
				if req.Method != http.MethodGet {
					t.Fatal("inspection mutated", req.Method)
				}
				if req.URL.Path == "/api/v1/message-contract" {
					return messageHTTPResponse(200, domain.NativeMessageContract()), nil
				}
				if req.URL.Path != "/api/v1/sessions/worker/messages/id" {
					t.Fatal(req.URL.Path)
				}
				return messageHTTPResponse(200, want), nil
			})
			cmd := newMessageCommand(c)
			var out bytes.Buffer
			cmd.SetOut(&out)
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{"show", "id", "--session", "worker", "--json"})
			if err := cmd.Execute(); err != nil || calls != 2 {
				t.Fatal(err, calls)
			}
			var got domain.MessageStatus
			if json.Unmarshal(out.Bytes(), &got) != nil || !reflect.DeepEqual(got, want) {
				t.Fatal(out.String())
			}
		})
	}
}

func TestMessageStatusGETHasBoundedClientBudget(t *testing.T) {
	c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
		deadline, ok := req.Context().Deadline()
		if !ok || time.Until(deadline) < 14*time.Second || time.Until(deadline) > 15*time.Second {
			t.Fatal("status lookup inherited the two-minute mutation budget", deadline, ok)
		}
		return messageHTTPResponse(200, statusFixture("ack_timeout", 1)), nil
	})
	if _, err := c.readMessageStatus(context.Background(), "worker", "id"); err != nil {
		t.Fatal(err)
	}
}

func TestMessageInspectionRefusesBadInputOldCapabilityAndWrongIdentity(t *testing.T) {
	for _, args := range [][]string{
		{"show", "id"}, {"show", "bad/id", "--session", "worker"},
		{"watch", "id", "--session", "worker", "--timeout", "0s"},
		{"watch", "id", "--session", "worker", "--timeout", "16m"},
	} {
		calls := 0
		c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
			calls++
			return messageHTTPResponse(500, nil), nil
		})
		cmd := newMessageCommand(c)
		cmd.SetArgs(args)
		cmd.SetErr(io.Discard)
		if err := cmd.Execute(); ExitCode(err) != 2 || calls != 0 {
			t.Fatal(args, err, calls)
		}
	}
	for _, mode := range []string{"old", "wrong_session", "wrong_message", "unknown_schema", "malformed", "storage_error"} {
		t.Run(mode, func(t *testing.T) {
			reads := 0
			c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodGet {
					t.Fatal("inspection mutated")
				}
				if req.URL.Path == "/api/v1/message-contract" {
					contract := domain.NativeMessageContract()
					if mode == "old" {
						contract.ReadStatus = false
					}
					return messageHTTPResponse(200, contract), nil
				}
				reads++
				got := statusFixture("acknowledged", 2)
				switch mode {
				case "wrong_session":
					got.SessionID = "other"
				case "wrong_message":
					got.MessageID = "other"
				case "unknown_schema":
					got.SchemaVersion = "unknown"
				case "malformed":
					got.Evidence.Signal = "none"
				case "storage_error":
					return messageHTTPResponse(503, nil), nil
				}
				return messageHTTPResponse(200, got), nil
			})
			cmd := newMessageCommand(c)
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)
			cmd.SetArgs([]string{"show", "id", "--session", "worker", "--json"})
			if err := cmd.Execute(); err == nil {
				t.Fatal("invalid inspection became success")
			}
			if mode == "old" && reads != 0 {
				t.Fatal("unsupported daemon was queried past handshake")
			}
		})
	}
}

func TestMessageObservationUsageErrorsNeverWriteTelemetry(t *testing.T) {
	for _, args := range [][]string{
		{"message", "show", "id"},
		{"message", "watch", "bad/id", "--session", "worker"},
		{"message", "watch", "id", "--session", "worker", "--timeout", "16m"},
		{"message-contract", "--unknown-flag"},
	} {
		calls := 0
		c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
			calls++
			return messageHTTPResponse(500, nil), nil
		})
		c.deps.Out, c.deps.Err = io.Discard, io.Discard
		if err := executeWithDeps(c.deps, args); ExitCode(err) != 2 || calls != 0 {
			t.Fatal(args, err, calls)
		}
	}
}

func TestMessageWatchObservesLateAckAndBoundsWaiting(t *testing.T) {
	for _, mode := range []string{"late_ack", "rejected", "ordinary_notification", "timeout", "cancelled", "regressed", "same_version_changed"} {
		t.Run(mode, func(t *testing.T) {
			reads := 0
			c := messageCLIFixture(t, func(req *http.Request) (*http.Response, error) {
				if req.Method != http.MethodGet || req.URL.Path != "/api/v1/sessions/worker/messages/id" {
					t.Fatal("watch sent or acknowledged a message", req.Method, req.URL.Path)
				}
				reads++
				got := statusFixture("ack_timeout", 3)
				if mode == "late_ack" && reads >= 3 {
					got = statusFixture("acknowledged", 4)
				}
				if mode == "rejected" {
					got = statusFixture("rejected", 3)
				}
				if mode == "ordinary_notification" {
					got = statusFixture("submitted_unconfirmed", 3)
					got.RequireAck = false
				}
				if mode == "regressed" && reads > 1 {
					got.Version = 2
				}
				if mode == "same_version_changed" && reads > 1 {
					got.Outcome = "acknowledged"
					got.Evidence.Signal = "explicit_ack"
				}
				return messageHTTPResponse(200, got), nil
			})
			var out bytes.Buffer
			cmd := &cobra.Command{}
			cmd.SetOut(&out)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if mode == "cancelled" {
				cancel()
			}
			cmd.SetContext(ctx)
			err := c.watchMessageStatus(cmd, "worker", "id", true, 20*time.Millisecond, time.Millisecond)
			if (mode == "late_ack" || mode == "rejected" || mode == "ordinary_notification") != (err == nil) {
				t.Fatal(mode, err, out.String())
			}
			lines := strings.Split(strings.TrimSpace(out.String()), "\n")
			if mode == "late_ack" {
				if reads != 3 || len(lines) != 2 {
					t.Fatal(reads, out.String())
				}
				var first, last domain.MessageStatus
				if json.Unmarshal([]byte(lines[0]), &first) != nil || json.Unmarshal([]byte(lines[1]), &last) != nil ||
					first.Outcome != "ack_timeout" || last.Outcome != "acknowledged" {
					t.Fatal(out.String())
				}
			}
			if mode == "timeout" && (len(lines) != 1 || !strings.Contains(err.Error(), "MESSAGE_WATCH_ENDED")) {
				t.Fatal("pending state was misreported or repeated", out.String(), err)
			}
		})
	}
}
