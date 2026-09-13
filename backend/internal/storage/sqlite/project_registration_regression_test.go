package sqlite_test

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestRegistrationSurvivesStoreReopenAndIsolatedDataSelection(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	a, b := filepath.Join(root, "original"), filepath.Join(root, "other")
	original := domain.ProjectRecord{ID: "fixture-project", Path: filepath.Join(root, "workspace"), RepoOriginURL: "https://example.invalid/fixture.git", DisplayName: "Fixture", RegisteredAt: time.Unix(1700000000, 0).UTC(), Kind: domain.ProjectKindSingleRepo}
	first, err := sqlite.Open(a)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.UpsertProject(ctx, original); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	selected, err := sqlite.Open(b)
	if err != nil {
		t.Fatal(err)
	}
	_, found, err := selected.GetProject(ctx, original.ID)
	if err != nil || found {
		t.Fatalf("isolated data selection: found=%v err=%v", found, err)
	}
	if err := selected.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := sqlite.Open(a)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	actual, found, err := reopened.GetProject(ctx, original.ID)
	if err != nil || !found {
		t.Fatalf("reopen: found=%v err=%v", found, err)
	}
	if !reflect.DeepEqual(actual, original) {
		t.Fatalf("registration drift: got %#v want %#v", actual, original)
	}
	rows, err := reopened.ListProjects(ctx)
	if err != nil || len(rows) != 1 {
		t.Fatalf("registry inventory: rows=%d err=%v", len(rows), err)
	}
}
