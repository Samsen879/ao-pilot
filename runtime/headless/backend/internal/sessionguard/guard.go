// Package sessionguard owns the one invariant every write into a live
// session's pane must satisfy: re-read the session immediately before writing
// and refuse when the paste could land somewhere only the user may act. The
// runtime appends Enter after every paste, so a write into a session paused on
// a permission/approval dialog would answer the decision on the user's behalf
// — an unrecoverable action, unlike a skipped message which callers re-attempt
// or surface. Every pane-writing path (user sends, post-send Enter nudges,
// lifecycle reaction nudges) funnels through this guard so the stale-state
// check lives in one tested place instead of being re-derived per call-site.
package sessionguard

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// SessionReader is the single store read the guard needs: the session's
// current liveness and activity state.
type SessionReader interface {
	GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error)
}

type paneDraftStore interface {
	PaneDraftPending(ctx context.Context, id domain.SessionID) (bool, error)
	SetPaneDraftPending(ctx context.Context, id domain.SessionID, pending bool) error
}

type paneGenerationStore interface {
	PaneGeneration(context.Context, domain.SessionID) (int64, error)
	AdvancePaneGenerationAndClearDraft(context.Context, domain.SessionID) error
}

// Outcome reports what a guarded write did. Attempted reached the pane without
// Enter; suppressed outcomes did not reach it.
type Outcome int

const (
	// SuppressedUnknown is returned when the pre-write session read failed, so
	// the state is unknown and the guard failed closed. Deliberately the zero
	// value — a forgotten assignment must never read as a successful send.
	SuppressedUnknown Outcome = iota
	// Sent means the message was written to the session's pane (a messenger
	// failure surfaces as Sent plus a non-nil error: the write was attempted).
	Sent
	// Attempted means text reached the pane, but Enter was withheld after a
	// later guard check. Callers must not paste the same text again.
	Attempted
	// Incomplete means a paste failed before all text reached the pane.
	// No automated Enter may submit the truncated instruction.
	Incomplete
	// SuppressedNotFound means no session row exists for the id.
	SuppressedNotFound
	// SuppressedTerminated means the session is terminated; its pane is gone
	// or about to be reaped.
	SuppressedTerminated
	// SuppressedExited means the managed pane remains available but its agent
	// process exited. The pane may now contain an interactive shell, so writing
	// an agent prompt would execute it as shell input.
	SuppressedExited
	// SuppressedAwaitingUser means the session awaits the human — blocked on a
	// permission decision (Deliver and Nudge), or waiting at the prompt for
	// the next instruction (Nudge only).
	SuppressedAwaitingUser
	// SuppressedBusy means the session is mid-turn on a harness that cannot
	// safely steer an active turn (NudgeCoordination only).
	SuppressedBusy
	// SuppressedDraftPending means an earlier paste is still in this pane.
	// A new message must wait until its Enter is safely sent.
	SuppressedDraftPending
	// AlreadySubmitted means the durable pane marker was cleared before an
	// Enter-only recovery. Replaying Enter could submit unrelated pane input.
	AlreadySubmitted
	// PaneReplaced means the pending text belonged to an older pane process.
	PaneReplaced
)

// String names the outcome for logs.
func (o Outcome) String() string {
	switch o {
	case Sent:
		return "sent"
	case Attempted:
		return "attempted_unsubmitted"
	case Incomplete:
		return "incomplete_unsubmitted"
	case SuppressedNotFound:
		return "suppressed_not_found"
	case SuppressedTerminated:
		return "suppressed_terminated"
	case SuppressedExited:
		return "suppressed_exited"
	case SuppressedAwaitingUser:
		return "suppressed_awaiting_user"
	case SuppressedBusy:
		return "suppressed_busy"
	case SuppressedDraftPending:
		return "suppressed_draft_pending"
	case AlreadySubmitted:
		return "already_submitted"
	case PaneReplaced:
		return "pane_replaced"
	default:
		return "suppressed_unknown"
	}
}

