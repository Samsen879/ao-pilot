package cli

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPackagedVersionUsesSelectedPin(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"native", "release", "runtime"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	write := func(name string, data []byte) string {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
		return fmt.Sprintf("%x", sha256.Sum256(data))
	}
	exe := filepath.Join(root, "native", "ao")
	digest := write("native/ao", []byte("test binary"))
	write("runtime/agent-orchestrator.lock.json", []byte("archived historical lock"))
	commit, tree := strings.Repeat("a", 40), strings.Repeat("b", 40)
	pin := map[string]string{"schema_version": "ao.release-runtime-pin.v1", "release_id": "1+" + commit, "version": "1", "commit": commit, "tree": tree, "binary_sha256": digest}
	data, err := json.Marshal(pin)
	if err != nil {
		t.Fatal(err)
	}
	lock := map[string]string{"kind": "candidate", "sha256": write("release/runtime-pin.json", data), "binary_sha256": digest, "commit": commit, "tree": tree}
	manifest := map[string]any{"schema_version": "ao.release.v1", "release_id": pin["release_id"], "version": "1", "commit": commit, "tree": tree, "runtime_lock": lock}
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	write("release.json", data)
	id, err := identifyExecutable(exe, exe)
	if err != nil || id.Commit != commit || id.Tree != tree || id.BinarySHA256 != digest || id.ReleaseID != pin["release_id"] {
		t.Fatal(id, err)
	}
	write("release/runtime-pin.json", []byte("{}"))
	if _, err := identifyExecutable(exe, exe); err == nil {
		t.Fatal("accepted changed pin")
	}
	write("native/ao", []byte("different executable"))
	if _, err := identifyExecutable(exe, exe); err == nil {
		t.Fatal("accepted different binary")
	}
}
