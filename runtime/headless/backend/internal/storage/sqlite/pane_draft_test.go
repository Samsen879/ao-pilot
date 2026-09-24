package sqlite_test

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

func TestPendingPaneDraftSurvivesStoreReopen(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	first, err := sqlite.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: root}); err != nil {
		t.Fatal(err)
	}
	rec, err := first.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker})
	if err != nil {
		t.Fatal(err)
	}
	if err := first.SetPaneDraftPending(ctx, rec.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := sqlite.Open(root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	pending, err := reopened.PaneDraftPending(ctx, rec.ID)
	if err != nil || !pending {
		t.Fatalf("reopened pending=%v err=%v", pending, err)
	}
}
