-- +goose Up
CREATE TABLE project_pauses (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE
);
CREATE TABLE task_checkpoints (
 sequence INTEGER PRIMARY KEY,
 message_id TEXT NOT NULL REFERENCES session_messages(message_id),
 kind TEXT NOT NULL CHECK(kind IN ('started','artifact','blocked')),
 detail TEXT NOT NULL,
 digest TEXT NOT NULL,
 recorded_at TEXT NOT NULL
);
CREATE INDEX task_checkpoints_message ON task_checkpoints(message_id, sequence);
CREATE UNIQUE INDEX first_task_start ON task_checkpoints(message_id) WHERE kind='started';
CREATE INDEX task_dispatch_order ON session_messages(created_at DESC, message_id) WHERE require_ack=1;
-- +goose Down
DROP INDEX task_dispatch_order;
DROP TABLE task_checkpoints;
DROP TABLE project_pauses;
