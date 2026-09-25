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

// ---- sessions ----

// CreateSession assigns the per-project identity ("{project}-{num}") and inserts
// the record, returning it with ID populated. The next-num read and the insert
// run on the writer connection under writeMu, so two concurrent creates in the
// same project can't collide on num.
func (s *Store) CreateSession(ctx context.Context, rec domain.SessionRecord) (domain.SessionRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	defer tx.Rollback()
	q := gen.New(tx)
	var num int64
	err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(num),0)+1 FROM (SELECT num FROM sessions WHERE project_id=? UNION ALL SELECT session_num AS num FROM spawn_attempt_sessions WHERE project_id=?)", rec.ProjectID, rec.ProjectID).Scan(&num)
	if err != nil {
		return domain.SessionRecord{}, err
	}
	rec.ID = domain.SessionID(fmt.Sprintf("%s-%d", rec.ProjectID, num))
	if err := q.InsertSession(ctx, recordToInsert(rec, num)); err != nil {
		return domain.SessionRecord{}, err
	}
	if rec.Metadata.SpawnAttemptID != "" {
		if _, err := tx.ExecContext(ctx, "INSERT INTO spawn_attempt_sessions(session_id,attempt_id,project_id,session_num) VALUES (?,?,?,?)", rec.ID, rec.Metadata.SpawnAttemptID, rec.ProjectID, num); err != nil {
			return domain.SessionRecord{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return domain.SessionRecord{}, err
	}

	return rec, nil
}

// UpdateSession writes the full mutable state of an existing session. The
// id/project/num/created_at are immutable and not touched here.
func (s *Store) UpdateSession(ctx context.Context, rec domain.SessionRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.qw.UpdateSession(ctx, recordToUpdate(rec))
}

// UpdateSessionAndClearPaneDraft commits the manual submit activity and draft
// clearance together. A crash must not leave a submitted prompt marked as an
// unsent draft, or replay might press Enter on the next prompt.
func (s *Store) UpdateSessionAndClearPaneDraft(ctx context.Context, rec domain.SessionRecord) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.qw.WithTx(tx).UpdateSession(ctx, recordToUpdate(rec)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE sessions SET pane_draft_pending = 0 WHERE id = ?", string(rec.ID)); err != nil {
		return err
	}
	return tx.Commit()
}

// PaneDraftPending is a write-ahead marker for a pane that may contain an
// unsubmitted paste. It survives daemon restarts and is independent of
// activity state, which can change while a draft remains in the composer.
func (s *Store) PaneDraftPending(ctx context.Context, id domain.SessionID) (bool, error) {
	var pending bool
	err := s.readDB.QueryRowContext(ctx, "SELECT pane_draft_pending FROM sessions WHERE id = ?", string(id)).Scan(&pending)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return pending, err
}

func (s *Store) SetPaneDraftPending(ctx context.Context, id domain.SessionID, pending bool) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, `UPDATE sessions SET pane_draft_pending = ?,
		pane_draft_marked_at = CASE WHEN ? THEN ? ELSE pane_draft_marked_at END,
		pane_draft_owner = CASE WHEN ? THEN '' ELSE pane_draft_owner END,
		pane_draft_complete = CASE WHEN ? THEN 0 ELSE pane_draft_complete END
		WHERE id = ?`, pending, pending, time.Now().UnixNano(), pending, pending, string(id))
	return err
}

func (s *Store) SetPaneDraftOwned(ctx context.Context, id domain.SessionID, owner string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, "UPDATE sessions SET pane_draft_pending = 1, pane_draft_owner = ?, pane_draft_complete = 0, pane_draft_marked_at = ? WHERE id = ?", owner, time.Now().UnixNano(), string(id))
	return err
}

func (s *Store) PaneDraftMarkedAt(ctx context.Context, id domain.SessionID) (bool, time.Time, error) {
	var pending bool
	var markedAt int64
	err := s.readDB.QueryRowContext(ctx, "SELECT pane_draft_pending, pane_draft_marked_at FROM sessions WHERE id = ?", string(id)).Scan(&pending, &markedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return false, time.Time{}, nil
	}
	return pending, time.Unix(0, markedAt), err
}

