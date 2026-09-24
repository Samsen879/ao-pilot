-- +goose Up
ALTER TABLE orchestrator_reengagements ADD COLUMN pending_enter BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pane_draft_pending BOOLEAN NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE orchestrator_reengagements DROP COLUMN pending_enter;
ALTER TABLE sessions DROP COLUMN pane_draft_pending;
