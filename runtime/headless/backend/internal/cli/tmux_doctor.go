package cli

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"time"
)

func (c *commandContext) checkTmuxCgroup(ctx context.Context, status daemonStatus) doctorCheck {
	diagnostic := tmux.ServerDiagnostic{Status: "unknown", Reason: "tmux_identity_unknown", Message: "daemon identity not verified", Unit: tmux.ResolveServerOptions(tmux.ServerOptions{}).Unit}
	if status.owned && status.PID > 1 {
		binary, err := c.deps.LookPath("tmux")
		if err != nil {
			diagnostic.Message = err.Error()
		} else {
			diagnostic = tmux.NewManagedServer(tmux.ServerOptions{Binary: binary, DaemonPID: status.PID, Timeout: 2 * time.Second}).Inspect(ctx)
		}
	}
	return tmuxDoctorCheck(diagnostic)
}
func tmuxDoctorCheck(diagnostic tmux.ServerDiagnostic) doctorCheck {
	level := doctorWarn
	if diagnostic.Status == "ok" {
		level = doctorPass
	} else if diagnostic.Status == "violation" {
		level = doctorFail
	}
	return doctorCheck{Level: level, Section: doctorSectionCore, Name: "tmux_cgroup", Message: diagnostic.Status + ": " + diagnostic.Message, Details: diagnostic}
}
