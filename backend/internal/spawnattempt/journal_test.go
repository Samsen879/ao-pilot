package spawnattempt

import (
	"github.com/google/uuid"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestExclusiveReservationAndSubstitution(t *testing.T) {
	root := t.TempDir()
	id := uuid.NewString()
	fp, _ := Fingerprint("fixture")
	var wg sync.WaitGroup
	var mu sync.Mutex
	owners := 0
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			a, _, _ := Reserve(root, id, fp, "fixture")
			if a != nil {
				mu.Lock()
				owners++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if owners != 1 {
		t.Fatalf("owners=%d", owners)
	}
	if _, _, err := Reserve(root, id, fp+"changed", "fixture"); err == nil {
		t.Fatal("substitution accepted")
	}
	rec, err := Read(root, id)
	if err != nil || rec.Outcome != "running" {
		t.Fatal("record not durable")
	}
}
func TestUnreadableOrSymlinkCustodyHolds(t *testing.T) {
	root := t.TempDir()
	id := uuid.NewString()
	fp, _ := Fingerprint("fixture")
	a, _, err := Reserve(root, id, fp, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(a.directory, "record.json"), []byte("{truncated"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Reserve(root, id, fp, "fixture"); err == nil {
		t.Fatal("unreadable accepted")
	}
	other := t.TempDir()
	id = uuid.NewString()
	if err := os.Symlink(other, filepath.Join(root, "spawn-attempts", id)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Reserve(root, id, fp, "fixture"); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestDiagnosisDoesNotCreateStorage(t *testing.T) {
	root := filepath.Join(t.TempDir(), "missing")
	if _, err := Read(root, uuid.NewString()); err == nil {
		t.Fatal("missing read")
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("read created storage")
	}
}

func TestSymlinkAncestorRejectedBeforeCreation(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(target, alias); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Reserve(filepath.Join(alias, "new"), uuid.NewString(), "a", "fixture"); err == nil {
		t.Fatal("ancestor accepted")
	}
	if _, err := os.Stat(filepath.Join(target, "new")); !os.IsNotExist(err) {
		t.Fatal("created through symlink")
	}
}
