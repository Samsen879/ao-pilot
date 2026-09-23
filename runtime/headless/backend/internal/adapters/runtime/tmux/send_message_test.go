package tmux

import (
	"testing"
	"time"
)

func TestNewUsesOneSecondEnterSettleDelay(t *testing.T) {
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh"})

	if runtime.enterDelay != time.Second {
		t.Fatalf("enter delay = %s, want %s", runtime.enterDelay, time.Second)
	}
}
