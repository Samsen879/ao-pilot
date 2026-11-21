-- +goose Up
-- Archive only observed revisions. For legacy records the first available
-- revision can be greater than zero.
CREATE TABLE session_message_history (
 message_id TEXT NOT NULL,
 version INTEGER NOT NULL,
 phase TEXT NOT NULL,
 outcome TEXT NOT NULL,
 evidence TEXT NOT NULL,
 PRIMARY KEY(message_id, version)
);
-- +goose StatementBegin
CREATE TRIGGER archive_session_message BEFORE UPDATE ON session_messages
BEGIN
 INSERT INTO session_message_history(message_id,version,phase,outcome,evidence)
 VALUES(OLD.message_id,OLD.version,OLD.phase,OLD.outcome,OLD.evidence);
END;
-- +goose StatementEnd

-- +goose Down
DROP TRIGGER archive_session_message;
DROP TABLE session_message_history;
