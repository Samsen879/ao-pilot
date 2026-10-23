package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/spf13/cobra"
)

type sendOptions struct {
	session, message, messageID string
	requireAck, json            bool
	ackTimeout                  time.Duration
}
type messageOutcomeError struct{ result domain.MessageResult }

func (e messageOutcomeError) Error() string { return e.result.Outcome + ": " + e.result.Evidence.Code }
func newSendCommand(ctx *commandContext) *cobra.Command {
	var o sendOptions
	cmd := &cobra.Command{Use: "send", Short: "Send once and report durable submission/ACK evidence", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error { return ctx.sendMessageCommand(cmd, o) }}
	cmd.Flags().StringVar(&o.session, "session", "", "Session id (required)")
	cmd.Flags().StringVar(&o.message, "message", "", "Message body (required)")
	cmd.Flags().StringVar(&o.messageID, "message-id", "", "Unique message ID; reuse is rejected, never replayed")
	cmd.Flags().BoolVar(&o.requireAck, "require-ack", false, "Wait for an explicit worker ACK")
	cmd.Flags().DurationVar(&o.ackTimeout, "ack-timeout", domain.MessageAckTimeout, "ACK deadline (maximum 60s)")
	cmd.Flags().BoolVar(&o.json, "json", false, "Print structured message result")
	return cmd
}
func (c *commandContext) sendMessageCommand(cmd *cobra.Command, o sendOptions) error {
	if strings.TrimSpace(o.session) == "" || strings.TrimSpace(o.message) == "" {
		return usageError{errors.New("--session and --message are required")}
	}
	if (o.messageID != "" || cmd.Flags().Changed("message-id")) && !domain.ValidMessageID(o.messageID) {
		return usageError{errors.New("invalid --message-id")}
	}
	if o.requireAck && (o.ackTimeout < time.Millisecond || o.ackTimeout > domain.MessageMaxAckTimeout) {
		return usageError{errors.New("--ack-timeout must be >0 and <=60s")}
	}
	if !o.requireAck && cmd.Flags().Changed("ack-timeout") {
		return usageError{errors.New("--ack-timeout requires --require-ack")}
	}
	message := o.message
	if sender := strings.TrimSpace(os.Getenv("AO_SESSION_ID")); sender != "" {
		message = "[from " + sender + "] " + message
	}
	if err := c.checkMessageContract(cmd.Context()); err != nil {
		return err
	}
	body := domain.MessageOptions{Message: message, MessageID: o.messageID, RequireAck: o.requireAck}
	if o.requireAck {
		body.AckTimeoutMS = int(o.ackTimeout / time.Millisecond)
	}
	var result domain.MessageResult
	err := c.postJSON(cmd.Context(), "sessions/"+url.PathEscape(o.session)+"/messages", body, &result)
	return finishMessageCommand(cmd, result, err, o.json, o.messageID)
}
func newAckCommand(c *commandContext) *cobra.Command {
	var session string
	var asJSON bool
	cmd := &cobra.Command{Use: "ack <message-id>", Short: "Acknowledge reading a message for the target session", Args: func(_ *cobra.Command, args []string) error {
		if len(args) != 1 || !domain.ValidMessageID(args[0]) {
			return usageError{errors.New("ack requires a safe message ID")}
		}
		return nil
	}, RunE: func(cmd *cobra.Command, args []string) error {
		environment := strings.TrimSpace(os.Getenv("AO_SESSION_ID"))
		if session != "" && environment != "" && session != environment {
			return finishMessageCommand(cmd, domain.MessageResult{MessageID: args[0], Outcome: "rejected", Evidence: domain.MessageEvidence{Code: "ACK_SESSION_MISMATCH", Signal: "none", RecordedAt: time.Now().UTC().Format(time.RFC3339Nano)}}, nil, asJSON)
		}
		if session == "" {
			session = environment
		}
		if session == "" {
			return usageError{errors.New("ack requires --session or AO_SESSION_ID")}
		}
		if err := c.checkMessageContract(cmd.Context()); err != nil {
			return err
		}
		var result domain.MessageResult
		err := c.postJSON(cmd.Context(), "sessions/"+url.PathEscape(session)+"/messages/"+url.PathEscape(args[0])+"/ack", struct{}{}, &result)
		return finishMessageCommand(cmd, result, err, asJSON, args[0])
	}}
	cmd.Flags().StringVar(&session, "session", "", "Target session (defaults to AO_SESSION_ID)")
	cmd.Flags().BoolVar(&asJSON, "json", false, "Print structured result")
	return cmd
}
func newMessageContractCommand(c *commandContext) *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{Use: "message-contract", Short: "Read native daemon message protocol capabilities", Args: noArgs, RunE: func(cmd *cobra.Command, _ []string) error {
		var contract domain.MessageContract
		if err := c.getJSON(cmd.Context(), "message-contract", &contract); err != nil {
			return err
		}
		if !validMessageContract(contract) {
			return errors.New("unsupported native message contract")
		}
		return writeJSON(cmd.OutOrStdout(), contract)
	}}
	cmd.Flags().BoolVar(&asJSON, "json", false, "Print capabilities as JSON")
	return cmd
}
func validMessageContract(contract domain.MessageContract) bool {
	expected := domain.NativeMessageContract()
	if contract.SchemaVersion != expected.SchemaVersion || contract.Authority != "native" || !contract.RequireAck || contract.DefaultAckTimeoutMS != 30000 || contract.MaxAckTimeoutMS != 60000 || contract.SendTimeoutMS != 90000 || len(contract.Outcomes) != 5 {
		return false
	}
	for i, outcome := range expected.Outcomes {
		if contract.Outcomes[i] != outcome {
			return false
		}
	}
	return true
}
func (c *commandContext) checkMessageContract(ctx context.Context) error {
	var contract domain.MessageContract
	if err := c.getJSON(ctx, "message-contract", &contract); err != nil {
		return err
	}
	if !validMessageContract(contract) {
		return errors.New("unsupported native message contract; no message injected")
	}
	return nil
}
func finishMessageCommand(cmd *cobra.Command, result domain.MessageResult, err error, asJSON bool, expectedID ...string) error {
	if err != nil {
		var response apiResponseError
		if errors.As(err, &response) && response.StatusCode == 400 {
			return usageError{err}
		}
		if !errors.As(err, &response) || len(response.Body) == 0 {
			return err
		}
		if json.Unmarshal(response.Body, &result) != nil || !validMessageResult(result) || messageResultHTTPStatus(result.Outcome) != response.StatusCode {
			return err
		}
	}
	if !validMessageResult(result) || (len(expectedID) > 0 && expectedID[0] != "" && result.MessageID != expectedID[0]) {
		return errors.New("invalid native message outcome or identity")
	}
	if asJSON {
		if err := writeJSON(cmd.OutOrStdout(), result); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(cmd.OutOrStdout(), "%s %s (%s)\n", result.MessageID, result.Outcome, result.Evidence.Code)
	}
	switch result.Outcome {
	case "submitted_confirmed", "acknowledged":
		return nil
	default:
		return messageOutcomeError{result}
	}
}
func validMessageResult(r domain.MessageResult) bool {
	if !domain.ValidMessageID(r.MessageID) || r.Evidence.Code == "" || r.Evidence.RecordedAt == "" || r.Evidence.Attempts < 0 {
		return false
	}
	switch r.Outcome {
	case "submitted_confirmed":
		return r.Evidence.Signal == "activity_active"
	case "acknowledged":
		return r.Evidence.Signal == "explicit_ack"
	case "submitted_unconfirmed", "rejected", "ack_timeout":
		return r.Evidence.Signal == "none" || r.Evidence.Signal == "activity_active"
	default:
		return false
	}
}

func messageResultHTTPStatus(outcome string) int {
	switch outcome {
	case "submitted_confirmed", "acknowledged":
		return 200
	case "submitted_unconfirmed":
		return 202
	case "rejected":
		return 409
	case "ack_timeout":
		return 504
	}
	return 0
}
