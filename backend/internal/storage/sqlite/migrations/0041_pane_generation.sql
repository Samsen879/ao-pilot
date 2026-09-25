-- +goose Up
ALTER TABLE sessions ADD COLUMN pane_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pane_draft_owner TEXT NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN pane_draft_complete BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pane_draft_marked_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orchestrator_reengagements ADD COLUMN pending_enter_generation INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE orchestrator_reengagements DROP COLUMN pending_enter_generation;
ALTER TABLE sessions DROP COLUMN pane_draft_complete;
ALTER TABLE sessions DROP COLUMN pane_draft_marked_at;
ALTER TABLE sessions DROP COLUMN pane_draft_owner;
ALTER TABLE sessions DROP COLUMN pane_generation;