func (s *Store) MarkPaneDraftComplete(ctx context.Context, id domain.SessionID, owner string) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, "UPDATE sessions SET pane_draft_complete = 1 WHERE id = ? AND pane_draft_pending = 1 AND pane_draft_owner = ?", string(id), owner)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return fmt.Errorf("pane draft %s owner changed before completion", id)
	}
	return nil
}

func (s *Store) PaneDraftReceipt(ctx context.Context, id domain.SessionID) (bool, string, bool, int64, error) {
	var pending, complete bool
	var owner string
	var generation int64
	err := s.readDB.QueryRowContext(ctx, "SELECT pane_draft_pending, pane_draft_owner, pane_draft_complete, pane_generation FROM sessions WHERE id = ?", string(id)).Scan(&pending, &owner, &complete, &generation)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", false, 0, nil
	}
	return pending, owner, complete, generation, err
}

func (s *Store) PaneGeneration(ctx context.Context, id domain.SessionID) (int64, error) {
	var generation int64
	err := s.readDB.QueryRowContext(ctx, "SELECT pane_generation FROM sessions WHERE id = ?", string(id)).Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return generation, err
}

// AdvancePaneGenerationAndClearDraft makes a replaced pane distinguishable
// from a manually submitted draft after a daemon crash.
func (s *Store) AdvancePaneGenerationAndClearDraft(ctx context.Context, id domain.SessionID) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx,
		"UPDATE sessions SET pane_generation = pane_generation + 1, pane_draft_pending = 0, pane_draft_owner = '', pane_draft_complete = 0 WHERE id = ?", string(id))
	return err
}

// RenameSession updates only the user-facing display name for an existing
// session. It returns ok=false when the session id does not exist. The
// sessions_cdc_update trigger fans out a session_updated CDC event when the
// display name actually changes.
func (s *Store) RenameSession(ctx context.Context, id domain.SessionID, displayName string, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.RenameSession(ctx, gen.RenameSessionParams{
		ID:          id,
		DisplayName: displayName,
		UpdatedAt:   updatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("rename session %s: %w", id, err)
	}
	return rows > 0, nil
}

// SetSessionPreviewURL updates only the browser preview URL for an existing
// session. It returns ok=false when the session id does not exist. The
// sessions_cdc_update trigger fans out a session_updated CDC event when the
// preview URL actually changes.
func (s *Store) SetSessionPreviewURL(ctx context.Context, id domain.SessionID, previewURL string, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.SetSessionPreviewURL(ctx, gen.SetSessionPreviewURLParams{
		ID:         id,
		PreviewURL: previewURL,
		UpdatedAt:  updatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("set preview url for session %s: %w", id, err)
	}
	return rows > 0, nil
}

// SetSessionTerminateOnPRMerge updates the user's merge-completion lifecycle
// policy. It returns ok=false when the session id does not exist.
func (s *Store) SetSessionTerminateOnPRMerge(ctx context.Context, id domain.SessionID, terminate bool, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.SetSessionTerminateOnPRMerge(ctx, gen.SetSessionTerminateOnPRMergeParams{
		ID:                 id,
		TerminateOnPRMerge: terminate,
		UpdatedAt:          updatedAt,
	})
	if err != nil {
		return false, fmt.Errorf("set terminate-on-pr-merge for session %s: %w", id, err)
	}
	return rows > 0, nil
}

// DeleteSession removes a session row, but only if it is still in seed state
// (no workspace, no runtime handle, no agent session id, no prompt, and not
// already terminated). Rows that have observable spawn output are immutable
// to preserve the no-resurrection guarantee — for those, callers fall back to
// MarkTerminated (lifecycle.Manager) instead.
//
// The deletion runs in a transaction. It first probes seed state with
// SessionIsSeed; only if that returns true does it clear the session's
// change_log rows (required because change_log FKs sessions(id) without
// ON DELETE CASCADE) and then delete the session row. For live or absent
// sessions the transaction commits with no rows touched — critically, the
// session_created / session_updated CDC events for live sessions are NOT
// destroyed when callers (e.g. RollbackSpawn's delete-then-kill fallback)
// invoke DeleteSession on a fully-spawned row.
//
// Returns deleted=true when a seed row was removed; deleted=false when the
// session id did not match a seed row (either it never existed, or it had
// already progressed past seed state). The latter case is benign — the caller
// should fall back to MarkTerminated.
func (s *Store) DeleteSession(ctx context.Context, id domain.SessionID) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin delete seed session: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)

	isSeed, err := q.SessionIsSeed(ctx, id)
	if err != nil {
		return false, fmt.Errorf("delete seed session: probe seed state for %s: %w", id, err)
	}
	if !isSeed {
		// Commit the empty tx so we don't leak a transaction. Critically, do
		// NOT touch change_log here — for a live session that contains real
		// session_created / session_updated CDC events.
		if err := tx.Commit(); err != nil {
			return false, fmt.Errorf("delete seed session: commit no-op: %w", err)
		}
		return false, nil
	}

	// Drop change_log rows for this session id first so the FK doesn't reject
	// the session DELETE. We do not touch project-level events (session_id IS
	// NULL) — those belong to the project, not this session. Both this DELETE
	// and the session DELETE below run via raw ExecContext to sidestep sqlc
	// 1.31's SQLite-parser bug, which strips trailing `?` placeholders and
	// string literals from DELETE statements (see queries/changelog.sql and
	// queries/sessions.sql for the documented workaround context).
	if _, err := tx.ExecContext(ctx, `DELETE FROM change_log WHERE session_id = ?`, id); err != nil {
		return false, fmt.Errorf("delete seed session: clear change log for %s: %w", id, err)
	}
	res, err := tx.ExecContext(ctx, `
DELETE FROM sessions
WHERE id = ?
  AND is_terminated = 0
  AND workspace_path = ''
  AND runtime_handle_id = ''
  AND agent_session_id = ''
  AND prompt = ''`, id)
	if err != nil {
		return false, fmt.Errorf("delete seed session %s: %w", id, err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("delete seed session %s: rows affected: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("delete seed session: commit: %w", err)
	}
	return n > 0, nil
}

// GetSession returns the full record for a session, or ok=false if absent.
func (s *Store) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	row, err := s.qr.GetSession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.SessionRecord{}, false, nil
	}
	if err != nil {
		return domain.SessionRecord{}, false, fmt.Errorf("get session %s: %w", id, err)
	}
	return rowToRecord(row), true, nil
}

