package cli

import (
	"bytes"
	"encoding/json"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"os"
	"strings"
	"testing"
)

func TestTmuxDoctorUsesSharedPrivateDiagnosticSchema(t *testing.T) {
	for _, test := range []struct {
		status string
		level  doctorLevel
	}{{"ok", doctorPass}, {"violation", doctorFail}, {"unknown", doctorWarn}} {
		diagnostic := tmux.ServerDiagnostic{Status: test.status, ServerPID: 111, ServerStartToken: "1000", Unit: "ao-staging-tmux.service", UnitMainPID: 111, UnitControlGroup: "/tmux", ServerControlGroup: "/tmux", DaemonControlGroup: "/daemon"}
		check := tmuxDoctorCheck(diagnostic)
		if check.Name != "tmux_cgroup" || check.Level != test.level {
			t.Fatalf("%+v", check)
		}
		encoded, err := json.Marshal(check)
		if err != nil {
			t.Fatal(err)
		}
		for _, key := range []string{"status", "server_pid", "server_start_token", "unit", "unit_main_pid", "unit_control_group", "server_control_group", "daemon_control_group"} {
			if !strings.Contains(string(encoded), `"`+key+`"`) {
				t.Fatalf("missing private field %s: %s", key, encoded)
			}
		}
	}
}

func TestTmuxOnlyDoctorDoesNotCreateDataDirectoryOrEmitTelemetry(t *testing.T) {
	cfg, ctx := ownershipFixture(t)
	var output bytes.Buffer
	root := NewRootCommand(ctx.deps)
	root.SetOut(&output)
	root.SetArgs([]string{"doctor", "--json", "--tmux-only"})
	if err := root.Execute(); err != nil {
		t.Fatal(err)
	}
	var report doctorReport
	if err := json.Unmarshal(output.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if len(report.Checks) != 1 || report.Checks[0].Name != "tmux_cgroup" || report.Checks[0].Level != doctorWarn {
		t.Fatalf("unexpected report: %+v", report)
	}
	if _, err := os.Stat(cfg.DataDir); !os.IsNotExist(err) {
		t.Fatalf("read-only probe created DataDir: %v", err)
	}
}
