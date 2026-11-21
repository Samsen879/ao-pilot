package sessionmanager

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"strings"
	"testing"
)

func TestTaskProgressAndPauseAcrossRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	messenger := &sendConfirmMessenger{}
	m := New(Deps{Store: store, Messenger: messenger})
	id := "delayed"
	result, err := m.SendMessage(ctx, session.ID, domain.MessageOptions{MessageID: id, Message: "fixture", RequireAck: true, AckTimeoutMS: 1})
	if err != nil || result.Outcome != "ack_timeout" {
		t.Fatal(result, err)
	}
	evidence := domain.TaskCheckpoint{Kind: "started", Detail: "fixture-command", Digest: strings.Repeat("a", 64)}
	if err = store.RecordCheckpoint(ctx, string(session.ID), id, evidence); !errors.Is(err, domain.ErrCheckpointConflict) {
		t.Fatal(err)
	}
	if err = store.SetProjectPause(ctx, "fixture", true); err != nil {
		t.Fatal(err)
	}
	if err = store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = sqlite.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	m = New(Deps{Store: store, Messenger: messenger, DataDir: dir})
	before := len(messenger.snapshot())
	ack, err := m.AckMessage(ctx, session.ID, id)
	if err != nil || ack.Outcome != "acknowledged" {
		t.Fatal(ack, err)
	}
	if err = store.RecordCheckpoint(ctx, string(session.ID), id, evidence); !errors.Is(err, domain.ErrCheckpointConflict) {
		t.Fatal(err)
	}
	if _, _, _, err = m.Spawn(ctx, ports.SpawnConfig{ProjectID: "fixture"}); !errors.Is(err, domain.ErrProjectPaused) {
		t.Fatal(err)
	}
	result, err = m.SendMessage(ctx, session.ID, domain.MessageOptions{MessageID: "paused-send", Message: "stop"})
	if err != nil || result.Evidence.Code != "PROJECT_PAUSED" || len(messenger.snapshot()) != before {
		t.Fatal(result, err)
	}
	view, err := store.TaskOverview(ctx, "fixture")
	if err != nil || len(view.Tasks) != 1 || view.Tasks[0].Ack == "" || view.Tasks[0].Started != "" || len(view.Paused) != 1 {
		t.Fatal(view, err)
	}
	if err = store.SetProjectPause(ctx, "fixture", false); err != nil {
		t.Fatal(err)
	}
	if err = store.RecordCheckpoint(ctx, "other-session", id, evidence); !errors.Is(err, domain.ErrCheckpointConflict) {
		t.Fatal(err)
	}
	for _, e := range []domain.TaskCheckpoint{evidence, {Kind: "artifact", Detail: "result.txt", Digest: strings.Repeat("f", 64)}, {Kind: "blocked", Detail: "awaiting input"}} {
		if err = store.RecordCheckpoint(ctx, string(session.ID), id, e); err != nil {
			t.Fatal(err)
		}
	}
	if err = store.RecordCheckpoint(ctx, string(session.ID), id, evidence); !errors.Is(err, domain.ErrCheckpointConflict) {
		t.Fatal(err)
	}
	view, err = store.TaskOverview(ctx, "fixture")
	if err != nil || len(view.Paused) != 0 || view.Tasks[0].FirstCommand != "fixture-command" || view.Tasks[0].Latest != "blocked" {
		t.Fatal(view, err)
	}
	view, err = store.TaskOverview(ctx, "other")
	if err != nil || len(view.Tasks) != 0 {
		t.Fatal(view, err)
	}
}
