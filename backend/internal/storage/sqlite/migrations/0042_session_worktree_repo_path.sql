-- +goose Up
ALTER TABLE session_worktrees ADD COLUMN repo_path TEXT NOT NULL DEFAULT '';

-- +goose Down
ALTER TABLE session_worktrees DROP COLUMN repo_path;
