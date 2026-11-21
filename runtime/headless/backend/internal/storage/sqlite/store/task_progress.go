package store

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"time"
)

func (s *Store) AdmitProject(ctx context.Context, id domain.ProjectID) (func(), error) {
	s.admissionMu.RLock()
	var paused bool
	err := s.readDB.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM project_pauses WHERE project_id=?)", id).Scan(&paused)
	if err != nil || paused {
		s.admissionMu.RUnlock()
		if err != nil {
			return nil, err
		}
		return nil, domain.ErrProjectPaused
	}
	return s.admissionMu.RUnlock, nil
}

func (s *Store) SetProjectPause(ctx context.Context, id string, paused bool) error {
	s.admissionMu.Lock()
	defer s.admissionMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var exists bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM projects WHERE id=?)", id).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return domain.ErrMissingProject
	}
	if paused {
		_, err = tx.ExecContext(ctx, "INSERT INTO project_pauses(project_id) VALUES(?) ON CONFLICT DO NOTHING", id)
	} else {
		_, err = tx.ExecContext(ctx, "DELETE FROM project_pauses WHERE project_id=?", id)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) RecordCheckpoint(ctx context.Context, session, id string, e domain.TaskCheckpoint) error {
	r, err := s.writeDB.ExecContext(ctx, `INSERT INTO task_checkpoints(message_id,kind,detail,digest,recorded_at)
 SELECT message_id,?,?,?,? FROM session_messages m JOIN sessions s ON s.id=m.session_id
 WHERE m.message_id=? AND m.session_id=? AND m.require_ack=1 AND m.outcome='acknowledged'
 AND (?<>'started' OR NOT EXISTS(SELECT 1 FROM project_pauses WHERE project_id=s.project_id))
 ON CONFLICT DO NOTHING`, e.Kind, e.Detail, e.Digest, time.Now().UTC().Format(time.RFC3339Nano), id, session, e.Kind)
	if err != nil {
		return err
	}
	n, err := r.RowsAffected()
	if err == nil && n == 0 {
		return domain.ErrCheckpointConflict
	}
	return err
}
func (s *Store) TaskOverview(ctx context.Context, project string) (domain.TaskOverview, error) {
	out := domain.TaskOverview{Tasks: []domain.TaskObservation{}, Paused: []string{}}
	tx, err := s.readDB.BeginTx(ctx, nil)
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, "SELECT project_id FROM project_pauses WHERE ?='' OR project_id=? ORDER BY project_id", project, project)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return out, err
		}
		out.Paused = append(out.Paused, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT s.project_id,m.session_id,m.message_id,m.created_at,m.outcome,coalesce(json_extract(m.evidence,'$.acknowledged_at'),''),
 coalesce(f.recorded_at,''),coalesce(f.detail,''),coalesce(a.detail,''),coalesce(a.digest,''),coalesce(a.recorded_at,''),coalesce(l.kind,''),coalesce(l.detail,''),coalesce(l.digest,''),coalesce(l.recorded_at,'')
 FROM session_messages m JOIN sessions s ON s.id=m.session_id
 LEFT JOIN task_checkpoints f ON f.message_id=m.message_id AND f.kind='started'
 LEFT JOIN task_checkpoints a ON a.sequence=(SELECT max(sequence) FROM task_checkpoints WHERE message_id=m.message_id AND kind='artifact')
 LEFT JOIN task_checkpoints l ON l.sequence=(SELECT max(sequence) FROM task_checkpoints WHERE message_id=m.message_id)
 WHERE m.require_ack=1 AND (?='' OR s.project_id=?) ORDER BY m.created_at DESC,m.message_id LIMIT 100`, project, project)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r domain.TaskObservation
		if err := rows.Scan(&r.Project, &r.Session, &r.MessageID, &r.Sent, &r.Outcome, &r.Ack, &r.Started, &r.FirstCommand, &r.Artifact, &r.ArtifactDigest, &r.ArtifactAt, &r.Latest, &r.Detail, &r.Digest, &r.Updated); err != nil {
			return out, err
		}
		out.Tasks = append(out.Tasks, r)
	}
	return out, rows.Err()
}
