-- +goose Up
-- No foreign key: attempt identity must survive rollback/deletion of a seed.
CREATE TABLE spawn_attempt_sessions (
 session_id TEXT PRIMARY KEY,
 attempt_id TEXT NOT NULL UNIQUE,
 project_id TEXT NOT NULL,
 session_num INTEGER NOT NULL
);
-- +goose Down
DROP TABLE spawn_attempt_sessions;
