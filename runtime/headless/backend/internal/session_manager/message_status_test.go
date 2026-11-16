package sessionmanager

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestMessageStatusLateAckIsReadOnlyAcrossReopen(t *testing.T) {
	ctx := context.Background()
	messenger := &sendConfirmMessenger{}
	root := t.TempDir()
	store, err := sqlite.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	m := New(Deps{Store: store, Messenger: messenger}) // no real harness
	result, err := m.SendMessage(ctx, session.ID, domain.MessageOptions{
		MessageID: "late", Message: "PRIVATE_TASK_TEXT", RequireAck: true, AckTimeoutMS: 1,
	})
	if err != nil || result.Outcome != "ack_timeout" {
		t.Fatal(result, err)
	}
	calls := len(messenger.snapshot())
	before, _, err := store.GetMessage(ctx, "late")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		status, found, err := m.GetMessageStatus(ctx, session.ID, "late")
		if err != nil || !found || status.MessageResult != result || status.CreatedAt != before.CreatedAt || status.Version != before.Version {
			t.Fatal(status, found, err)
		}
		encoded, _ := json.Marshal(status)
		if strings.Contains(string(encoded), "PRIVATE_TASK_TEXT") || strings.Contains(string(encoded), before.TextSHA256) || strings.Contains(string(encoded), "text_sha256") {
			t.Fatal("private custody fields leaked", string(encoded))
		}
	}
	after, _, _ := store.GetMessage(ctx, "late")
	if before != after || len(messenger.snapshot()) != calls {
		t.Fatal("inspection changed custody or injected a message")
	}
	if _, found, err := m.GetMessageStatus(ctx, "different-session", "late"); err != nil || found {
		t.Fatal("cross-session lookup disclosed custody", found, err)
	}
	ack, err := m.AckMessage(ctx, session.ID, "late")
	if err != nil || ack.Outcome != "acknowledged" {
		t.Fatal(ack, err)
	}
	session.IsTerminated = true
	if err := store.UpdateSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	// A separate read-only database handle models restart/terminated-session
	// inspection. Any accidental write through this handle would fail.
	reader, err := sqlite.OpenReadOnly(ctx, root)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	reopened := New(Deps{Store: reader})
	status, found, err := reopened.GetMessageStatus(ctx, session.ID, "late")
	if err != nil || !found || status.Outcome != "acknowledged" || status.Version <= before.Version || status.Evidence.AcknowledgedAt == "" {
		t.Fatal(status, found, err)
	}
	if len(messenger.snapshot()) != calls {
		t.Fatal("late status inspection reinjected")
	}
}

func TestMessageStatusValidationMissingAndCancelledRead(t *testing.T) {
	m, store, session := newSendConfirmFixture(t, &sendConfirmMessenger{})
	for _, input := range []struct{ session, id string }{{"", "safe"}, {"s", "bad/id"}, {"s", ""}} {
		_, found, err := m.GetMessageStatus(context.Background(), domain.SessionID(input.session), input.id)
		var validation MessageValidationError
		if found || !errors.As(err, &validation) {
			t.Fatal(input, found, err)
		}
	}
	if _, found, err := m.GetMessageStatus(context.Background(), session.ID, "missing"); found || err != nil {
		t.Fatal(found, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, found, err := m.GetMessageStatus(ctx, session.ID, "missing"); found || err == nil {
		t.Fatal("cancelled database read was accepted", found, err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, found, err := m.GetMessageStatus(context.Background(), session.ID, "missing"); found || err == nil {
		t.Fatal("failed storage became a missing/success result", found, err)
	}
}