// Guard is the guarded pane-write primitive shared by the session manager and
// lifecycle. It serializes each session before the just-in-time state read so
// a queued write cannot use state that changed while another send completed.
// It implements
// ports.AgentMessenger (via Send) so it can transparently replace a raw
// messenger wherever only the error matters.
type Guard struct {
	store     SessionReader
	messenger ports.AgentMessenger
	logger    *slog.Logger
}

var sharedLocks = struct {
	sync.Mutex
	bySession map[domain.SessionID]*sessionLockEntry
	pending   map[domain.SessionID]bool
}{bySession: make(map[domain.SessionID]*sessionLockEntry), pending: make(map[domain.SessionID]bool)}

type sessionLockEntry struct {
	mu    sync.Mutex
	users int
}

type guardedMessenger interface {
	SendGuarded(context.Context, domain.SessionID, string, func(context.Context) error) error
}

type suppressedError struct{ outcome Outcome }

func (e suppressedError) Error() string { return e.outcome.String() }

var _ ports.AgentMessenger = (*Guard)(nil)

// New builds a Guard over the store it re-reads and the messenger it writes
// through. A nil logger falls back to slog.Default().
func New(store SessionReader, messenger ports.AgentMessenger, logger *slog.Logger) *Guard {
	if logger == nil {
		logger = slog.Default()
	}
	return &Guard{store: store, messenger: messenger, logger: logger}
}

func (g *Guard) lockSession(id domain.SessionID) func() {
	sharedLocks.Lock()
	entry := sharedLocks.bySession[id]
	if entry == nil {
		entry = &sessionLockEntry{}
		sharedLocks.bySession[id] = entry
	}
	entry.users++ // includes goroutines waiting on entry.mu
	sharedLocks.Unlock()
	entry.mu.Lock()
	return func() {
		entry.mu.Unlock()
		sharedLocks.Lock()
		entry.users--
		if entry.users == 0 && sharedLocks.bySession[id] == entry {
			delete(sharedLocks.bySession, id)
		}
		sharedLocks.Unlock()
	}
}

func (g *Guard) pendingDraft(ctx context.Context, id domain.SessionID) (bool, error) {
	if store, ok := g.store.(paneDraftStore); ok {
		return store.PaneDraftPending(ctx, id)
	}
	sharedLocks.Lock()
	defer sharedLocks.Unlock()
	return sharedLocks.pending[id], nil
}

func (g *Guard) setPendingDraft(ctx context.Context, id domain.SessionID, pending bool) error {
	if store, ok := g.store.(paneDraftStore); ok {
		return store.SetPaneDraftPending(ctx, id, pending)
	}
	sharedLocks.Lock()
	if pending {
		sharedLocks.pending[id] = true
	} else {
		delete(sharedLocks.pending, id)
	}
	sharedLocks.Unlock()
	return nil
}

func (g *Guard) paneGeneration(ctx context.Context, id domain.SessionID) (int64, error) {
	if store, ok := g.store.(paneGenerationStore); ok {
		return store.PaneGeneration(ctx, id)
	}
	return 0, nil
}

// PaneGeneration identifies the current pane process for durable recovery
// receipts. A caller passes the returned value back to a guarded send, which
// checks it again under the per-session lock before writing.
func (g *Guard) PaneGeneration(ctx context.Context, id domain.SessionID) (int64, error) {
	return g.paneGeneration(ctx, id)
}

// ClearPendingPaneDraft records a user-prompt-submit hook after the user
// manually submitted the draft in the terminal. It shares the pane's send
// lock so an in-flight paste cannot recreate a stale marker afterward.
func ClearPendingPaneDraft(ctx context.Context, store SessionReader, id domain.SessionID) error {
	g := &Guard{store: store}
	defer g.lockSession(id)()
	return g.setPendingDraft(ctx, id, false)
}

