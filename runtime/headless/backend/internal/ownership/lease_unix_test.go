//go:build !windows

package ownership

import (
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
