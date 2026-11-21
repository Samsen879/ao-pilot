package cli

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/spf13/cobra"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

func processBirth(dir string) (string, error) {
	data, err := os.ReadFile(filepath.Join(dir, "stat"))
	if err != nil {
		return "", err
	}
	i := strings.LastIndexByte(string(data), ')')
	fields := strings.Fields(string(data)[i+1:])
	if i < 0 || len(fields) < 20 || fields[0] == "Z" {
		return "", fmt.Errorf("live process identity unavailable")
	}
	return fields[19], nil
}
func startedEvidence(pid int, session, id string) (domain.TaskCheckpoint, error) {
	var e domain.TaskCheckpoint
	dir := filepath.Join("/proc", strconv.Itoa(pid))
	before, err := processBirth(dir)
	if err != nil {
		return e, err
	}
	data, err := os.ReadFile(filepath.Join(dir, "environ"))
	if err != nil {
		return e, err
	}
	values := bytes.Split(data, []byte{0})
	has := func(want string) bool {
		for _, v := range values {
			if string(v) == want {
				return true
			}
		}
		return false
	}
	if !has("AO_MESSAGE_ID="+id) || !has("AO_SESSION_ID="+session) {
		return e, fmt.Errorf("process must belong to this message and session")
	}
	exe, err := os.Readlink(filepath.Join(dir, "exe"))
	if err != nil {
		return e, err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return e, err
	}
	after, err := processBirth(dir)
	if err != nil || before != after {
		return e, fmt.Errorf("process identity changed")
	}
	digest := sha256.Sum256([]byte(fmt.Sprintf("%s/%s/%d/%s/%s/%s", boot, before, pid, exe, session, id)))
	return domain.TaskCheckpoint{Kind: "started", Detail: filepath.Base(exe), Digest: fmt.Sprintf("%x", digest)}, nil
}
func artifactEvidence(file string) (domain.TaskCheckpoint, error) {
	var e domain.TaskCheckpoint
	st, err := os.Stat(file)
	if err != nil {
		return e, err
	}
	if !st.Mode().IsRegular() {
		return e, fmt.Errorf("expected a regular artifact file")
	}
	f, err := os.OpenFile(file, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return e, err
	}
	defer f.Close()
	initial, err := f.Stat()
	if err != nil || !initial.Mode().IsRegular() || !os.SameFile(st, initial) {
		return e, fmt.Errorf("artifact changed before reading")
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return e, err
	}
	end, err := os.Stat(file)
	if err != nil || !os.SameFile(end, initial) || end.ModTime() != initial.ModTime() || n != end.Size() || n != initial.Size() {
		return e, fmt.Errorf("artifact changed while hashing")
	}
	return domain.TaskCheckpoint{Kind: "artifact", Detail: filepath.Base(file), Digest: fmt.Sprintf("%x", h.Sum(nil))}, nil
}
func newCheckpointCommand(c *commandContext) *cobra.Command {
	var pid int
	var artifact, reason string
	cmd := &cobra.Command{Use: "checkpoint MESSAGE_ID", Short: "Record worker evidence for an acknowledged dispatch", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		id := args[0]
		session := os.Getenv("AO_SESSION_ID")
		if !domain.ValidMessageID(id) || !sessionIDPattern.MatchString(session) {
			return fmt.Errorf("valid message ID and bound AO_SESSION_ID required")
		}
		var e domain.TaskCheckpoint
		var err error
		switch {
		case pid > 0:
			e, err = startedEvidence(pid, session, id)
		case artifact != "":
			e, err = artifactEvidence(artifact)
		default:
			e = domain.TaskCheckpoint{Kind: "blocked", Detail: reason}
		}
		if err != nil {
			return err
		}
		if !e.Valid() {
			return fmt.Errorf("invalid checkpoint")
		}
		var out struct {
			Recorded bool `json:"recorded"`
		}
		if err = c.postJSON(cmd.Context(), "sessions/"+url.PathEscape(session)+"/messages/"+url.PathEscape(id)+"/checkpoint", e, &out); err != nil {
			return err
		}
		if !out.Recorded {
			return fmt.Errorf("checkpoint unconfirmed")
		}
		return writeJSON(cmd.OutOrStdout(), out)
	}}
	cmd.Flags().IntVar(&pid, "started-pid", 0, "Observe a live process tagged with AO_MESSAGE_ID and AO_SESSION_ID")
	cmd.Flags().StringVar(&artifact, "artifact", "", "Hash a produced file and record its basename")
	cmd.Flags().StringVar(&reason, "blocked", "", "Record the current blocker")
	cmd.MarkFlagsOneRequired("started-pid", "artifact", "blocked")
	cmd.MarkFlagsMutuallyExclusive("started-pid", "artifact", "blocked")
	return cmd
}
func newProjectPauseCommand(c *commandContext, paused bool) *cobra.Command {
	name := "pause"
	if !paused {
		name = "resume"
	}
	return &cobra.Command{Use: name + " PROJECT", Short: name + " native project dispatch and launch", Args: cobra.ExactArgs(1), RunE: func(cmd *cobra.Command, args []string) error {
		var out struct {
			Recorded bool `json:"recorded"`
		}
		err := c.postJSON(cmd.Context(), "projects/"+url.PathEscape(args[0])+"/pause", map[string]bool{"paused": paused}, &out)
		if err != nil {
			return err
		}
		if !out.Recorded {
			return fmt.Errorf("project pause state unconfirmed")
		}
		return writeJSON(cmd.OutOrStdout(), out)
	}}
}
