-- +goose Up
ALTER TABLE orchestrator_reengagements ADD COLUMN pending_enter BOOLEAN NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE orchestrator_reengagements DROP COLUMN pending_enter;
