//go:build linux

package ownership

import (
	"golang.org/x/sys/unix"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestConfirmedZombieIsDeadBeforeParentReaps(t *testing.T) {
	cmd := exec.Command(os.Args[0], "-test.run=^TestOwnershipHelper$")
	cmd.Env = append(os.Environ(), "AO_OWNERSHIP_HELPER=exit")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer cmd.Wait()
	defer cmd.Process.Kill()
	done := make(chan error, 1)
	go func() {
		var info unix.Siginfo
		done <- unix.Waitid(unix.P_PID, cmd.Process.Pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper did not exit")
	}
	alive, err := ProcessAlive(cmd.Process.Pid)
	if err != nil || alive {
		t.Fatalf("zombie alive=%v err=%v", alive, err)
	}
}

func TestProcessProbeErrorIsUnknown(t *testing.T) {
	// No inherited tooling or service is executed when ps is unavailable.
	t.Setenv("PATH", t.TempDir())
	if alive, err := ProcessAlive(os.Getpid()); err == nil || alive {
		t.Fatalf("missing ps became confirmed dead: alive=%v err=%v", alive, err)
	}
}
