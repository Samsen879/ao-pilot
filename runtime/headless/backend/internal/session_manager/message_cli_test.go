package sessionmanager

import (
	"context"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkerPrescribedAckUsesRetainedBinaryAndNamespace(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "release with ' quote", "ao")
	if err := os.MkdirAll(filepath.Dir(source), 0700); err != nil {
		t.Fatal(err)
	}
	// Isolated executable fixture observes argv and namespace, never a real daemon.
	script := "#!/bin/sh\nprintf '%s\\n' \"$AO_DATA_DIR\" \"$AO_RUN_FILE\" \"$AO_SESSION_ID\" \"$1\" \"$2\"\n"
	if err := os.WriteFile(source, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(root, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	run := filepath.Join(root, "discovery", "running.json")
	m := New(Deps{DataDir: data, RunFile: run, Executable: func() (string, error) { return source, nil }})
	env := m.runtimeEnv("worker-1", "project", "", map[string]string{"AO_DATA_DIR": "/wrong", "AO_RUN_FILE": "/wrong", "AO_SESSION_ID": "other", "PATH": "/usr/bin:/bin"})
	if env[messageCLIErrorEnv] != "" {
		t.Fatal(env)
	}
	dir := strings.Split(env["PATH"], string(os.PathListSeparator))[0]
	if err := os.RemoveAll(filepath.Dir(source)); err != nil {
		t.Fatal(err)
	} // release GC must not break ACK
	cmd := exec.CommandContext(context.Background(), "/bin/sh", "-c", "ao-pilot ack message-id")
	cmd.Env = []string{"PATH=" + env["PATH"], "AO_DATA_DIR=/wrong", "AO_RUN_FILE=/wrong", "AO_SESSION_ID=other"}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	expected := data + "\n" + run + "\nworker-1\nack\nmessage-id\n"
	if string(output) != expected {
		t.Fatalf("got=%q want=%q", output, expected)
	}
	// Corrupt retained helper: existing worker fails closed before executing it.
	raw, err := os.ReadFile(filepath.Join(dir, "ao-pilot"))
	if err != nil {
		t.Fatal(err)
	}
	matches := strings.Split(string(raw), "sha256sum -- '")
	if len(matches) != 2 {
		t.Fatal(string(raw))
	}
	helper := strings.Split(matches[1], "'")[0]
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	cmd = exec.Command("/bin/sh", "-c", "ao-pilot ack message-id")
	cmd.Env = []string{"PATH=" + env["PATH"]}
	if err := cmd.Run(); err == nil {
		t.Fatal("corrupted helper executed successfully")
	}
}
func TestMessageCLINamespacesAndUnsafeDirectory(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "ao")
	os.WriteFile(source, []byte("#!/bin/sh\nexit 0\n"), 0700)
	for _, name := range []string{"one", "two"} {
		data := filepath.Join(root, name)
		os.Mkdir(data, 0700)
		m := New(Deps{DataDir: data, RunFile: filepath.Join(data, "run.json"), Executable: func() (string, error) { return source, nil }})
		dir, err := m.prepareMessageCLI(domain.SessionID(name))
		if err != nil || !strings.HasPrefix(dir, data) {
			t.Fatal(dir, err)
		}
	}
	data := filepath.Join(root, "unsafe")
	os.Mkdir(data, 0700)
	os.Symlink(root, filepath.Join(data, "message-cli"))
	m := New(Deps{DataDir: data, RunFile: filepath.Join(data, "run"), Executable: func() (string, error) { return source, nil }})
	if _, err := m.prepareMessageCLI("worker"); err == nil {
		t.Fatal("symlink helper directory accepted")
	}
}
