-- +goose Up
ALTER TABLE session_worktrees
ADD COLUMN recovery_activity_at INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE session_worktrees DROP COLUMN recovery_activity_at;
