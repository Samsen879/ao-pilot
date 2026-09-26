package runfile

import (
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestRestoreIfMissingRecreatesHandshake(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	want := Info{PID: 42, Port: 3001, StartedAt: time.Unix(123, 0).UTC()}

	restored, err := restoreIfMissing(path, want)
	if err != nil {
		t.Fatalf("restoreIfMissing() error = %v", err)
	}
	if !restored {
		t.Fatal("restoreIfMissing() restored = false, want true")
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got == nil || got.PID != want.PID || got.Port != want.Port || !got.StartedAt.Equal(want.StartedAt) {
		t.Fatalf("restored info = %#v, want %#v", got, want)
	}
}

func TestRestoreIfMissingConcurrentPublishKeepsOneOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	const writers = 16
	start := make(chan struct{})
	results := make(chan bool, writers)
	errs := make(chan error, writers)
	var wait sync.WaitGroup
	for i := 1; i <= writers; i++ {
		wait.Add(1)
		go func(pid int) {
			defer wait.Done()
			<-start
			restored, err := restoreIfMissing(path, Info{PID: pid, Port: 3000 + pid})
			results <- restored
			errs <- err
		}(i)
	}
	close(start)
	wait.Wait()
	close(results)
	close(errs)

	winners := 0
	for restored := range results {
		if restored {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("successful restores = %d, want 1", winners)
	}
	for err := range errs {
		if err != nil {
			t.Fatalf("restoreIfMissing() error = %v", err)
		}
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got == nil || got.PID < 1 || got.PID > writers || got.Port != 3000+got.PID {
		t.Fatalf("restored info = %#v", got)
	}
}

func TestRestoreIfMissingPreservesExistingOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "running.json")
	existing := Info{PID: 99, Port: 4001, StartedAt: time.Unix(456, 0).UTC()}
	if err := write(path, existing); err != nil {
		t.Fatalf("write() error = %v", err)
	}

	restored, err := restoreIfMissing(path, Info{PID: 42, Port: 3001})
	if err != nil {
		t.Fatalf("restoreIfMissing() error = %v", err)
	}
	if restored {
		t.Fatal("restoreIfMissing() restored = true, want false")
	}
	got, err := Read(path)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	if got == nil || got.PID != existing.PID || got.Port != existing.Port {
		t.Fatalf("existing info = %#v, want %#v", got, existing)
	}
}
