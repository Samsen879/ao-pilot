-- +goose Up
-- Independent audit custody survives session deletion. No plaintext or replay payload.
CREATE TABLE session_messages (
 message_id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 text_sha256 TEXT NOT NULL CHECK(length(text_sha256)=64),
 require_ack INTEGER NOT NULL CHECK(require_ack IN (0,1)),
 phase TEXT NOT NULL CHECK(phase IN ('reserved','started','final')),
 outcome TEXT NOT NULL CHECK(outcome IN ('submitted_confirmed','submitted_unconfirmed','rejected','acknowledged','ack_timeout')),
 evidence TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL
);
CREATE INDEX session_messages_session ON session_messages(session_id);
-- +goose Down
-- Development only. Deployment rollback never runs Down or deletes audit custody.
DROP TABLE session_messages;
