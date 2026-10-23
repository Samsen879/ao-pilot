package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMessageOptionsRejectExplicitNullOrInvalidID(t *testing.T) {
	for _, input := range []string{
		`{"message":"task","require_ack":null}`,
		`{"message":"task","message_id":null}`,
		`{"message":"task","message_id":""}`,
		`{"message":"task","message_id":"line\nbreak"}`,
		`{"message":"task","message_id":"x;exit"}`,
		`{"message":"task","message_id":"` + strings.Repeat("x", 129) + `"}`,
		`{"message":"task","Require_Ack":null}`,
		`{"message":"task","MESSAGE_ID":null}`,
	} {
		var options MessageOptions
		if err := json.Unmarshal([]byte(input), &options); err == nil {
			t.Fatalf("explicit invalid input accepted: %s -> %+v", input, options)
		}
	}
}
func TestMessageOptionsOmissionAndExplicitFalseRemainValid(t *testing.T) {
	for _, input := range []string{`{"message":"task"}`, `{"message":"task","require_ack":false}`, `{"message":"task","message_id":"safe-ID_123","require_ack":true}`} {
		var options MessageOptions
		if err := json.Unmarshal([]byte(input), &options); err != nil {
			t.Fatal(input, err)
		}
		if options.Message != "task" {
			t.Fatal(options)
		}
	}
}
