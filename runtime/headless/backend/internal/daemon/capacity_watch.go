package daemon

import (
	"context"
	"log/slog"
	"time"
)

const capacityWatchInterval = 5 * time.Second

type capacityStopper interface {
	EmergencyStopAll(context.Context) (int, error)
}

// capacityWatch observes the host filesystem throughout a daemon run. The
// checkout guard protects only creation; an agent can write many more bytes
// after its worktree was admitted. A failed capacity probe is treated as an
// unsafe reading, including when the configured host mount disappears.
type capacityWatch struct {
	reserve uint64
	probe   func() (uint64, error)
	stopper capacityStopper
	logger  *slog.Logger
	low     bool
}

func (w *capacityWatch) tick(ctx context.Context) {
	available, probeErr := w.probe()
	unsafe := probeErr != nil || available < w.reserve
	if !unsafe {
		if w.low {
			w.logger.Info("capacity watch: filesystem recovered; stopped sessions require manual restoration", "availableBytes", available, "reserveBytes", w.reserve)
		}
		w.low = false
		return
	}
	if !w.low {
		w.logger.Error("capacity watch: stopping AO sessions and preserving worktrees", "availableBytes", available, "reserveBytes", w.reserve, "probeError", probeErr)
	}
	w.low = true
	stopped, err := w.stopper.EmergencyStopAll(ctx)
	if err != nil {
		w.logger.Error("capacity watch: some sessions could not be stopped; retrying", "stopped", stopped, "error", err)
	} else if stopped > 0 {
		w.logger.Error("capacity watch: AO sessions stopped; worktrees preserved", "stopped", stopped)
	}
}

func (w *capacityWatch) run(ctx context.Context) {
	ticker := time.NewTicker(capacityWatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

func startCapacityWatch(ctx context.Context, watch *capacityWatch) <-chan struct{} {
	done := make(chan struct{})
	go func() {
		defer close(done)
		watch.run(ctx)
	}()
	return done
}
