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
	if err := first.SetPaneDraftOwned(ctx, rec.ID, "review-receipt"); err != nil {
		t.Fatal(err)
	}
	if err := first.MarkPaneDraftComplete(ctx, rec.ID, "review-receipt"); err != nil {
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
	pending, owner, complete, generation, err := reopened.PaneDraftReceipt(ctx, rec.ID)
	if err != nil || !pending || owner != "review-receipt" || !complete || generation != 0 {
		t.Fatalf("reopened receipt pending=%v owner=%q complete=%v generation=%d err=%v", pending, owner, complete, generation, err)
	}
	if err := reopened.AdvancePaneGenerationAndClearDraft(ctx, rec.ID); err != nil {
		t.Fatal(err)
	}
	pending, owner, complete, generation, err = reopened.PaneDraftReceipt(ctx, rec.ID)
	if err != nil || pending || owner != "" || complete || generation != 1 {
		t.Fatalf("replacement receipt pending=%v owner=%q complete=%v generation=%d err=%v", pending, owner, complete, generation, err)
	}
}
