package reaper

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type partialSource []domain.SessionRecord

func (s partialSource) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return s, nil
}

type partialRuntime struct{}

func (partialRuntime) IsAlive(_ context.Context, h ports.RuntimeHandle) (bool, error) {
	if h.ID == "unknown" {
		return false, errors.New("runtime unknown")
	}
	return true, nil
}

type partialSink struct{ observed []domain.SessionID }

func (s *partialSink) ApplyRuntimeObservation(_ context.Context, id domain.SessionID, f ports.RuntimeFacts) error {
	s.observed = append(s.observed, id)
	if id == "first" {
		if f.Runtime != ports.ProbeFailed {
			panic("unknown collapsed to dead")
		}
		return errors.New("reduction failed")
	}
	return nil
}
func TestTickAggregatesPartialFailuresAndContinues(t *testing.T) {
	source := partialSource{{ID: "first", Metadata: domain.SessionMetadata{RuntimeHandleID: "unknown"}}, {ID: "second", Metadata: domain.SessionMetadata{RuntimeHandleID: "alive"}}}
	sink := &partialSink{}
	err := New(sink, source, partialRuntime{}, Config{}).Tick(context.Background())
	if err == nil || len(sink.observed) != 2 || sink.observed[1] != "second" {
		t.Fatalf("partial failure lost or stopped pass: %v %+v", err, sink.observed)
	}
}
