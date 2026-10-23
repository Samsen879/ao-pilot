package ownership

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Helpers only exercise lock custody in private temporary directories. They
// never call daemon.Run, open a store, bind a port or touch an existing service.
func TestOwnershipHelper(t *testing.T) {
	action := os.Getenv("AO_OWNERSHIP_HELPER")
	if action == "" {
		return
	}
	if action == "exit" {
		os.Exit(0)
	}
	if action == "child" {
		fmt.Println("CHILD", os.Getpid())
		_, _ = io.ReadAll(os.Stdin)
		os.Exit(0)
	}
	lease, err := Acquire(os.Getenv("AO_TEST_DATA"), os.Getenv("AO_TEST_RUN"))
	if err != nil {
		fmt.Println("DENIED", err)
		os.Exit(3)
	}
	if err := lease.RetainForProcess(); err != nil {
		panic(err)
	}
	if err := lease.Close(); err == nil {
		panic("retained lease released")
	}
	lease = nil
	runtime.GC() // The retained strong root must survive Run-like local return/GC.
	if action == "spawn-child" {
		child := exec.Command(os.Args[0], "-test.run=^TestOwnershipHelper$")
		child.Env = append(os.Environ(), "AO_OWNERSHIP_HELPER=child")
		child.Stdin = os.NewFile(3, "test-child-control")
		out, err := child.StdoutPipe()
		if err != nil {
			panic(err)
		}
		if err := child.Start(); err != nil {
			panic(err)
		}
		line, err := bufio.NewReader(out).ReadString('\n')
		if err != nil {
			panic(err)
		}
		fmt.Print(line)
		// Deliberately leave our test child alive. It must not inherit owner handles.
		os.Exit(0)
	}
	fmt.Println("READY")
	_, _ = io.ReadAll(os.Stdin)
	os.Exit(0)
}

type helper struct {
	cmd    *exec.Cmd
	input  io.WriteCloser
	lines  *bufio.Scanner
	waited bool
}

func startHelper(t *testing.T, action, data, run string) *helper {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^TestOwnershipHelper$")
	cmd.Env = append(os.Environ(), "AO_OWNERSHIP_HELPER="+action, "AO_TEST_DATA="+data, "AO_TEST_RUN="+run)
	// A separate control pipe keeps the grandchild alive after Cmd.Wait closes
	// the holder's ordinary stdin pipe. Only this test pipe is inherited.
	var childControlRead *os.File
	if action == "spawn-child" {
		var childControlWrite *os.File
		var err error
		childControlRead, childControlWrite, err = os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd.ExtraFiles = []*os.File{childControlRead}
		t.Cleanup(func() { _ = childControlWrite.Close(); _ = childControlRead.Close() })
	}
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	output, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if childControlRead != nil {
		_ = childControlRead.Close()
	}
	h := &helper{cmd: cmd, input: input, lines: bufio.NewScanner(output)}
	t.Cleanup(func() {
		_ = input.Close()
		if !h.waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	return h
}
func (h *helper) line(t *testing.T) string {
	t.Helper()
	done := make(chan string, 1)
	go func() {
		if h.lines.Scan() {
			done <- h.lines.Text()
		} else {
			done <- "EOF"
		}
	}()
	select {
	case line := <-done:
		return line
	case <-time.After(10 * time.Second):
		t.Fatal("helper handshake timed out")
		return ""
	}
}
func (h *helper) wait(t *testing.T) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- h.cmd.Wait() }()
	select {
	case err := <-done:
		h.waited = true
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper exit timed out")
	}
}
func paths(t *testing.T) (string, string) {
	root := t.TempDir()
	return filepath.Join(root, "data"), filepath.Join(root, "discovery", "running.json")
}

func TestProcessLifetimeBlocksContenderUntilExit(t *testing.T) {
	data, run := paths(t)
	holder := startHelper(t, "hold", data, run)
	if line := holder.line(t); line != "READY" {
		t.Fatal(line)
	}
	contender := startHelper(t, "hold", data, run)
	if line := contender.line(t); !strings.HasPrefix(line, "DENIED") {
		t.Fatal(line)
	}
	if _, err := Acquire(data, run); !errors.Is(err, ErrBusy) {
		t.Fatalf("got %v, want busy", err)
	}
	_ = holder.input.Close()
	holder.wait(t)
	lease, err := Acquire(data, run)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if _, err := os.Stat(filepath.Join(data, ".daemon-owner.lock")); err != nil {
		t.Fatal("lock file was removed", err)
	}
}
func TestCrashReleasesOnlyHelperOwner(t *testing.T) {
	data, run := paths(t)
	h := startHelper(t, "hold", data, run)
	if h.line(t) != "READY" {
		t.Fatal("not ready")
	}
	if err := h.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = h.cmd.Wait()
	h.waited = true
	lease, err := Acquire(data, run)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
}

func TestNamespacesAndDirectoryAliases(t *testing.T) {
	data, run := paths(t)
	first, err := Acquire(data, run)
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if _, err := Acquire(data, filepath.Join(t.TempDir(), "run.json")); !errors.Is(err, ErrBusy) {
		t.Fatalf("same data: %v", err)
	}
	other := t.TempDir()
	if _, err := Acquire(other, filepath.Join(filepath.Dir(run), "different.json")); !errors.Is(err, ErrBusy) {
		t.Fatalf("same discovery: %v", err)
	}
	independent, err := Acquire(other, filepath.Join(t.TempDir(), "run.json"))
	if err != nil {
		t.Fatal(err)
	}
	defer independent.Close()
	if runtime.GOOS != "windows" {
		alias := filepath.Join(t.TempDir(), "alias")
		if err := os.Symlink(data, alias); err != nil {
			t.Fatal(err)
		}
		if _, err := Acquire(alias, filepath.Join(t.TempDir(), "run.json")); !errors.Is(err, ErrBusy) {
			t.Fatalf("alias bypass: %v", err)
		}
	}
}

func TestReservedRunFileNameEquivalence(t *testing.T) {
	for _, tc := range []struct {
		name    string
		windows bool
		reject  bool
	}{
		{dataLockName, false, true}, {discoveryLockName, false, true},
		{".DAEMON-OWNER.LOCK", false, true}, {".Daemon-Discovery.Lock", true, true},
		{".daemon-owner.lock...  ", true, true}, {".DAEMON-DISCOVERY.LOCK. ", true, true},
		{".daemon-owner.lock:stream", true, true}, {"running.json:stream", true, true},
		{"running.json", false, false}, {"running.json", true, false},
	} {
		err := validateRunFileName(tc.name, tc.windows)
		if errors.Is(err, ErrReservedRunFile) != tc.reject {
			t.Fatalf("name=%q windows=%v err=%v", tc.name, tc.windows, err)
		}
	}
}

func TestReservedRunFileRejectedBeforeDirectoryCreation(t *testing.T) {
	for _, name := range []string{dataLockName, discoveryLockName} {
		root := t.TempDir()
		data := filepath.Join(root, "not-created-data")
		run := filepath.Join(root, "not-created-discovery", name)
		if lease, err := Acquire(data, run); lease != nil || !errors.Is(err, ErrReservedRunFile) {
			t.Fatalf("lease=%v err=%v", lease, err)
		}
		entries, err := os.ReadDir(root)
		if err != nil || len(entries) != 0 {
			t.Fatalf("admission created files: %v %v", entries, err)
		}
	}
}
