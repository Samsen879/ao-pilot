package runfile

import (
	"path/filepath"
	"testing"
	"time"
)

func TestRestoreIfMissingRecreatesHandshake(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	want := Info{PID: 42, Port: 3001, StartedAt: time.Unix(123, 0).UTC()}

	restored, err := RestoreIfMissing(path, want)
	if err != nil {
		t.Fatalf("RestoreIfMissing() error = %v", err)
	}
	if !restored {
		t.Fatal("RestoreIfMissing() restored = false, want true")
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got == nil || got.PID != want.PID || got.Port != want.Port || !got.StartedAt.Equal(want.StartedAt) {
		t.Fatalf("restored info = %#v, want %#v", got, want)
	}
}

func TestRestoreIfMissingPreservesExistingOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	existing := Info{PID: 99, Port: 4001, StartedAt: time.Unix(456, 0).UTC()}
	if err := Write(path, existing); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	restored, err := RestoreIfMissing(path, Info{PID: 42, Port: 3001})
	if err != nil {
		t.Fatalf("RestoreIfMissing() error = %v", err)
	}
	if restored {
		t.Fatal("RestoreIfMissing() restored = true, want false")
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got == nil || got.PID != existing.PID || got.Port != existing.Port {
		t.Fatalf("existing info = %#v, want %#v", got, existing)
	}
}