// RecordManualSubmission keeps the activity update and draft clearance under
// the same per-session lock used by guarded pane sends. The update callback
// should commit activity and durable marker clearance in one transaction.
func RecordManualSubmission(ctx context.Context, store SessionReader, id domain.SessionID, update func() error) error {
	g := &Guard{store: store}
	defer g.lockSession(id)()
	if err := update(); err != nil {
		return err
	}
	return g.setPendingDraft(ctx, id, false)
}

// ReplacePane serializes a runtime replacement with guarded sends. A pending
// draft belongs to the previous pane generation and is invalidated only after
// the replacement succeeds.
func ReplacePane(ctx context.Context, store SessionReader, id domain.SessionID, replace func() (ports.RuntimeHandle, error)) (ports.RuntimeHandle, error) {
	g := &Guard{store: store}
	defer g.lockSession(id)()
	handle, err := replace()
	if err != nil {
		return handle, err
	}
	if store, ok := store.(paneGenerationStore); ok {
		if err := store.AdvancePaneGenerationAndClearDraft(ctx, id); err != nil {
			return handle, err
		}
		sharedLocks.Lock()
		delete(sharedLocks.pending, id)
		sharedLocks.Unlock()
	} else if err := g.setPendingDraft(ctx, id, false); err != nil {
		return handle, err
	}
	return handle, nil
}

// Send satisfies ports.AgentMessenger so a Guard can sit in for the raw
// messenger. It applies the Deliver policy but FOLDS a suppressed outcome into
// nil: a caller that learns only "did Send error?" cannot tell that the write
// was actually refused. That is fine for callers that only need a best-effort
// delivery, but paths whose success CONTRACT depends on the write landing
// (after-start prompt delivery in Spawn/Restore) must call Deliver directly and
// map non-Sent outcomes to an error, or a session that terminates or blocks
// before injection is reported as a successful spawn with a prompt that was
// never delivered.
func (g *Guard) Send(ctx context.Context, id domain.SessionID, msg string) error {
	outcome, err := g.Deliver(ctx, id, msg)
	if outcome == Attempted || outcome == Incomplete || outcome == SuppressedDraftPending {
		return ports.ErrPaneDraftPending
	}
	return err
}

// Deliver writes a user-initiated message (or its Enter-only re-submit: an
// empty msg) into a live agent. Its activity-specific policy refuses when the
// session is blocked on a pending decision — waiting_input does NOT suppress, because an agent
// sitting at an idle prompt is exactly where a user message (or the Enter that
// submits its unsent draft) belongs.
func (g *Guard) Deliver(ctx context.Context, id domain.SessionID, msg string) (Outcome, error) {
	return g.send(ctx, id, msg, false, nil, func(rec domain.SessionRecord) (Outcome, bool) {
		return SuppressedAwaitingUser, rec.Activity.State == domain.ActivityBlocked
	})
}

// Nudge writes an AO-initiated (unsolicited) message into a live agent. Its
// activity-specific policy refuses whenever the session awaits the human — blocked on a
// decision or waiting at the prompt — because an automated paste+Enter there
// either answers a dialog or submits text the user never saw.
func (g *Guard) Nudge(ctx context.Context, id domain.SessionID, msg string) (Outcome, error) {
	return g.send(ctx, id, msg, false, nil, func(rec domain.SessionRecord) (Outcome, bool) {
		return SuppressedAwaitingUser, rec.Activity.State.NeedsInput()
	})
}

// SubmitPendingNudge presses Enter only while the original draft marker is
// still present. Its marker check and pane write share the send lock.
func (g *Guard) SubmitPendingNudge(ctx context.Context, id domain.SessionID) (Outcome, error) {
	return g.SubmitPendingNudgeForGeneration(ctx, id, nil)
}

