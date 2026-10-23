package main

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"testing"
)

func TestStagingValidationRejectsProductionNamespace(t *testing.T) {
	for _, namespace := range []string{"ao-pilot", "ao-pilot-runtime.service", "default", ""} {
		s := settings{execute: true, namespace: namespace, root: "/tmp/not-used", canary: "fake"}
		if s.validate() == nil {
			t.Fatal("production namespace accepted")
		}
	}
	if (&settings{}).validate() == nil {
		t.Fatal("implicit effects allowed")
	}
}
func TestCanaryAndIdentityComparison(t *testing.T) {
	for _, output := range []string{"canary:1\ncanary:3", "canary:1\ncanary:2\ncanary:1", "none"} {
		if _, err := parseCounts(output); err == nil {
			t.Fatal("discontinuity accepted")
		}
	}
	counts, err := parseCounts("canary:1\ncanary:2\n")
	if err != nil {
		t.Fatal(err)
	}
	before := snapshot{Server: tmux.ServerDiagnostic{ServerPID: 111, ServerStartToken: "token"}, TmuxSessions: []string{"ao-fake:$0"}, Sessions: map[domain.SessionID]sessionIdentity{"fake": {Launch: "launch", Handle: "ao-fake"}}, Counts: counts}
	after := before
	after.Counts = []uint64{1, 2, 3}
	if err := compare(before, after); err != nil {
		t.Fatal(err)
	}
	after.Server.ServerStartToken = "changed"
	if err := compare(before, after); err == nil {
		t.Fatal("server restart hidden")
	}
	after = before
	after.Counts = []uint64{1, 2, 3}
	after.Sessions = map[domain.SessionID]sessionIdentity{"fake": {Launch: "restored", Handle: "ao-fake"}}
	if err := compare(before, after); err == nil {
		t.Fatal("restore hidden")
	}
}
