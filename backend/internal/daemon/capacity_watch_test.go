package daemon

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

type fakeCapacityStopper struct{ calls int }

func (s *fakeCapacityStopper) EmergencyStopAll(context.Context) (int, error) {
	s.calls++
	return 1, nil
}

func TestCapacityWatchStopsOnLowSpaceOrUnreadableHost(t *testing.T) {
	available := uint64(100)
	var probeErr error
	stopper := &fakeCapacityStopper{}
	watch := &capacityWatch{
		reserve: 64,
		probe:   func() (uint64, error) { return available, probeErr },
		stopper: stopper,
		logger:  slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	ctx := context.Background()
	watch.tick(ctx)
	if stopper.calls != 0 {
		t.Fatalf("healthy filesystem stopped sessions: %d", stopper.calls)
	}
	available = 63
	watch.tick(ctx)
	if stopper.calls != 1 {
		t.Fatalf("low filesystem did not stop sessions: %d", stopper.calls)
	}
	available = 100
	watch.tick(ctx)
	if stopper.calls != 1 || watch.low {
		t.Fatalf("recovered filesystem retained low state: calls=%d low=%v", stopper.calls, watch.low)
	}
	probeErr = errors.New("host mount unavailable")
	watch.tick(ctx)
	if stopper.calls != 2 {
		t.Fatalf("unreadable host did not stop sessions: %d", stopper.calls)
	}
}
