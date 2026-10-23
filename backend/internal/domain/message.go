package domain

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"time"
)

const MessageContractVersion = "ao.message-contract.v1"
const MessageSendTimeout = 90 * time.Second
const MessageAckTimeout = 30 * time.Second
const MessageMaxAckTimeout = 60 * time.Second

var messageIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func ValidMessageID(id string) bool { return messageIDPattern.MatchString(id) }

type MessageOptions struct {
	Message      string `json:"message" minLength:"1" maxLength:"4096"`
	MessageID    string `json:"message_id,omitempty" pattern:"^[A-Za-z0-9_-]{1,128}$" maxLength:"128"`
	RequireAck   bool   `json:"require_ack,omitempty"`
	AckTimeoutMS int    `json:"ack_timeout_ms,omitempty" minimum:"1" maximum:"60000"`
}
type MessageEvidence struct {
	Code            string `json:"code"`
	Signal          string `json:"signal" enum:"none,activity_active,explicit_ack"`
	Attempts        int    `json:"attempts"`
	RecordedAt      string `json:"recorded_at"`
	AcknowledgedAt  string `json:"acknowledged_at,omitempty"`
	ExistingOutcome string `json:"existing_outcome,omitempty"`
}
type MessageResult struct {
	MessageID string          `json:"message_id"`
	Outcome   string          `json:"outcome" enum:"submitted_confirmed,submitted_unconfirmed,rejected,acknowledged,ack_timeout"`
	Evidence  MessageEvidence `json:"evidence"`
}

// MessageRecord is an audit record, never a replayable intent. No plaintext is persisted.
type MessageRecord struct {
	MessageResult
	SessionID  SessionID
	TextSHA256 string
	RequireAck bool
	Phase      string
	Version    int64
	CreatedAt  string
}
type MessageContract struct {
	SchemaVersion       string   `json:"schema_version"`
	Authority           string   `json:"authority"`
	RequireAck          bool     `json:"require_ack"`
	DefaultAckTimeoutMS int      `json:"default_ack_timeout_ms"`
	MaxAckTimeoutMS     int      `json:"max_ack_timeout_ms"`
	SendTimeoutMS       int      `json:"send_timeout_ms"`
	Outcomes            []string `json:"outcomes"`
}

func NativeMessageContract() MessageContract {
	return MessageContract{MessageContractVersion, "native", true, 30000, 60000, 90000, []string{"submitted_confirmed", "submitted_unconfirmed", "rejected", "acknowledged", "ack_timeout"}}
}

// Explicit zero/null ACK budgets must not silently turn into a default budget.
func (o *MessageOptions) UnmarshalJSON(data []byte) error {
	type plain MessageOptions
	var value plain
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		return err
	}
	for field, raw := range fields {
		switch field {
		case "message", "message_id", "require_ack", "ack_timeout_ms":
		default:
			return fmt.Errorf("unknown message field %q", field)
		}
		if (field == "require_ack" || field == "message_id") && bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
			return fmt.Errorf("%s cannot be null", field)
		}
	}
	if _, exists := fields["message_id"]; exists && !ValidMessageID(value.MessageID) {
		return fmt.Errorf("message_id must be a nonempty safe ID")
	}
	if raw, exists := fields["ack_timeout_ms"]; exists {
		var budget int
		if bytes.Equal(raw, []byte("null")) {
			return fmt.Errorf("ack_timeout_ms cannot be null")
		}
		if err := json.Unmarshal(raw, &budget); err != nil {
			return err
		}
		if budget < 1 || budget > 60000 || !value.RequireAck {
			return fmt.Errorf("ack_timeout_ms requires require_ack and must be 1..60000")
		}
	}
	*o = MessageOptions(value)
	return nil
}