// ListSessions returns every session in a project, ordered by num.
func (s *Store) ListSessions(ctx context.Context, project domain.ProjectID) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListSessionsByProject(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list sessions for %s: %w", project, err)
	}
	return mapSessionRows(rows), nil
}

// ListAllSessions returns every session across all projects.
func (s *Store) ListAllSessions(ctx context.Context) ([]domain.SessionRecord, error) {
	rows, err := s.qr.ListAllSessions(ctx)
	if err != nil {
		return nil, fmt.Errorf("list all sessions: %w", err)
	}
	return mapSessionRows(rows), nil
}

func mapSessionRows(rows []gen.Session) []domain.SessionRecord {
	out := make([]domain.SessionRecord, 0, len(rows))
	for _, r := range rows {
		out = append(out, rowToRecord(r))
	}
	return out
}

func rowToRecord(row gen.Session) domain.SessionRecord {
	return domain.SessionRecord{
		ID:          row.ID,
		ProjectID:   row.ProjectID,
		IssueID:     row.IssueID,
		Kind:        row.Kind,
		Harness:     row.Harness,
		DisplayName: row.DisplayName,
		Activity: domain.Activity{
			State:          row.ActivityState,
			LastActivityAt: row.ActivityLastAt,
		},
		FirstSignalAt:      nullTimeToTime(row.FirstSignalAt),
		IsTerminated:       row.IsTerminated,
		TerminateOnPRMerge: row.TerminateOnPRMerge,
		Metadata: domain.SessionMetadata{
			Branch:            row.Branch,
			WorkspacePath:     row.WorkspacePath,
			WorkspaceRepoPath: row.WorkspaceRepoPath,
			RuntimeHandleID:   row.RuntimeHandleID,
			RuntimeLaunchID:   row.RuntimeLaunchID,
			AgentSessionID:    row.AgentSessionID,
			Prompt:            row.Prompt,
			PreviewURL:        row.PreviewURL,
			PreviewRevision:   row.PreviewRevision,
		},
		CleanupGeneration: row.CleanupGeneration,
		CreatedAt:         row.CreatedAt,
		UpdatedAt:         row.UpdatedAt,
	}
}

