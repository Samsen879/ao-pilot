package tmux

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type sessionListRunner struct {
	output string
	err    error
	calls  []string
}

func (r *sessionListRunner) Run(_ context.Context, _ []string, _ string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, strings.Join(args, " "))
	return []byte(r.output), r.err
}

func TestIsAliveOnVerifiedEmptyServer(t *testing.T) {
	for _, test := range []struct {
		name, output string
		err          error
		alive        bool
	}{
		{name: "empty", output: ""},
		{name: "exact", output: "session-a\n", alive: true},
		{name: "prefix_is_not_exact", output: "session-a-child\nother-session-a\n"},
		{name: "multiple", output: "session-b\nsession-a\n", alive: true},
		{name: "no_current_target_remains_unknown", output: "no current target", err: errors.New("exit 1")},
		{name: "missing_error_is_not_enumeration", output: "can't find session", err: errors.New("exit 1")},
		{name: "permission_remains_unknown", err: os.ErrPermission},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := New(Options{Binary: "tmux", Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux", Server: healthyTestServer{}})
			runner := &sessionListRunner{output: test.output, err: test.err}
			r.runner = runner
			alive, err := r.IsAlive(context.Background(), ports.RuntimeHandle{ID: "session-a"})
			if alive != test.alive || (err != nil) != (test.err != nil) {
				t.Fatalf("alive=%v err=%v, want alive=%v unknown=%v", alive, err, test.alive, test.err != nil)
			}
			if len(runner.calls) != 1 || runner.calls[0] != "-L ao-staging-test -N list-sessions -F #{session_name}" {
				t.Fatalf("unexpected probe or side effect: %v", runner.calls)
			}
		})
	}
}
