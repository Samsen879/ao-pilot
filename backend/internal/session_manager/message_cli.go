package sessionmanager

import (
	"crypto/sha256"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const messageCLIErrorEnv = "AO_MESSAGE_CLI_ERROR"

func shellLiteral(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// prepareMessageCLI pins the prescribed ao-pilot ACK spelling to this daemon,
// session and namespace; it never edits a global bin directory or ambient CLI.
func (m *Manager) prepareMessageCLI(id domain.SessionID) (string, error) {
	executable, err := m.executable()
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(executable) || !filepath.IsAbs(m.dataDir) || !filepath.IsAbs(m.runFile) {
		return "", fmt.Errorf("message CLI requires absolute executable/data/discovery")
	}
	root := filepath.Join(m.dataDir, "message-cli")
	if err := privateMessageDirectory(root); err != nil {
		return "", err
	}
	helper, digest, err := retainMessageBinary(root, executable)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(helper + "\x00" + m.runFile + "\x00" + string(id)))
	dir := filepath.Join(root, fmt.Sprintf("%x", sum[:]))
	if err := privateMessageDirectory(dir); err != nil {
		return "", err
	}
	executable = helper
	script := "#!/bin/sh\nset -eu\nobserved=$(/usr/bin/sha256sum -- " + shellLiteral(helper) + ")\n[ \"${observed%% *}\" = " + shellLiteral(digest) + " ] || exit 126\nexport AO_DATA_DIR=" + shellLiteral(m.dataDir) + "\nexport AO_RUN_FILE=" + shellLiteral(m.runFile) + "\nexport AO_SESSION_ID=" + shellLiteral(string(id)) + "\nexec " + shellLiteral(executable) + " \"$@\"\n"
	target := filepath.Join(dir, "ao-pilot")
	if current, err := os.ReadFile(target); err == nil && string(current) == script {
		info, err := os.Lstat(target)
		if err == nil && info.Mode().IsRegular() && info.Mode().Perm() == 0700 {
			return dir, nil
		}
	}
	temporary, err := os.CreateTemp(dir, ".ao-pilot-")
	if err != nil {
		return "", err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err = temporary.Chmod(0700); err == nil {
		_, err = temporary.WriteString(script)
	}
	closeErr := temporary.Close()
	if err != nil {
		return "", err
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err := os.Rename(name, target); err != nil {
		return "", err
	}
	return dir, nil
}

func privateMessageDirectory(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("unsafe message CLI directory")
	}
	return nil
}

// Retained helpers are namespace state, independent of release GC. They are
// retained until the operator removes the retired namespace after all sessions.
func retainMessageBinary(root, source string) (string, string, error) {
	input, err := os.Open(source)
	if err != nil {
		return "", "", err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return "", "", fmt.Errorf("message CLI executable is not regular")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, input); err != nil {
		return "", "", err
	}
	digest := fmt.Sprintf("%x", hash.Sum(nil))
	bin := filepath.Join(root, "bin")
	if err := privateMessageDirectory(bin); err != nil {
		return "", "", err
	}
	dir := filepath.Join(bin, digest)
	if err := privateMessageDirectory(dir); err != nil {
		return "", "", err
	}
	target := filepath.Join(dir, "ao")
	if info, err := os.Lstat(target); err == nil {
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0700 {
			return "", "", fmt.Errorf("unsafe retained message CLI")
		}
		existing, err := os.Open(target)
		if err != nil {
			return "", "", err
		}
		h := sha256.New()
		_, err = io.Copy(h, existing)
		existing.Close()
		if err != nil {
			return "", "", err
		}
		if fmt.Sprintf("%x", h.Sum(nil)) != digest {
			return "", "", fmt.Errorf("retained message CLI digest mismatch")
		}
		return target, digest, nil
	} else if !os.IsNotExist(err) {
		return "", "", err
	}
	if _, err := input.Seek(0, io.SeekStart); err != nil {
		return "", "", err
	}
	temporary, err := os.CreateTemp(dir, ".ao-")
	if err != nil {
		return "", "", err
	}
	name := temporary.Name()
	defer os.Remove(name)
	h := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(temporary, h), input)
	if copyErr == nil {
		copyErr = temporary.Chmod(0700)
	}
	if copyErr == nil {
		copyErr = temporary.Sync()
	}
	closeErr := temporary.Close()
	if copyErr != nil {
		return "", "", copyErr
	}
	if closeErr != nil {
		return "", "", closeErr
	}
	if fmt.Sprintf("%x", h.Sum(nil)) != digest {
		return "", "", fmt.Errorf("source message CLI changed during copy")
	}
	if err := os.Rename(name, target); err != nil {
		return "", "", err
	}
	directory, err := os.Open(dir)
	if err != nil {
		return "", "", err
	}
	err = directory.Sync()
	directory.Close()
	return target, digest, err
}
