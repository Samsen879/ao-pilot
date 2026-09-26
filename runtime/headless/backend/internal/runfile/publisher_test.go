package runfile

import (
	"errors"
	"github.com/aoagents/agent-orchestrator/backend/internal/ownership"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func fixturePaths(t *testing.T) (string, string) {
	root := t.TempDir()
	return filepath.Join(root, "data"), filepath.Join(root, "discovery", "running.json")
}
func dead(int) (bool, error) { return false, nil }
func TestAdmissionHoldsLegacyAliveAndUnknown(t *testing.T) {
	for _, probe := range []ProcessProbe{func(int) (bool, error) { return true, nil }, func(int) (bool, error) { return false, errors.New("probe unavailable") }} {
		data, path := fixturePaths(t)
		want := Info{PID: 42, Port: 3001, StartedAt: time.Unix(123, 0).UTC()}
		if err := write(path, want); err != nil {
			t.Fatal(err)
		}
		if _, err := Admit(data, path, probe); !errors.Is(err, ErrOwnerAlive) {
			t.Fatalf("got %v", err)
		}
		got, err := Read(path)
		if err != nil || got == nil || got.PID != want.PID {
			t.Fatalf("record changed: %v %v", got, err)
		}
		// Failed admission closes short leases; confirmed-dead recovery still works.
		publisher, err := Admit(data, path, dead)
		if err != nil {
			t.Fatal(err)
		}
		if err := publisher.Close(); err != nil {
			t.Fatal(err)
		}
	}
}
func TestPublisherRepairAndNoncePreservation(t *testing.T) {
	data, path := fixturePaths(t)
	p, err := Admit(data, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer p.Close()
	info := Info{PID: 42, Port: 3001}
	if err := p.Publish(info); err != nil {
		t.Fatal(err)
	}
	got, err := Read(path)
	if err != nil || got.InstanceID != p.InstanceID() || got.DataDir != p.DataDir() {
		t.Fatalf("identity=%+v err=%v", got, err)
	}
	if err := remove(path); err != nil {
		t.Fatal(err)
	}
	if restored, err := p.Restore(info); !restored || err != nil {
		t.Fatalf("restore=%v err=%v", restored, err)
	}
	foreign := *got
	foreign.InstanceID = "another-launch-same-pid"
	if err := write(path, foreign); err != nil {
		t.Fatal(err)
	}
	if restored, err := p.Restore(info); restored || err != nil {
		t.Fatalf("foreign restore=%v %v", restored, err)
	}
	if err := p.Remove(); !errors.Is(err, ErrSuccessor) {
		t.Fatalf("removed foreign launch: %v", err)
	}
	if err := p.Publish(info); !errors.Is(err, ErrSuccessor) {
		t.Fatalf("overwrote foreign launch: %v", err)
	}
	final, _ := Read(path)
	if final.InstanceID != foreign.InstanceID {
		t.Fatal("foreign launch changed")
	}
}
func TestCleanupSerializesWithPublisherAndPreservesSuccessor(t *testing.T) {
	data, path := fixturePaths(t)
	a, err := Admit(data, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.Publish(Info{PID: 42}); err != nil {
		t.Fatal(err)
	}
	expected, _ := Read(path)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() { done <- a.lease.Do(func() error { close(entered); <-release; return nil }) }()
	<-entered
	// An independent caller cannot enter the delete critical section.
	if err := CleanupStopped(data, path, expected, dead); !errors.Is(err, ownership.ErrBusy) {
		t.Fatalf("cleanup raced owner: %v", err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if err := a.Close(); err != nil {
		t.Fatal(err)
	}
	b, err := Admit(data, path, dead)
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Publish(Info{PID: 42}); err != nil {
		t.Fatal(err)
	}
	successor, _ := Read(path)
	if err := b.Close(); err != nil {
		t.Fatal(err)
	}
	if err := CleanupStopped(data, path, expected, dead); !errors.Is(err, ErrSuccessor) {
		t.Fatalf("old cleanup: %v", err)
	}
	got, _ := Read(path)
	if got.InstanceID != successor.InstanceID {
		t.Fatal("successor lost")
	}
	if err := CleanupStopped(data, path, successor, dead); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("dead matching record not removed", err)
	}
}
func TestMissingRecordDoesNotProveStopped(t *testing.T) {
	data, path := fixturePaths(t)
	p, err := Admit(data, path, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := CleanupStopped(data, path, nil, dead); !errors.Is(err, ownership.ErrBusy) {
		t.Fatalf("missing record bypass: %v", err)
	}
	if err := p.Close(); err != nil {
		t.Fatal(err)
	}
	if err := CleanupStopped(data, path, nil, dead); err != nil {
		t.Fatal(err)
	}
}
