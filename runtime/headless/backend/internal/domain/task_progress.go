package domain

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"unicode"
)

var ErrProjectPaused = errors.New("project paused by operator")
var ErrCheckpointConflict = errors.New("checkpoint requires an acknowledged task in this session")
var ErrMissingProject = errors.New("unknown project")
var evidenceDigest = regexp.MustCompile("^[0-9a-f]{64}$")

type TaskCheckpoint struct {
	Kind   string `json:"kind" enum:"started,artifact,blocked"`
	Detail string `json:"detail" maxLength:"256"`
	Digest string `json:"sha256,omitempty"`
}

func (e TaskCheckpoint) Valid() bool {
	if strings.TrimSpace(e.Detail) == "" || len(e.Detail) > 256 || strings.IndexFunc(e.Detail, unicode.IsControl) >= 0 {
		return false
	}
	switch e.Kind {
	case "started", "artifact":
		return evidenceDigest.MatchString(e.Digest)
	case "blocked":
		return e.Digest == ""
	}
	return false
}

type TaskObservation struct {
	Project        string `json:"project"`
	Session        string `json:"session"`
	MessageID      string `json:"message_id"`
	Sent           string `json:"sent_at"`
	Outcome        string `json:"outcome"`
	Ack            string `json:"ack_at,omitempty"`
	Started        string `json:"started_at,omitempty"`
	FirstCommand   string `json:"first_command,omitempty"`
	Artifact       string `json:"artifact,omitempty"`
	ArtifactDigest string `json:"artifact_sha256,omitempty"`
	ArtifactAt     string `json:"artifact_at,omitempty"`
	Latest         string `json:"latest,omitempty"`
	Detail         string `json:"detail,omitempty"`
	Digest         string `json:"sha256,omitempty"`
	Updated        string `json:"updated_at,omitempty"`
}
type TaskOverview struct {
	Tasks  []TaskObservation `json:"tasks"`
	Paused []string          `json:"paused_projects"`
}

type ProjectAdmission interface {
	AdmitProject(context.Context, ProjectID) (release func(), err error)
}

// Acquire across the external effect. Lightweight stores used by offline callers
// without pause support retain their existing behavior.
func AdmitProject(ctx context.Context, store any, id ProjectID) (func(), error) {
	if admission, ok := store.(ProjectAdmission); ok {
		return admission.AdmitProject(ctx, id)
	}
	return func() {}, nil
}
