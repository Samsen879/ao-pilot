package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/spf13/cobra"
)

const messageWatchMaximum = 15 * time.Minute

func newMessageCommand(c *commandContext) *cobra.Command {
	cmd := &cobra.Command{Use: "message", Short: "Inspect message custody without resubmitting a task"}
	for _, watch := range []bool{false, true} {
		watch := watch
		name, description := "show", "Read the current durable message state"
		if watch {
			name, description = "watch", "Observe current state until explicit ACK, rejection or timeout"
		}
		var session string
		var asJSON bool
		var timeout time.Duration
		child := &cobra.Command{Use: name + " <message-id>", Short: description,
			Args: func(_ *cobra.Command, args []string) error {
				if len(args) != 1 || !domain.ValidMessageID(args[0]) {
					return usageError{errors.New("one safe message ID is required")}
				}
				return nil
			},
			RunE: func(cmd *cobra.Command, args []string) error {
				if strings.TrimSpace(session) == "" {
					return usageError{errors.New("--session is required")}
				}
				if watch && (timeout <= 0 || timeout > messageWatchMaximum) {
					return usageError{errors.New("--timeout must be >0 and <=15m")}
				}
				if err := c.checkMessageStatusContract(cmd.Context()); err != nil {
					return err
				}
				if !watch {
					status, err := c.readMessageStatus(cmd.Context(), session, args[0])
					if err != nil {
						return err
					}
					return printMessageStatus(cmd, status, asJSON)
				}
				return c.watchMessageStatus(cmd, session, args[0], asJSON, timeout, 500*time.Millisecond)
			},
		}
		child.Flags().StringVar(&session, "session", "", "Exact original native session ID (required)")
		child.Flags().BoolVar(&asJSON, "json", false, "Print JSON (watch emits one snapshot per line)")
		if watch {
			child.Flags().DurationVar(&timeout, "timeout", 30*time.Second, "Bound observation without replaying (maximum 15m)")
		}
		cmd.AddCommand(child)
	}
	return cmd
}

func (c *commandContext) checkMessageStatusContract(ctx context.Context) error {
	var contract domain.MessageContract
	if err := c.getJSON(ctx, "message-contract", &contract); err != nil {
		return err
	}
	if !validMessageContract(contract) || !contract.ReadStatus || contract.StatusSchemaVersion != domain.MessageStatusVersion {
		return errors.New("message status inspection is unsupported; no message was resubmitted")
	}
	return nil
}

func (c *commandContext) readMessageStatus(ctx context.Context, session, messageID string) (domain.MessageStatus, error) {
	var status domain.MessageStatus
	err := c.getJSON(ctx, "sessions/"+url.PathEscape(session)+"/messages/"+url.PathEscape(messageID), &status)
	if err != nil {
		return status, err
	}
	if status.SchemaVersion != domain.MessageStatusVersion || string(status.SessionID) != session || status.MessageID != messageID ||
		status.Version < 0 || status.CreatedAt == "" || !validMessageResult(status.MessageResult) ||
		(status.Phase != "reserved" && status.Phase != "started" && status.Phase != "final") ||
		(status.Outcome == "acknowledged" && !status.RequireAck) {
		return domain.MessageStatus{}, errors.New("invalid native message status or identity")
	}
	return status, nil
}

func printMessageStatus(cmd *cobra.Command, status domain.MessageStatus, asJSON bool) error {
	if asJSON {
		return json.NewEncoder(cmd.OutOrStdout()).Encode(status)
	}
	_, err := fmt.Fprintf(cmd.OutOrStdout(), "%s %s (%s) session=%s phase=%s version=%d; custody only, task execution not established\n",
		status.MessageID, status.Outcome, status.Evidence.Code, status.SessionID, status.Phase, status.Version)
	return err
}

func (c *commandContext) watchMessageStatus(cmd *cobra.Command, session, messageID string, asJSON bool, timeout, interval time.Duration) error {
	ctx, cancel := context.WithTimeout(cmd.Context(), timeout)
	defer cancel()
	var lastVersion int64 = -1
	var last domain.MessageStatus
	for {
		if err := ctx.Err(); err != nil {
			return fmt.Errorf("MESSAGE_WATCH_ENDED: %w; no message was resubmitted", err)
		}
		status, err := c.readMessageStatus(ctx, session, messageID)
		if err != nil {
			return err
		}
		if status.Version < lastVersion {
			return errors.New("native message status version regressed")
		}
		if status.Version == lastVersion && status != last {
			return errors.New("native message status changed without a version advance")
		}
		if status.Version != lastVersion {
			if err := printMessageStatus(cmd, status, asJSON); err != nil {
				return err
			}
			lastVersion = status.Version
			last = status
		}
		if status.Outcome == "acknowledged" || status.Outcome == "rejected" || (!status.RequireAck && status.Phase == "final") {
			return nil
		}
		// An ACK timeout is not terminal: a later explicit ACK may still arrive.
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("MESSAGE_WATCH_ENDED: %w; no message was resubmitted", ctx.Err())
		case <-timer.C:
		}
	}
}
