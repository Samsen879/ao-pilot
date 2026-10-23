package controllers

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
)

type MessageIDParam struct {
	MessageID string `path:"messageId"`
}
type AckMessageRequest struct{}
type messageService interface {
	SendMessage(context.Context, domain.SessionID, domain.MessageOptions) (domain.MessageResult, error)
	AckMessage(context.Context, domain.SessionID, string) (domain.MessageResult, error)
}

func writeMessageResult(w http.ResponseWriter, result domain.MessageResult) {
	status := http.StatusOK
	switch result.Outcome {
	case "submitted_unconfirmed":
		status = 202
	case "rejected":
		status = 409
	case "ack_timeout":
		status = 504
	case "submitted_confirmed", "acknowledged":
	default:
		status = 500
	}
	envelope.WriteJSON(w, status, result)
}
func (c *SessionsController) SendMessage(w http.ResponseWriter, r *http.Request) {
	svc, ok := c.Svc.(messageService)
	if !ok {
		envelope.WriteAPIError(w, r, 503, "unavailable", "MESSAGE_CUSTODY_UNAVAILABLE", "message custody unavailable", nil)
		return
	}
	var input SendSessionMessageRequest
	if err := decodeMessageJSON(w, r, &input); err != nil {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := svc.SendMessage(r.Context(), sessionID(r), input)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	writeMessageResult(w, result)
}
func (c *SessionsController) AckMessage(w http.ResponseWriter, r *http.Request) {
	svc, ok := c.Svc.(messageService)
	if !ok {
		envelope.WriteAPIError(w, r, 503, "unavailable", "MESSAGE_CUSTODY_UNAVAILABLE", "message custody unavailable", nil)
		return
	}
	var input AckMessageRequest
	if err := decodeMessageJSON(w, r, &input); err != nil {
		envelope.WriteAPIError(w, r, 400, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	result, err := svc.AckMessage(r.Context(), sessionID(r), chi.URLParam(r, "messageId"))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	writeMessageResult(w, result)
}

func decodeMessageJSON(w http.ResponseWriter, r *http.Request, out any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 65536))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("expected exactly one JSON object")
	}
	return nil
}
