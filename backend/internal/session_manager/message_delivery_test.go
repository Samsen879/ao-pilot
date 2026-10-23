package sessionmanager

import (
	"context"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/google/uuid"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestMessageOutcomesAndDuplicateCustody(t *testing.T) {
	for _, mode := range []string{"confirmed", "unconfirmed", "blocked", "incomplete", "attempted", "ack_early", "ack_timeout"} {
		t.Run(mode, func(t *testing.T) {
			messenger := &sendConfirmMessenger{}
			m, store, rec := newSendConfirmFixture(t, messenger)
			var ackErr error
			messenger.after = func(ctx context.Context, call int) error {
				if mode == "attempted" {
					return ports.ErrPaneDraftPending
				}
				if mode == "incomplete" {
					return ports.ErrPaneDraftIncomplete
				}
				if mode == "ack_early" && call == 1 {
					_, ackErr = m.AckMessage(ctx, rec.ID, "message")
					return nil
				}
				if mode == "confirmed" && call == 1 {
					rec.Activity.State = domain.ActivityActive
					rec.Activity.LastActivityAt = time.Now().UTC().Add(time.Second)
					return store.UpdateSession(ctx, rec)
				}
				return nil
			}
			if mode == "blocked" {
				rec.Activity.State = domain.ActivityBlocked
				if err := store.UpdateSession(context.Background(), rec); err != nil {
					t.Fatal(err)
				}
			}
			opts := domain.MessageOptions{Message: "task bytes", MessageID: "message", RequireAck: strings.HasPrefix(mode, "ack"), AckTimeoutMS: 0}
			if opts.RequireAck {
				opts.AckTimeoutMS = 1
			}
			result, err := m.SendMessage(context.Background(), rec.ID, opts)
			if err != nil || ackErr != nil {
				t.Fatalf("%+v err=%v ack=%v", result, err, ackErr)
			}
			want := map[string]string{"confirmed": "submitted_confirmed", "unconfirmed": "submitted_unconfirmed", "blocked": "rejected", "incomplete": "rejected", "attempted": "rejected", "ack_early": "acknowledged", "ack_timeout": "ack_timeout"}[mode]
			if result.Outcome != want {
				t.Fatalf("result=%+v want %s", result, want)
			}
			before, _, err := store.GetMessage(context.Background(), "message")
			if err != nil {
				t.Fatal(err)
			}
			calls := len(messenger.snapshot())
			result, err = m.SendMessage(context.Background(), rec.ID, opts)
			if err != nil || result.Outcome != "rejected" {
				t.Fatalf("duplicate=%+v err=%v", result, err)
			}
			if mode == "ack_early" && result.Evidence.Code != "MESSAGE_ALREADY_ACKNOWLEDGED" {
				t.Fatal(result)
			}
			opts.Message = "changed bytes"
			result, err = m.SendMessage(context.Background(), "other-session", opts)
			if err != nil || result.Evidence.Code != "MESSAGE_ID_CONFLICT" {
				t.Fatalf("collision=%+v %v", result, err)
			}
			after, _, _ := store.GetMessage(context.Background(), "message")
			if before != after {
				t.Fatalf("duplicate mutated custody: before=%+v after=%+v", before, after)
			}
			if len(messenger.snapshot()) != calls {
				t.Fatal("duplicate reinjected")
			}
			if mode == "ack_early" && calls != 1 {
				t.Fatal("ACK did not stop confirmation nudges", calls)
			}
			if opts.RequireAck && calls > 0 {
				if strings.Count(messenger.snapshot()[0], "读取后运行 ao-pilot ack message") != 1 {
					t.Fatal(messenger.snapshot())
				}
			}
			if !opts.RequireAck && calls > 0 && strings.Contains(messenger.snapshot()[0], "读取后运行") {
				t.Fatal("ordinary message acquired ACK")
			}
		})
	}
}
func TestConcurrentMessageIDHasOneInjectionAndLateAckWins(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	m.agents = nil
	entered, release := make(chan struct{}), make(chan struct{})
	messenger.after = func(context.Context, int) error { close(entered); <-release; return nil }
	done := make(chan domain.MessageResult, 1)
	go func() {
		result, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "same", Message: "bytes", RequireAck: true, AckTimeoutMS: 1})
		if err != nil {
			done <- domain.MessageResult{Outcome: err.Error()}
			return
		}
		done <- result
	}()
	<-entered
	const contenders = 8
	var wg sync.WaitGroup
	errs := make(chan error, contenders)
	for i := 0; i < contenders; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "same", Message: "bytes", RequireAck: true, AckTimeoutMS: 1})
			if err != nil || r.Outcome != "rejected" {
				errs <- errors.New("duplicate was accepted")
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
	close(release)
	result := <-done
	if result.Outcome != "ack_timeout" {
		t.Fatal(result)
	}
	ack, err := m.AckMessage(context.Background(), rec.ID, "same")
	if err != nil || ack.Outcome != "acknowledged" {
		t.Fatalf("late ack=%+v %v", ack, err)
	}
	stale := result
	stale.Outcome = "submitted_unconfirmed"
	finished, err := finishMessage(store, domain.MessageRecord{MessageResult: result}, stale)
	if err != nil || finished.Outcome != "acknowledged" {
		t.Fatalf("late failure overwrote ack %+v %v", finished, err)
	}
	if len(messenger.snapshot()) != 1 {
		t.Fatal("duplicate injected")
	}
}
func TestMessageSubmissionSerializesButAckWaitDoesNot(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	entered := make(chan struct{})
	allow := make(chan struct{})
	var once sync.Once
	messenger.after = func(ctx context.Context, call int) error {
		if call == 1 {
			once.Do(func() { close(entered) })
			<-allow
		}
		current, _, err := store.GetSession(ctx, rec.ID)
		if err != nil {
			return err
		}
		current.Activity.State = domain.ActivityActive
		current.Activity.LastActivityAt = time.Now().UTC().Add(time.Duration(call) * time.Second)
		return store.UpdateSession(ctx, current)
	}
	firstDone := make(chan domain.MessageResult, 1)
	go func() {
		r, _ := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "first", Message: "one", RequireAck: true, AckTimeoutMS: 1000})
		firstDone <- r
	}()
	<-entered
	// A second submission must wait; a canceled waiter has no pane effect.
	waiting, cancel := context.WithCancel(context.Background())
	secondDone := make(chan domain.MessageResult, 1)
	go func() {
		r, _ := m.SendMessage(waiting, rec.ID, domain.MessageOptions{MessageID: "cancelled", Message: "two"})
		secondDone <- r
	}()
	cancel()
	second := <-secondDone
	if second.Outcome != "rejected" && second.Outcome != "" {
		t.Fatal(second)
	}
	if len(messenger.snapshot()) != 1 {
		t.Fatal("submission interleaved")
	}
	close(allow)
	// Acquire the submission gate: first ACK wait must not own it.
	lockCtx, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	unlock, err := m.lockSubmission(lockCtx, rec.ID)
	if err != nil {
		t.Fatal("ACK waiter kept submission lock", err)
	}
	unlock()
	// Explicit ACK can arrive before/after waiter starts, either is durable.
	ack, err := m.AckMessage(context.Background(), rec.ID, "first")
	if err != nil || ack.Outcome != "acknowledged" {
		t.Fatal(ack, err)
	}
	if result := <-firstDone; result.Outcome != "acknowledged" {
		t.Fatal(result)
	}
}

