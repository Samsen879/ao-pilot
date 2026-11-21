package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func (s *Store) ReserveMessage(ctx context.Context, rec domain.MessageRecord) (bool, error) {
	evidence, err := json.Marshal(rec.Evidence)
	if err != nil {
		return false, err
	}
	result, err := s.writeDB.ExecContext(ctx, `INSERT INTO session_messages(message_id,session_id,text_sha256,require_ack,phase,outcome,evidence,version,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`, rec.MessageID, rec.SessionID, rec.TextSHA256, rec.RequireAck, rec.Phase, rec.Outcome, string(evidence), rec.Version, rec.CreatedAt)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (s *Store) GetMessage(ctx context.Context, id string) (domain.MessageRecord, bool, error) {
	var rec domain.MessageRecord
	var evidence string
	err := s.readDB.QueryRowContext(ctx, `SELECT message_id,session_id,text_sha256,require_ack,phase,outcome,evidence,version,created_at FROM session_messages WHERE message_id=?`, id).Scan(&rec.MessageID, &rec.SessionID, &rec.TextSHA256, &rec.RequireAck, &rec.Phase, &rec.Outcome, &evidence, &rec.Version, &rec.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return rec, false, nil
	}
	if err != nil {
		return rec, false, err
	}
	err = json.Unmarshal([]byte(evidence), &rec.Evidence)
	return rec, true, err
}

// CompareAndSwapMessage makes ACK and completion monotonic across connections/processes.
func (s *Store) CompareAndSwapMessage(ctx context.Context, rec domain.MessageRecord, version int64) (bool, error) {
	evidence, err := json.Marshal(rec.Evidence)
	if err != nil {
		return false, err
	}
	result, err := s.writeDB.ExecContext(ctx, `UPDATE session_messages SET phase=?,outcome=?,evidence=?,version=version+1 WHERE message_id=? AND session_id=? AND text_sha256=? AND require_ack=? AND version=? AND outcome<>'acknowledged'`, rec.Phase, rec.Outcome, string(evidence), rec.MessageID, rec.SessionID, rec.TextSHA256, rec.RequireAck, version)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

// MessageHistory reads the immutable prefix of an already-authorized snapshot.
// A concurrent ACK can append a revision but cannot change this prefix.
func (s *Store) MessageHistory(ctx context.Context, id string, before int64) ([]domain.MessageRevision, error) {
	rows, err := s.readDB.QueryContext(ctx, `SELECT version,phase,outcome,evidence FROM session_message_history WHERE message_id=? AND version<? ORDER BY version`, id, before)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var revisions []domain.MessageRevision
	for rows.Next() {
		var item domain.MessageRevision
		var evidence []byte
		if err := rows.Scan(&item.Version, &item.Phase, &item.Outcome, &evidence); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(evidence, &item.Evidence); err != nil {
			return nil, err
		}
		revisions = append(revisions, item)
	}
	return revisions, rows.Err()
}