func (g *Guard) NudgeForGeneration(ctx context.Context, id domain.SessionID, msg string, generation int64) (Outcome, error) {
	return g.send(ctx, id, msg, false, &generation, func(rec domain.SessionRecord) (Outcome, bool) {
		return SuppressedAwaitingUser, rec.Activity.State.NeedsInput()
	})
}

func (g *Guard) SubmitPendingNudgeForGeneration(ctx context.Context, id domain.SessionID, generation *int64) (Outcome, error) {
	return g.send(ctx, id, "", true, generation, func(rec domain.SessionRecord) (Outcome, bool) {
		return SuppressedAwaitingUser, rec.Activity.State.NeedsInput()
	})
}

// NudgeCoordination writes an AO-initiated coordination message under the full
// delivery policy, re-evaluated here — at the write boundary — rather than from
// a caller's earlier snapshot. It refuses whenever the session awaits the human,
// and additionally while it is mid-turn on a harness that cannot safely steer an
// active turn. steersActiveTurn is the adapter-provided capability; a nil
// predicate is treated as "cannot steer", so an unknown harness never takes an
// unsolicited write during a live turn.
func (g *Guard) NudgeCoordination(ctx context.Context, id domain.SessionID, msg string, steersActiveTurn func(domain.AgentHarness) bool) (Outcome, error) {
	return g.send(ctx, id, msg, false, nil, func(rec domain.SessionRecord) (Outcome, bool) {
		if rec.Activity.State.NeedsInput() {
			return SuppressedAwaitingUser, true
		}
		if rec.Activity.State == domain.ActivityActive {
			return SuppressedBusy, steersActiveTurn == nil || !steersActiveTurn(rec.Harness)
		}
		return SuppressedUnknown, false
	})
}

func (g *Guard) SubmitPendingCoordination(ctx context.Context, id domain.SessionID, steersActiveTurn func(domain.AgentHarness) bool) (Outcome, error) {
	return g.SubmitPendingCoordinationForGeneration(ctx, id, nil, steersActiveTurn)
}

func (g *Guard) NudgeCoordinationForGeneration(ctx context.Context, id domain.SessionID, msg string, generation int64, steersActiveTurn func(domain.AgentHarness) bool) (Outcome, error) {
	return g.send(ctx, id, msg, false, &generation, func(rec domain.SessionRecord) (Outcome, bool) {
		if rec.Activity.State.NeedsInput() {
			return SuppressedAwaitingUser, true
		}
		if rec.Activity.State == domain.ActivityActive {
			return SuppressedBusy, steersActiveTurn == nil || !steersActiveTurn(rec.Harness)
		}
		return SuppressedUnknown, false
	})
}

func (g *Guard) SubmitPendingCoordinationForGeneration(ctx context.Context, id domain.SessionID, generation *int64, steersActiveTurn func(domain.AgentHarness) bool) (Outcome, error) {
	return g.send(ctx, id, "", true, generation, func(rec domain.SessionRecord) (Outcome, bool) {
		if rec.Activity.State.NeedsInput() {
			return SuppressedAwaitingUser, true
		}
		if rec.Activity.State == domain.ActivityActive {
			return SuppressedBusy, steersActiveTurn == nil || !steersActiveTurn(rec.Harness)
		}
		return SuppressedUnknown, false
	})
}