type noCustodyReader struct {
	Store
	messageStore
}

func TestMessageUnknownCustodyAndUnsafeIDAreZeroInjection(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	for _, bad := range []string{"a;b", "line\nbreak", "a b", strings.Repeat("x", 129)} {
		if _, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{Message: "task", MessageID: bad, RequireAck: true}); err == nil {
			t.Fatal("unsafe id accepted", bad)
		}
	}
	m.store = noCustodyReader{Store: store, messageStore: store}
	result, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "unknown-custody", Message: "task"})
	if err != nil || result.Evidence.Code != "SPAWN_HOLD_OR_UNKNOWN" {
		t.Fatal(result, err)
	}
	if len(messenger.snapshot()) != 0 {
		t.Fatal("unknown custody injected")
	}
}
func TestAckRejectsWrongSessionOrdinaryAndUnsentReservation(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	m.agents = nil
	if _, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "ordinary", Message: "task"}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"ordinary", "missing"} {
		result, err := m.AckMessage(context.Background(), rec.ID, id)
		if err != nil || result.Outcome != "rejected" {
			t.Fatal(result, err)
		}
	}
	reserved := domain.MessageRecord{MessageResult: messageResult("reserved", "submitted_unconfirmed", "RESERVED", 0), SessionID: rec.ID, TextSHA256: strings.Repeat("0", 64), RequireAck: true, Phase: "reserved"}
	if _, err := store.ReserveMessage(context.Background(), reserved); err != nil {
		t.Fatal(err)
	}
	result, err := m.AckMessage(context.Background(), rec.ID, "reserved")
	if err != nil || result.Outcome != "rejected" {
		t.Fatal(result, err)
	}
}

