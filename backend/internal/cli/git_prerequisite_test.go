package cli

import (
	"context"
	"io"
	"strings"
	"testing"
)

func TestDaemonRejectsGitWithoutWorktreeAddReason(t *testing.T) {
	deps := DefaultDeps()
	deps.In = strings.NewReader("")
	deps.Out = io.Discard
	deps.Err = io.Discard
	deps.LookPath = func(string) (string, error) { return "/fake/git", nil }
	deps.CommandOutput = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("git version 2.35.0\n"), nil
	}
	err := executeWithDeps(deps, []string{"daemon"})
	if err == nil || !strings.Contains(err.Error(), "requires >= 2.36.0") {
		t.Fatalf("daemon prerequisite error = %v", err)
	}
}
