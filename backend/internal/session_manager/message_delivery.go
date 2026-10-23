package sessionmanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/sessionguard"
	"github.com/google/uuid"
)

type messageStore interface {
	ReserveMessage(context.Context, domain.MessageRecord) (bool, error)
	GetMessage(context.Context, string) (domain.MessageRecord, bool, error)
	CompareAndSwapMessage(context.Context, domain.MessageRecord, int64) (bool, error)
}
type MessageValidationError struct{ Message string }

func (e MessageValidationError) Error() string { return e.Message }
func ValidateMessageOptions(o domain.MessageOptions) error {
	if strings.TrimSpace(domain.SanitizeControlChars(o.Message)) == "" {
		return MessageValidationError{"message is required"}
	}
	if o.MessageID != "" && !domain.ValidMessageID(o.MessageID) {
		return MessageValidationError{"invalid message_id"}
	}
	if o.AckTimeoutMS < 0 || o.AckTimeoutMS > 60000 || (o.AckTimeoutMS != 0 && !o.RequireAck) {
		return MessageValidationError{"ack_timeout_ms requires require_ack and must be 1..60000"}
	}
	if len(o.Message) > 4096 {
		return MessageValidationError{"message is too long"}
	}
	return nil
}
func messageResult(id, outcome, code string, attempts int) domain.MessageResult {
	return domain.MessageResult{MessageID: id, Outcome: outcome, Evidence: domain.MessageEvidence{Code: code, Signal: "none", Attempts: attempts, RecordedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
}

// lockSubmission covers injection and its confirmation, never the ACK wait.
type messageGate struct {
	token chan struct{}
	users int
}

func (m *Manager) lockSubmission(ctx context.Context, id domain.SessionID) (func(), error) {
	m.messageMu.Lock()
	gate := m.messageLocks[id]
	if gate == nil {
		gate = &messageGate{token: make(chan struct{}, 1)}
		gate.token <- struct{}{}
		m.messageLocks[id] = gate
	}
	gate.users++
	m.messageMu.Unlock()
	drop := func() {
		m.messageMu.Lock()
		gate.users--
		if gate.users == 0 {
			delete(m.messageLocks, id)
		}
		m.messageMu.Unlock()
	}
	select {
	case <-ctx.Done():
		drop()
		return nil, ctx.Err()
	case <-gate.token:
		return func() { gate.token <- struct{}{}; drop() }, nil
	}
}
func (m *Manager) SendMessage(ctx context.Context, id domain.SessionID, o domain.MessageOptions) (domain.MessageResult, error) {
	if err := ValidateMessageOptions(o); err != nil {
		return domain.MessageResult{}, err
	}
	if o.MessageID == "" {
		o.MessageID = uuid.NewString()
	}
	message := domain.SanitizeControlChars(o.Message)
	sum := sha256.Sum256([]byte(message))
	store, ok := m.store.(messageStore)
	if !ok {
		return domain.MessageResult{}, errors.New("message custody unavailable")
	}
	rec := domain.MessageRecord{MessageResult: messageResult(o.MessageID, "submitted_unconfirmed", "RESERVED", 0), SessionID: id, TextSHA256: hex.EncodeToString(sum[:]), RequireAck: o.RequireAck, Phase: "reserved"}
	rec.CreatedAt = rec.Evidence.RecordedAt
	reserved, err := store.ReserveMessage(ctx, rec)
	if err != nil {
		return domain.MessageResult{}, err
	}
	if !reserved {
		previous, exists, err := store.GetMessage(ctx, o.MessageID)
		if err != nil || !exists {
			if err == nil {
				err = errors.New("message custody disappeared")
			}
			return domain.MessageResult{}, err
		}
		code := "MESSAGE_ID_EXISTS"
		if previous.SessionID != id || previous.TextSHA256 != rec.TextSHA256 || previous.RequireAck != o.RequireAck {
			code = "MESSAGE_ID_CONFLICT"
		} else if previous.Outcome == "acknowledged" {
			code = "MESSAGE_ALREADY_ACKNOWLEDGED"
		}
		result := messageResult(o.MessageID, "rejected", code, previous.Evidence.Attempts)
		result.Evidence.ExistingOutcome = previous.Outcome
		return result, nil
	}
	finish := func(result domain.MessageResult) (domain.MessageResult, error) {
		return finishMessage(store, rec, result)
	}
	release, err := m.lockSubmission(ctx, id)
	if err != nil {
		return finish(messageResult(o.MessageID, "rejected", "CANCELLED_BEFORE_INJECTION", 0))
	}
	result := func() domain.MessageResult {
		defer release()
		if err := ctx.Err(); err != nil {
			return messageResult(o.MessageID, "rejected", "CANCELLED_BEFORE_INJECTION", 0)
		}
		// An unavailable custody reader is not proof of an unbound legacy session.
		if _, ok := m.store.(attemptStore); !ok || !m.spawnAttemptAllowed(ctx, id) {
			return messageResult(o.MessageID, "rejected", "SPAWN_HOLD_OR_UNKNOWN", 0)
		}
		before, exists, err := m.store.GetSession(ctx, id)
		if err != nil {
			return messageResult(o.MessageID, "rejected", "SESSION_STATE_UNKNOWN", 0)
		}
		if !exists {
			return messageResult(o.MessageID, "rejected", "SESSION_NOT_FOUND", 0)
		}
		message = prepareOutboundMessage(before, true, message)
		if o.RequireAck {
			message += "\n读取后运行 ao-pilot ack " + o.MessageID
		}
		if len(message) > 16384 {
			return messageResult(o.MessageID, "rejected", "PREPARED_MESSAGE_TOO_LONG", 0)
		}
		rec.Phase = "started"
		rec.Evidence.Code = "INJECTION_STARTED"
		rec.Evidence.Attempts = 1
		swapped, err := store.CompareAndSwapMessage(ctx, rec, rec.Version)
		if err != nil || !swapped {
			return messageResult(o.MessageID, "rejected", "MESSAGE_RESERVATION_UNAVAILABLE", 0)
		}
		rec.Version++
		delivery, err := m.messenger.Deliver(ctx, id, message)
		result := messageResult(o.MessageID, "submitted_unconfirmed", "CONFIRMATION_UNAVAILABLE", 1)
		if err != nil {
			result.Evidence.Code = "INJECTION_ERROR"
			return result
		}
		if delivery != sessionguard.Sent {
			result.Outcome = "rejected"
			result.Evidence.Code = guardMessageCode(delivery)
			return result
		}
		if !m.harnessNudgeSafe(before.Harness) {
			return result
		}
		return m.confirmMessage(ctx, id, before.Activity.LastActivityAt, result)
	}()
	result, err = finish(result)
	if err != nil || result.Outcome == "acknowledged" || result.Outcome == "rejected" || !o.RequireAck {
		return result, err
	}
	timeout := domain.MessageAckTimeout
	if o.AckTimeoutMS != 0 {
		timeout = time.Duration(o.AckTimeoutMS) * time.Millisecond
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		current, exists, readErr := store.GetMessage(waitCtx, o.MessageID)
		if readErr == nil && exists && current.Outcome == "acknowledged" {
			return current.MessageResult, nil
		}
		if readErr != nil && waitCtx.Err() == nil {
			return domain.MessageResult{}, readErr
		}
		select {
		case <-waitCtx.Done():
			result.Outcome = "ack_timeout"
			result.Evidence.Code = "ACK_TIMEOUT"
			if ctx.Err() != nil {
				result.Evidence.Code = "ACK_WAIT_CANCELLED"
			}
			return finish(result)
		case <-ticker.C:
		}
	}
}
func guardMessageCode(outcome sessionguard.Outcome) string {
	switch outcome {
	case sessionguard.SuppressedNotFound:
		return "SESSION_NOT_FOUND"
	case sessionguard.SuppressedTerminated:
		return "SESSION_TERMINATED"
	case sessionguard.SuppressedExited:
		return "SESSION_AGENT_EXITED"
	case sessionguard.SuppressedAwaitingUser:
		return "SESSION_AWAITING_DECISION"
	case sessionguard.Attempted, sessionguard.SuppressedDraftPending:
		return "SESSION_DRAFT_PENDING"
	case sessionguard.Incomplete:
		return "SESSION_DRAFT_INCOMPLETE"
	default:
		return "SESSION_STATE_UNKNOWN"
	}
}

// finishMessage uses bounded independent custody cleanup even after request cancellation.
func finishMessage(store messageStore, identity domain.MessageRecord, result domain.MessageResult) (domain.MessageResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	for ctx.Err() == nil {
		current, exists, err := store.GetMessage(ctx, identity.MessageID)
		if err != nil {
			return domain.MessageResult{}, err
		}
		if !exists {
			return domain.MessageResult{}, errors.New("message custody missing")
		}
		if current.Outcome == "acknowledged" {
			return current.MessageResult, nil
		}
		current.MessageResult = result
		current.Phase = "final"
		current.Evidence.RecordedAt = time.Now().UTC().Format(time.RFC3339Nano)
		swapped, err := store.CompareAndSwapMessage(ctx, current, current.Version)
		if err != nil {
			return domain.MessageResult{}, err
		}
		if swapped {
			return current.MessageResult, nil
		}
	}
	return domain.MessageResult{}, ctx.Err()
}
func (m *Manager) AckMessage(ctx context.Context, id domain.SessionID, messageID string) (domain.MessageResult, error) {
	if !domain.ValidMessageID(messageID) {
		return domain.MessageResult{}, MessageValidationError{"invalid message_id"}
	}
	store, ok := m.store.(messageStore)
	if !ok {
		return domain.MessageResult{}, errors.New("message custody unavailable")
	}
	for ctx.Err() == nil {
		rec, exists, err := store.GetMessage(ctx, messageID)
		if err != nil {
			return domain.MessageResult{}, err
		}
		if !exists || rec.SessionID != id || !rec.RequireAck || rec.Phase == "reserved" || rec.Outcome == "rejected" {
			return messageResult(messageID, "rejected", "ACK_RECORD_MISMATCH", 0), nil
		}
		if rec.Outcome == "acknowledged" {
			return rec.MessageResult, nil
		}
		rec.Outcome = "acknowledged"
		rec.Phase = "final"
		rec.Evidence.Code = "ACKNOWLEDGED"
		rec.Evidence.Signal = "explicit_ack"
		rec.Evidence.RecordedAt = time.Now().UTC().Format(time.RFC3339Nano)
		rec.Evidence.AcknowledgedAt = rec.Evidence.RecordedAt
		swapped, err := store.CompareAndSwapMessage(ctx, rec, rec.Version)
		if err != nil {
			return domain.MessageResult{}, err
		}
		if swapped {
			return rec.MessageResult, nil
		}
	}
	return domain.MessageResult{}, fmt.Errorf("ack: %w", ctx.Err())
}
func (m *Manager) confirmMessage(ctx context.Context, id domain.SessionID, baseline time.Time, result domain.MessageResult) domain.MessageResult {
	for attempt := 1; ; attempt++ {
		outcome, err := m.waitForActive(ctx, id, baseline, result.MessageID)
		if err != nil {
			result.Evidence.Code = "CONFIRMATION_INTERRUPTED"
			return result
		}
		if outcome == waitAcknowledged {
			return result
		}
		if outcome == waitActive {
			result.Outcome = "submitted_confirmed"
			result.Evidence.Code = "SUBMISSION_CONFIRMED"
			result.Evidence.Signal = "activity_active"
			return result
		}
		if outcome == waitBlocked {
			result.Outcome = "rejected"
			result.Evidence.Code = "SESSION_AWAITING_DECISION"
			return result
		}
		if attempt >= m.sendConfirm.maxAttempts {
			result.Evidence.Code = "CONFIRMATION_EXHAUSTED"
			return result
		}
		store := m.store.(messageStore)
		alreadyAck, progressErr := recordMessageAttempt(ctx, store, result.MessageID, result.Evidence.Attempts+1)
		if alreadyAck {
			return result
		}
		if progressErr != nil {
			result.Evidence.Code = "CONFIRMATION_CUSTODY_UNAVAILABLE"
			return result
		}
		nudge, err := m.messenger.Deliver(ctx, id, "")
		result.Evidence.Attempts++
		if err != nil {
			result.Evidence.Code = "CONFIRMATION_NUDGE_ERROR"
			return result
		}
		if nudge != sessionguard.Sent {
			result.Outcome = "rejected"
			result.Evidence.Code = guardMessageCode(nudge)
			return result
		}
	}
}

func recordMessageAttempt(ctx context.Context, store messageStore, id string, attempts int) (bool, error) {
	for ctx.Err() == nil {
		rec, exists, err := store.GetMessage(ctx, id)
		if err != nil {
			return false, err
		}
		if !exists {
			return false, errors.New("message custody missing")
		}
		if rec.Outcome == "acknowledged" {
			return true, nil
		}
		rec.Evidence.Attempts = attempts
		rec.Evidence.RecordedAt = time.Now().UTC().Format(time.RFC3339Nano)
		swapped, err := store.CompareAndSwapMessage(ctx, rec, rec.Version)
		if err != nil {
			return false, err
		}
		if swapped {
			return false, nil
		}
	}
	return false, ctx.Err()
}
