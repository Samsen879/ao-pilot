-- +goose Up
ALTER TABLE sessions ADD COLUMN pane_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orchestrator_reengagements ADD COLUMN pending_enter_generation INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE orchestrator_reengagements DROP COLUMN pending_enter_generation;
ALTER TABLE sessions DROP COLUMN pane_generation;