func recordToInsert(rec domain.SessionRecord, num int64) gen.InsertSessionParams {
	activity := normalActivity(rec.Activity, rec.CreatedAt)
	return gen.InsertSessionParams{
		ID:                 rec.ID,
		ProjectID:          rec.ProjectID,
		Num:                num,
		IssueID:            rec.IssueID,
		Kind:               rec.Kind,
		Harness:            rec.Harness,
		DisplayName:        rec.DisplayName,
		ActivityState:      activity.State,
		ActivityLastAt:     activity.LastActivityAt,
		FirstSignalAt:      timeToNullTime(rec.FirstSignalAt),
		IsTerminated:       rec.IsTerminated,
		Branch:             rec.Metadata.Branch,
		WorkspacePath:      rec.Metadata.WorkspacePath,
		WorkspaceRepoPath:  rec.Metadata.WorkspaceRepoPath,
		RuntimeHandleID:    rec.Metadata.RuntimeHandleID,
		RuntimeLaunchID:    rec.Metadata.RuntimeLaunchID,
		AgentSessionID:     rec.Metadata.AgentSessionID,
		Prompt:             rec.Metadata.Prompt,
		PreviewURL:         rec.Metadata.PreviewURL,
		PreviewRevision:    rec.Metadata.PreviewRevision,
		TerminateOnPRMerge: rec.TerminateOnPRMerge,
		CleanupGeneration:  rec.CleanupGeneration,
		CreatedAt:          rec.CreatedAt,
		UpdatedAt:          rec.UpdatedAt,
	}
}

func recordToUpdate(rec domain.SessionRecord) gen.UpdateSessionParams {
	activity := normalActivity(rec.Activity, rec.UpdatedAt)
	return gen.UpdateSessionParams{
		ID:                 rec.ID,
		IssueID:            rec.IssueID,
		Kind:               rec.Kind,
		Harness:            rec.Harness,
		DisplayName:        rec.DisplayName,
		ActivityState:      activity.State,
		ActivityLastAt:     activity.LastActivityAt,
		FirstSignalAt:      timeToNullTime(rec.FirstSignalAt),
		IsTerminated:       rec.IsTerminated,
		Branch:             rec.Metadata.Branch,
		WorkspacePath:      rec.Metadata.WorkspacePath,
		WorkspaceRepoPath:  rec.Metadata.WorkspaceRepoPath,
		RuntimeHandleID:    rec.Metadata.RuntimeHandleID,
		RuntimeLaunchID:    rec.Metadata.RuntimeLaunchID,
		AgentSessionID:     rec.Metadata.AgentSessionID,
		Prompt:             rec.Metadata.Prompt,
		PreviewURL:         rec.Metadata.PreviewURL,
		PreviewRevision:    rec.Metadata.PreviewRevision,
		TerminateOnPRMerge: rec.TerminateOnPRMerge,
		CleanupGeneration:  rec.CleanupGeneration,
		UpdatedAt:          rec.UpdatedAt,
	}
}

// nullTimeToTime / timeToNullTime bridge the nullable first_signal_at column
// to the domain's zero-time convention (zero = no signal received yet).
func nullTimeToTime(t sql.NullTime) time.Time {
	if !t.Valid {
		return time.Time{}
	}
	return t.Time
}

func timeToNullTime(t time.Time) sql.NullTime {
	if t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t, Valid: true}
}

func normalActivity(a domain.Activity, fallback time.Time) domain.Activity {
	if a.State == "" {
		a.State = domain.ActivityIdle
	}
	if a.LastActivityAt.IsZero() {
		a.LastActivityAt = fallback
	}
	if a.LastActivityAt.IsZero() {
		a.LastActivityAt = time.Now().UTC()
	}
	return a
}

// SpawnAttemptForSession reads immutable custody even after seed rollback.
func (s *Store) SpawnAttemptForSession(ctx context.Context, id domain.SessionID) (string, error) {
	var attempt string
	err := s.readDB.QueryRowContext(ctx, "SELECT attempt_id FROM spawn_attempt_sessions WHERE session_id=?", id).Scan(&attempt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return attempt, err
}
func (s *Store) SessionForSpawnAttempt(ctx context.Context, id string) (domain.SessionID, error) {
	var session domain.SessionID
	err := s.readDB.QueryRowContext(ctx, "SELECT session_id FROM spawn_attempt_sessions WHERE attempt_id=?", id).Scan(&session)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return session, err
}
