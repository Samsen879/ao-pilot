package config

import "testing"

func TestExplicitZeroWorktreeReserveDisablesGuard(t *testing.T) {
	t.Setenv("AO_WORKTREE_MIN_FREE_BYTES", "0")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.WorktreeMinFreeBytes != 0 {
		t.Fatalf("reserve=%d, want disabled", cfg.WorktreeMinFreeBytes)
	}
}
