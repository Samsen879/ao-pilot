package project

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"testing"
)

func TestWorkspaceRejectsSparseConfigWithoutChangingStoredSettings(t *testing.T) {
	ctx := context.Background()
	store, err := sqlite.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	row := domain.ProjectRecord{ID: "workspace", Path: t.TempDir(), DisplayName: "original", Kind: domain.ProjectKindWorkspace}
	if err := store.UpsertProject(ctx, row); err != nil {
		t.Fatal(err)
	}
	service := New(store)
	cfg := domain.ProjectConfig{SparseCheckout: []string{"keep"}}
	if _, err := service.SetConfig(ctx, "workspace", SetConfigInput{Config: cfg}); err == nil {
		t.Fatal("set-config silently accepted unsupported sparse checkout")
	}
	if _, err := service.UpdateSettings(ctx, "workspace", UpdateSettingsInput{DisplayName: "changed", Config: cfg}); err == nil {
		t.Fatal("settings silently accepted unsupported sparse checkout")
	}
	got, ok, err := store.GetProject(ctx, "workspace")
	if err != nil || !ok || !got.Config.IsZero() || got.DisplayName != "original" {
		t.Fatalf("rejected write mutated project: %+v %v", got, err)
	}
	path := t.TempDir()
	if _, err := service.Add(ctx, AddInput{Path: path, AsWorkspace: true, Config: &cfg}); err == nil {
		t.Fatal("registration silently accepted workspace sparse checkout")
	}
	if _, ok, err := store.FindProjectByPath(ctx, path); err != nil || ok {
		t.Fatalf("rejected registration persisted: %v %v", ok, err)
	}
}
