//go:build !windows

package ownership

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestRunfileSymlinkRejectedAndPartialAcquisitionReleased(t *testing.T) {
	data, run := paths(t)
	if err := os.MkdirAll(filepath.Dir(run), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(t.TempDir(), "target"), run); err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(data, run); err == nil {
		t.Fatal("accepted runfile symlink")
	}
	if err := os.Remove(run); err != nil {
		t.Fatal(err)
	}
	lease, err := Acquire(data, run)
	if err != nil {
		t.Fatal("leaked partial lease", err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Do(func() error { t.Fatal("executed closed lease"); return nil }); err == nil {
		t.Fatal("accepted closed lease")
	}
}

func TestChildDoesNotInheritOwnerHandles(t *testing.T) {
	data, run := paths(t)
	h := startHelper(t, "spawn-child", data, run)
	line := h.line(t)
	fields := strings.Fields(line)
	if len(fields) != 2 || fields[0] != "CHILD" {
		t.Fatal(line)
	}
	pid, err := strconv.Atoi(fields[1])
	if err != nil {
		t.Fatal(err)
	}
	child, err := os.FindProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.input.Close(); _ = child.Kill() })
	h.wait(t)
	if alive, err := ProcessAlive(pid); err != nil || !alive {
		t.Fatalf("test child exited too early: alive=%v err=%v", alive, err)
	}
	lease, err := Acquire(data, run)
	if err != nil {
		t.Fatalf("child inherited owner lease: %v", err)
	}
	defer lease.Close()
}

func TestExistingRunFileAliasCannotNameLockObject(t *testing.T) {
	for _, lockName := range []string{dataLockName, discoveryLockName} {
		root := t.TempDir()
		lockPath := filepath.Join(root, lockName)
		run := filepath.Join(root, "alias.json")
		original := []byte("existing record bytes")
		if err := os.WriteFile(lockPath, original, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(lockPath, run); err != nil {
			t.Fatal(err)
		}
		before, err := os.Stat(lockPath)
		if err != nil {
			t.Fatal(err)
		}
		if lease, err := Acquire(root, run); lease != nil || !errors.Is(err, ErrReservedRunFile) {
			t.Fatalf("lease=%v err=%v", lease, err)
		}
		after, err := os.Stat(lockPath)
		if err != nil || !os.SameFile(before, after) {
			t.Fatalf("lock identity changed: %v", err)
		}
		got, err := os.ReadFile(run)
		if err != nil || !bytes.Equal(got, original) {
			t.Fatalf("record changed: %q %v", got, err)
		}
	}
}
