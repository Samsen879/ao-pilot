package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// ScheduleOrchestratorReengagement schedules or resets re-engagement after an idle transition.
func (s *Store) ScheduleOrchestratorReengagement(ctx context.Context, id domain.SessionID, next, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.ScheduleOrchestratorReengagement(ctx, gen.ScheduleOrchestratorReengagementParams{
		SessionID:     string(id),
		NextAttemptAt: next,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
}

// EnsureOrchestratorReengagement creates missing durable state for an idle orchestrator.
func (s *Store) EnsureOrchestratorReengagement(ctx context.Context, id domain.SessionID, next, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.EnsureOrchestratorReengagement(ctx, gen.EnsureOrchestratorReengagementParams{
		SessionID:     string(id),
		NextAttemptAt: next,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
}

// MarkOrchestratorReengagementProgress records productive work after an attempt.
func (s *Store) MarkOrchestratorReengagementProgress(ctx context.Context, id domain.SessionID, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.qw.MarkOrchestratorReengagementProgress(ctx, gen.MarkOrchestratorReengagementProgressParams{
		SessionID: string(id),
		UpdatedAt: now,
	})
	return err
}

// ListDueOrchestratorReengagements returns active re-engagements due by now.
func (s *Store) ListDueOrchestratorReengagements(ctx context.Context, now time.Time) ([]domain.OrchestratorReengagement, error) {
	rows, err := s.qr.ListDueOrchestratorReengagements(ctx, now)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OrchestratorReengagement, 0, len(rows))
	for _, row := range rows {
		out = append(out, orchestratorReengagementFromRow(row))
	}
	return out, nil
}

// GetOrchestratorReengagement loads durable re-engagement state for a session.
func (s *Store) GetOrchestratorReengagement(ctx context.Context, id domain.SessionID) (domain.OrchestratorReengagement, bool, error) {
	row, err := s.qr.GetOrchestratorReengagement(ctx, string(id))
	if errors.Is(err, sql.ErrNoRows) {
		return domain.OrchestratorReengagement{}, false, nil
	}
	if err != nil {
		return domain.OrchestratorReengagement{}, false, err
	}
	return orchestratorReengagementFromRow(row), true, nil
}

// OrchestratorReengagementPendingEnter survives daemon restarts. A pending
// draft must receive only Enter on the next safe attempt, never a second paste.
func (s *Store) OrchestratorReengagementPendingEnter(ctx context.Context, id domain.SessionID) (bool, int64, error) {
	var pending bool
	var generation int64
	err := s.readDB.QueryRowContext(ctx, "SELECT pending_enter, pending_enter_generation FROM orchestrator_reengagements WHERE session_id = ?", string(id)).Scan(&pending, &generation)
	return pending, generation, err
}

func (s *Store) DeferOrchestratorReengagementPendingEnter(ctx context.Context, id domain.SessionID, generation int64, next, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, "UPDATE orchestrator_reengagements SET pending_enter = 1, pending_enter_generation = ?, next_attempt_at = ?, updated_at = ? WHERE session_id = ? AND state = 'active'", generation, next, now, string(id))
	return err
}

func (s *Store) ClearOrchestratorReengagementPendingEnter(ctx context.Context, id domain.SessionID) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, "UPDATE orchestrator_reengagements SET pending_enter = 0 WHERE session_id = ?", string(id))
	return err
}

// RecordOrchestratorReengagementAttempt advances the attempt count and retry state.
func (s *Store) RecordOrchestratorReengagementAttempt(ctx context.Context, id domain.SessionID, next, now time.Time, maxAttempts int) (domain.OrchestratorReengagement, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return domain.OrchestratorReengagement{}, err
	}
	defer tx.Rollback()
	row, err := s.qw.WithTx(tx).RecordOrchestratorReengagementAttempt(ctx, gen.RecordOrchestratorReengagementAttemptParams{
		SessionID:     string(id),
		NextAttemptAt: next,
		LastAttemptAt: sql.NullTime{Time: now, Valid: true},
		AttemptCount:  int64(maxAttempts),
		UpdatedAt:     now,
	})
	if err != nil {
		return domain.OrchestratorReengagement{}, fmt.Errorf("record orchestrator re-engagement attempt: %w", err)
	}
	// Clear the pending draft in the same transaction as its recorded Enter.
	if _, err := tx.ExecContext(ctx, "UPDATE orchestrator_reengagements SET pending_enter = 0 WHERE session_id = ?", string(id)); err != nil {
		return domain.OrchestratorReengagement{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET pane_draft_owner = '', pane_draft_complete = 0 WHERE id = ? AND pane_draft_pending = 0 AND pane_draft_owner = ?", string(id), "orchestrator\x00"+string(id)); err != nil {
		return domain.OrchestratorReengagement{}, err
	}
	if err := tx.Commit(); err != nil {
		return domain.OrchestratorReengagement{}, err
	}
	return orchestratorReengagementFromRow(row), nil
}

// ListPendingOrchestratorAttention returns exhausted loops whose terminal
// human-attention notification has not been delivered.
func (s *Store) ListPendingOrchestratorAttention(ctx context.Context) ([]domain.OrchestratorReengagement, error) {
	rows, err := s.qr.ListPendingOrchestratorAttention(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.OrchestratorReengagement, 0, len(rows))
	for _, row := range rows {
		out = append(out, orchestratorReengagementFromRow(row))
	}
	return out, nil
}

// MarkOrchestratorAttentionNotified records successful delivery of the
// terminal human-attention notification.
func (s *Store) MarkOrchestratorAttentionNotified(ctx context.Context, id domain.SessionID, now time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.MarkOrchestratorAttentionNotified(ctx, gen.MarkOrchestratorAttentionNotifiedParams{
		SessionID: string(id),
		UpdatedAt: now,
	})
	return rows > 0, err
}

// CompleteOrchestratorReengagement permanently marks a session's loop complete.
func (s *Store) CompleteOrchestratorReengagement(ctx context.Context, id domain.SessionID, now time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.CompleteOrchestratorReengagement(ctx, gen.CompleteOrchestratorReengagementParams{
		SessionID:     string(id),
		NextAttemptAt: now,
		CreatedAt:     now,
		UpdatedAt:     now,
	})
	return rows > 0, err
}

func orchestratorReengagementFromRow(row gen.OrchestratorReengagement) domain.OrchestratorReengagement {
	var lastAttempt time.Time
	if row.LastAttemptAt.Valid {
		lastAttempt = row.LastAttemptAt.Time
	}
	return domain.OrchestratorReengagement{
		SessionID:            domain.SessionID(row.SessionID),
		AttemptCount:         int(row.AttemptCount),
		NextAttemptAt:        row.NextAttemptAt,
		LastAttemptAt:        lastAttempt,
		ProgressSinceAttempt: row.ProgressSinceAttempt,
		AttentionNotified:    row.AttentionNotified,
		State:                domain.OrchestratorReengagementState(row.State),
		CreatedAt:            row.CreatedAt,
		UpdatedAt:            row.UpdatedAt,
	}
}