func TestBoundSpawnWithMissingJournalCannotInject(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	m.dataDir = t.TempDir()
	bound, err := store.CreateSession(context.Background(), domain.SessionRecord{ProjectID: rec.ProjectID, Kind: domain.KindWorker, Metadata: domain.SessionMetadata{SpawnAttemptID: uuid.NewString()}})
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.SendMessage(context.Background(), bound.ID, domain.MessageOptions{MessageID: "bound", Message: "task"})
	if err != nil || result.Outcome != "rejected" || result.Evidence.Code != "SPAWN_HOLD_OR_UNKNOWN" || len(messenger.snapshot()) != 0 {
		t.Fatal(result, err, messenger.snapshot())
	}
}

type timeoutAckStore struct {
	*sqlite.Store
	beforeTimeout func()
}

func (s *timeoutAckStore) CompareAndSwapMessage(ctx context.Context, rec domain.MessageRecord, version int64) (bool, error) {
	if rec.Outcome == "ack_timeout" && s.beforeTimeout != nil {
		hook := s.beforeTimeout
		s.beforeTimeout = nil
		hook()
	}
	return s.Store.CompareAndSwapMessage(ctx, rec, version)
}
func TestAckRacingTimeoutCASWinsAndCancellationKeepsCustody(t *testing.T) {
	messenger := &sendConfirmMessenger{}
	m, store, rec := newSendConfirmFixture(t, messenger)
	m.agents = nil
	race := &timeoutAckStore{Store: store}
	m.store = race
	race.beforeTimeout = func() {
		result, err := m.AckMessage(context.Background(), rec.ID, "race")
		if err != nil || result.Outcome != "acknowledged" {
			t.Error(result, err)
		}
	}
	result, err := m.SendMessage(context.Background(), rec.ID, domain.MessageOptions{MessageID: "race", Message: "task", RequireAck: true, AckTimeoutMS: 1})
	if err != nil || result.Outcome != "acknowledged" {
		t.Fatal(result, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	messenger.after = func(context.Context, int) error { cancel(); return nil }
	result, err = m.SendMessage(ctx, rec.ID, domain.MessageOptions{MessageID: "cancelled-ack", Message: "task", RequireAck: true, AckTimeoutMS: 1})
	if err != nil || result.Outcome != "ack_timeout" || result.Evidence.Code != "ACK_WAIT_CANCELLED" {
		t.Fatal(result, err)
	}
	recorded, ok, err := store.GetMessage(context.Background(), "cancelled-ack")
	if err != nil || !ok || recorded.Outcome != "ack_timeout" {
		t.Fatal(recorded, err)
	}
}
