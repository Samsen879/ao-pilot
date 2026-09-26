package lifecycle_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/lifecycle"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionservice "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
)

// Only lifecycle uses this wrapper; user setters use the same real database
// directly. The barrier is after the durable read, before any reducer write.
type readBarrierStore struct {
	*sqlite.Store
	once          sync.Once
	read, release chan struct{}
}

func (s *readBarrierStore) GetSession(ctx context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	rec, ok, err := s.Store.GetSession(ctx, id)
	s.once.Do(func() {
		close(s.read)
		select {
		case <-s.release:
		case <-ctx.Done():
			err = ctx.Err()
		}
	})
	return rec, ok, err
}

func TestLifecyclePreservesConcurrentUserSettings(t *testing.T) {
	for _, operation := range []string{"observation", "activity", "metadata", "spawn", "terminate", "manual-submit", "stale-generation"} {
		for _, userFirst := range []bool{false, true} {
			order := "lifecycle-first"
			if userFirst {
				order = "user-before-stale-write"
			}
			t.Run(operation+"/"+order, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				root := t.TempDir()
				s, err := sqlite.Open(root)
				if err != nil {
					t.Fatal(err)
				}
				defer s.Close()
				if err := s.UpsertProject(ctx, domain.ProjectRecord{ID: "fixture", Path: root}); err != nil {
					t.Fatal(err)
				}
				rec, err := s.CreateSession(ctx, domain.SessionRecord{ProjectID: "fixture", Kind: domain.KindWorker,
					Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: time.Now()},
					Metadata: domain.SessionMetadata{RuntimeLaunchID: "launch", RuntimeHandleID: "handle", PreviewURL: "http://old", PreviewRevision: 7}})
				if err != nil {
					t.Fatal(err)
				}
				if err := s.SetPaneDraftOwned(ctx, rec.ID, "draft"); err != nil {
					t.Fatal(err)
				}
				if err := s.MarkPaneDraftComplete(ctx, rec.ID, "draft"); err != nil {
					t.Fatal(err)
				}
				barrier := &readBarrierStore{Store: s, read: make(chan struct{}), release: make(chan struct{})}
				var release sync.Once
				unblock := func() { release.Do(func() { close(barrier.release) }) }
				defer unblock()
				if !userFirst {
					unblock()
				}
				m := lifecycle.New(barrier, nil)
				done := make(chan error, 1)
				go func() {
					var err error
					switch operation {
					case "observation":
						err = m.ApplyRuntimeObservation(ctx, rec.ID, ports.RuntimeFacts{Runtime: ports.ProbeAlive, Workload: ports.ProbeDead, LaunchID: "launch"})
					case "activity":
						err = m.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, LaunchID: "launch"})
					case "metadata":
						err = m.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{AgentSessionID: "new-agent", LaunchID: "launch"})
					case "spawn":
						err = m.MarkSpawned(ctx, rec.ID, domain.SessionMetadata{RuntimeHandleID: "new-handle", RuntimeLaunchID: "new-launch"})
					case "terminate":
						err = m.MarkTerminated(ctx, rec.ID)
					case "manual-submit":
						err = m.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, Event: "user-prompt-submit", HookObservedAt: time.Now(), LaunchID: "launch"})
					case "stale-generation":
						err = m.ApplyActivitySignal(ctx, rec.ID, ports.ActivitySignal{Valid: true, State: domain.ActivityActive, LaunchID: "old-launch"})
					}
					done <- err
				}()
				awaitDone := func() {
					t.Helper()
					select {
					case err := <-done:
						if err != nil {
							t.Fatal(err)
						}
					case <-ctx.Done():
						t.Fatal("lifecycle did not finish")
					}
				}
				if userFirst {
					select {
					case <-barrier.read:
					case <-ctx.Done():
						t.Fatal("missing read barrier")
					}
				} else {
					awaitDone()
				}
				user := sessionservice.New(nil, s)
				if err := user.Rename(ctx, rec.ID, "New name"); err != nil {
					t.Fatal(err)
				}
				if _, err := user.SetPreview(ctx, rec.ID, "http://localhost:3000"); err != nil {
					t.Fatal(err)
				}
				seq, err := s.LatestSeq(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := user.SetPreview(ctx, rec.ID, "http://localhost:3000"); err != nil {
					t.Fatal(err)
				}
				nextSeq, err := s.LatestSeq(ctx)
				if err != nil || nextSeq <= seq {
					t.Fatalf("same URL did not publish CDC: %d -> %d, %v", seq, nextSeq, err)
				}
				if _, err := user.SetTerminateOnPRMerge(ctx, rec.ID, true); err != nil {
					t.Fatal(err)
				}
				if userFirst {
					unblock()
					awaitDone()
				}
				got, ok, err := s.GetSession(ctx, rec.ID)
				if err != nil || !ok {
					t.Fatalf("read: %v %v", ok, err)
				}
				if got.DisplayName != "New name" || got.Metadata.PreviewURL != "http://localhost:3000" || got.Metadata.PreviewRevision != 9 || !got.TerminateOnPRMerge {
					t.Fatalf("lost user fields: %+v", got)
				}
				switch operation {
				case "observation":
					if got.Activity.State != domain.ActivityExited {
						t.Fatal("observation lost")
					}
				case "activity", "manual-submit":
					if got.Activity.State != domain.ActivityActive {
						t.Fatal("activity lost")
					}
				case "metadata":
					if got.Metadata.AgentSessionID != "new-agent" {
						t.Fatal("agent metadata lost")
					}
				case "spawn":
					if got.Metadata.RuntimeLaunchID != "new-launch" || got.Metadata.RuntimeHandleID != "new-handle" {
						t.Fatal("launch lost")
					}
				case "terminate":
					if !got.IsTerminated {
						t.Fatal("termination lost")
					}
				case "stale-generation":
					if got.Activity.State != domain.ActivityIdle {
						t.Fatal("stale launch was admitted")
					}
				}
				pending, _, _, generation, err := s.PaneDraftReceipt(ctx, rec.ID)
				if err != nil || generation != 0 || pending != (operation != "manual-submit") {
					t.Fatalf("pane receipt changed incorrectly: pending=%v generation=%d err=%v", pending, generation, err)
				}
			})
		}
	}
}