// send re-reads the session immediately before pasting so the window between
// "state looked safe" and "bytes hit the pane" is as small as this process can
// make it. It is not atomic against the agent itself — a dialog can still
// appear mid-paste — but the just-in-time read is the strongest guarantee
// available without scraping the terminal. Fail closed: a store error
// suppresses the write rather than pressing Enter on an unknown state.
func (g *Guard) send(ctx context.Context, id domain.SessionID, msg string, requirePending bool, expectedGeneration *int64, refuse func(domain.SessionRecord) (Outcome, bool)) (Outcome, error) {
	defer g.lockSession(id)()
	pending, err := g.pendingDraft(ctx, id)
	if err != nil {
		return SuppressedUnknown, err
	}
	if expectedGeneration != nil {
		generation, err := g.paneGeneration(ctx, id)
		if err != nil {
			return SuppressedUnknown, err
		}
		if generation != *expectedGeneration {
			return PaneReplaced, nil
		}
	}
	if requirePending && !pending {
		return AlreadySubmitted, nil
	}
	if pending && msg != "" {
		return SuppressedDraftPending, nil
	}
	var beforePaste domain.SessionRecord
	checkCount := 0
	check := func(checkCtx context.Context) error {
		outcome, rec, err := g.check(checkCtx, id, refuse)
		if err != nil {
			return err
		}
		checkCount++
		// Codex reports both an idle composer and a permission prompt as
		// waiting_input. A new signal during the paste interval is therefore
		// unsafe to submit automatically, even if the state name is unchanged.
		if msg != "" && checkCount >= 3 && rec.Activity.State == domain.ActivityWaitingInput &&
			!rec.Activity.LastActivityAt.Equal(beforePaste.Activity.LastActivityAt) {
			return suppressedError{outcome: SuppressedAwaitingUser}
		}
		if checkCount <= 2 {
			beforePaste = rec
		}
		if outcome != Sent {
			return suppressedError{outcome: outcome}
		}
		return nil
	}
	if err := check(ctx); err != nil {
		var suppressed suppressedError
		if errors.As(err, &suppressed) {
			return suppressed.outcome, nil
		}
		return SuppressedUnknown, err
	}
	if msg != "" {
		// Write ahead: a daemon crash between paste and Enter must leave a
		// durable marker that blocks every later sender from repasting.
		if err := g.setPendingDraft(ctx, id, true); err != nil {
			return SuppressedUnknown, err
		}
	}
	if messenger, ok := g.messenger.(guardedMessenger); ok {
		err = messenger.SendGuarded(ctx, id, msg, check)
	} else {
		err = g.messenger.Send(ctx, id, msg)
	}
	if err != nil {
		if errors.Is(err, ports.ErrPaneDraftIncomplete) {
			return Incomplete, nil
		}
		if errors.Is(err, ports.ErrPaneDraftPending) {
			return Attempted, nil
		}
		if errors.Is(err, ports.ErrPaneWriteNotStarted) && msg != "" {
			if clearErr := g.setPendingDraft(ctx, id, false); clearErr != nil {
				return SuppressedUnknown, clearErr
			}
		}
		var suppressed suppressedError
		if errors.As(err, &suppressed) {
			if msg != "" && !errors.Is(err, ports.ErrPaneWriteNotStarted) {
				if clearErr := g.setPendingDraft(ctx, id, false); clearErr != nil {
					return SuppressedUnknown, clearErr
				}
			}
			return suppressed.outcome, nil
		}
		return Sent, fmt.Errorf("guard %s: send: %w", id, err)
	}
	if err := g.setPendingDraft(ctx, id, false); err != nil {
		return Sent, err
	}
	return Sent, nil
}

func (g *Guard) check(ctx context.Context, id domain.SessionID, refuse func(domain.SessionRecord) (Outcome, bool)) (Outcome, domain.SessionRecord, error) {
	rec, ok, err := g.store.GetSession(ctx, id)
	if err != nil {
		return SuppressedUnknown, rec, fmt.Errorf("guard %s: read session: %w", id, err)
	}
	if !ok {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "not_found")
		return SuppressedNotFound, rec, nil
	}
	if rec.IsTerminated {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "terminated")
		return SuppressedTerminated, rec, nil
	}
	if rec.Activity.State == domain.ActivityExited {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", "agent_exited")
		return SuppressedExited, rec, nil
	}
	if outcome, deny := refuse(rec); deny {
		g.logger.Info("sessionguard: write suppressed", "sessionID", id, "reason", outcome.String(), "state", string(rec.Activity.State))
		return outcome, rec, nil
	}
	return Sent, rec, nil
}
