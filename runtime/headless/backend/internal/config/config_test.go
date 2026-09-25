package config

import (
	"testing"
	"time"
)

func TestLoadUsesWorktreeSafeRequestTimeout(t *testing.T) {
	t.Setenv("AO_REQUEST_TIMEOUT", "")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.RequestTimeout != 110*time.Second {
		t.Fatalf("request timeout = %s, want %s", cfg.RequestTimeout, 110*time.Second)
	}
}

func TestLoadHonorsRequestTimeoutOverride(t *testing.T) {
	t.Setenv("AO_REQUEST_TIMEOUT", "75s")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if cfg.RequestTimeout != 75*time.Second {
		t.Fatalf("request timeout = %s, want %s", cfg.RequestTimeout, 75*time.Second)
	}
}
