// This program is an explicitly invoked LOCAL STAGING effect test. It is never
// called by cloud/unit tests or installation, and rejects production namespaces.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"golang.org/x/sys/unix"
)

type settings struct {
	root, namespace, binary, canary string
	timeout                         time.Duration
	execute                         bool
}
type sessionIdentity struct {
	Terminated                   bool
	Launch, Handle, Conversation string
}
type snapshot struct {
	DaemonPID    int
	DaemonToken  string
	Server       tmux.ServerDiagnostic
	TmuxSessions []string
	Sessions     map[domain.SessionID]sessionIdentity
	Counts       []uint64
}

var namespacePattern = regexp.MustCompile(`^ao-pilot-staging-[a-zA-Z0-9][a-zA-Z0-9-]{0,48}$`)
var counterPattern = regexp.MustCompile(`canary:([0-9]+)`)

func main() {
	var options settings
	flag.StringVar(&options.root, "staging-root", "", "canonical isolated staging installation/data root")
	flag.StringVar(&options.namespace, "namespace", "", "ao-pilot-staging-<unique-id>; marker must match")
	flag.StringVar(&options.binary, "native-binary", "", "native binary beneath staging root (default current/native/ao)")
	flag.StringVar(&options.canary, "canary-cid", "", "existing staging AO CID running a canary:<n> counter")
	flag.DurationVar(&options.timeout, "timeout", 30*time.Second, "per-phase budget, at most 2m")
	flag.BoolVar(&options.execute, "execute-staging", false, "explicitly permit restart, stop/start and pidfd SIGKILL of staging daemon")
	flag.Parse()
	if err := options.validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := options.run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func (s *settings) validate() error {
	if !s.execute {
		return errors.New("requires --execute-staging; never run against production")
	}
	if !namespacePattern.MatchString(s.namespace) || s.canary == "" || s.timeout <= 0 || s.timeout > 2*time.Minute {
		return errors.New("staging namespace, canary CID and bounded timeout required")
	}
	if !filepath.IsAbs(s.root) || strings.ContainsAny(s.root, " \t\r\n") {
		return errors.New("staging root must be absolute without whitespace")
	}
	root, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return err
	}
	s.root = root
	home, _ := os.UserHomeDir()
	if root == "/" || root == home {
		return errors.New("unsafe staging root")
	}
	marker, err := os.ReadFile(filepath.Join(root, ".ao-pilot-staging"))
	if err != nil || strings.TrimSpace(string(marker)) != s.namespace {
		return errors.New("staging marker missing or wrong namespace")
	}
	if s.binary == "" {
		s.binary = filepath.Join(root, "current/native/ao")
	}
	actual, err := filepath.EvalSymlinks(s.binary)
	if err != nil || !beneath(root, actual) {
		return errors.New("native binary escapes staging root")
	}
	for _, child := range []string{"data", "discovery", "tmux", "home"} {
		actual, err := filepath.EvalSymlinks(filepath.Join(root, child))
		if err != nil || !beneath(root, actual) {
			return fmt.Errorf("staging %s must exist and remain isolated", child)
		}
	}
	return nil
}
func beneath(root, path string) bool {
	rel, err := filepath.Rel(root, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func (s settings) unit() string     { return s.namespace + "-runtime.service" }
func (s settings) tmuxUnit() string { return s.namespace + "-tmux.service" }
func (s settings) env() []string {
	return append(os.Environ(), "HOME="+filepath.Join(s.root, "home"), "AO_DATA_DIR="+filepath.Join(s.root, "data"), "AO_RUN_FILE="+filepath.Join(s.root, "discovery/running.json"), "AO_TMUX_SOCKET="+s.namespace, "AO_TMUX_UNIT="+s.tmuxUnit(), "AO_TMUX_TMPDIR="+filepath.Join(s.root, "tmux"), "TMUX_TMPDIR="+filepath.Join(s.root, "tmux"), "TMUX=", "AO_CONFIG_PATH="+filepath.Join(s.root, "ao.config.json"), "GH_TOKEN=", "GITHUB_TOKEN=")
}
func (s settings) command(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = s.env()
	return cmd.CombinedOutput()
}
func properties(output []byte) map[string]string {
	values := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[key] = value
		}
	}
	return values
}
func (s settings) daemonIdentity(ctx context.Context) (int, string, error) {
	out, err := s.command(ctx, "systemctl", "--user", "show", "--property=MainPID", "--property=ControlGroup", "--property=ExecStart", "--property=Environment", "--property=EnvironmentFiles", "--property=ActiveState", "--", s.unit())
	if err != nil {
		return 0, "", err
	}
	unit := properties(out)
	pid, err := strconv.Atoi(unit["MainPID"])
	if err != nil || pid <= 1 || unit["ActiveState"] != "active" || !strings.HasSuffix(unit["ControlGroup"], "/"+s.unit()) {
		return 0, "", errors.New("staging daemon unit identity unavailable")
	}
	if !strings.Contains(unit["ExecStart"], "path="+s.binary+" ;") || unit["EnvironmentFiles"] != "" {
		return 0, "", errors.New("effective staging ExecStart must be the selected native binary, with explicit Environment and no external EnvironmentFiles")
	}
	expected := map[string]string{"AO_DATA_DIR": filepath.Join(s.root, "data"), "AO_RUN_FILE": filepath.Join(s.root, "discovery/running.json"), "AO_TMUX_SOCKET": s.namespace, "AO_TMUX_UNIT": s.tmuxUnit(), "AO_TMUX_TMPDIR": filepath.Join(s.root, "tmux")}
	effective := map[string]string{}
	for _, entry := range strings.Fields(unit["Environment"]) {
		key, value, ok := strings.Cut(strings.Trim(entry, "\""), "=")
		if ok {
			effective[key] = value
		}
	}
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/environ", pid))
	if err != nil {
		return 0, "", err
	}
	processEnv := map[string]string{}
	for _, entry := range strings.Split(string(raw), "\x00") {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			processEnv[key] = value
		}
	}
	for key, value := range expected {
		if effective[key] != value || processEnv[key] != value {
			return 0, "", fmt.Errorf("staging environment %s mismatch; refusing effects", key)
		}
	}
	exe, err := os.Readlink(fmt.Sprintf("/proc/%d/exe", pid))
	if err != nil || !beneath(s.root, exe) {
		return 0, "", errors.New("running daemon executable escapes staging installation")
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, "", err
	}
	token, err := tmux.ProcessStartToken(stat)
	return pid, token, err
}
func (s settings) take(ctx context.Context) (snapshot, error) {
	result := snapshot{}
	pid, token, err := s.daemonIdentity(ctx)
	if err != nil {
		return result, err
	}
	result.DaemonPID, result.DaemonToken = pid, token
	inspector := tmux.NewManagedServer(tmux.ServerOptions{Socket: s.namespace, Unit: s.tmuxUnit(), TmpDir: filepath.Join(s.root, "tmux"), DaemonPID: pid})
	result.Server = inspector.Inspect(ctx)
	if result.Server.Status != "ok" {
		return result, fmt.Errorf("staging tmux diagnostic: %+v", result.Server)
	}
	output, err := s.command(ctx, "tmux", "-L", s.namespace, "-N", "list-sessions", "-F", "#{session_name}:#{session_id}")
	if err != nil {
		return result, err
	}
	result.TmuxSessions = strings.Split(strings.TrimSpace(string(output)), "\n")
	sort.Strings(result.TmuxSessions)
	store, err := sqlite.OpenReadOnly(ctx, filepath.Join(s.root, "data"))
	if err != nil {
		return result, err
	}
	defer store.Close()
	records, err := store.ListAllSessions(ctx)
	if err != nil {
		return result, err
	}
	result.Sessions = map[domain.SessionID]sessionIdentity{}
	for _, rec := range records {
		if !rec.IsTerminated && (rec.Metadata.RuntimeLaunchID == "" || rec.Metadata.RuntimeHandleID == "") {
			return result, errors.New("live staging session lacks launch identity needed to prove no restore")
		}
		result.Sessions[rec.ID] = sessionIdentity{rec.IsTerminated, rec.Metadata.RuntimeLaunchID, rec.Metadata.RuntimeHandleID, rec.Metadata.AgentSessionID}
	}
	canary, ok := result.Sessions[domain.SessionID(s.canary)]
	if !ok || canary.Terminated {
		return result, errors.New("canary is not an existing live staging session")
	}
	output, err = s.command(ctx, "tmux", "-L", s.namespace, "-N", "capture-pane", "-p", "-S", "-2000", "-t", "="+tmux.SessionName(s.canary))
	if err != nil {
		return result, err
	}
	result.Counts, err = parseCounts(string(output))
	if err != nil {
		return result, err
	}
	return result, nil
}
func parseCounts(output string) ([]uint64, error) {
	counts := []uint64{}
	for _, match := range counterPattern.FindAllStringSubmatch(output, -1) {
		value, err := strconv.ParseUint(match[1], 10, 64)
		if err != nil {
			return nil, err
		}
		counts = append(counts, value)
	}
	if len(counts) < 2 {
		return nil, errors.New("canary PTY output needs at least two counters")
	}
	for i := 1; i < len(counts); i++ {
		if counts[i] != counts[i-1]+1 {
			return nil, errors.New("canary counter reset or gap in retained PTY output")
		}
	}
	return counts, nil
}
func compare(before, after snapshot) error {
	if before.Server.ServerPID != after.Server.ServerPID || before.Server.ServerStartToken != after.Server.ServerStartToken {
		return errors.New("tmux server identity changed")
	}
	if !reflect.DeepEqual(before.TmuxSessions, after.TmuxSessions) {
		return errors.New("tmux session list changed")
	}
	if !reflect.DeepEqual(before.Sessions, after.Sessions) {
		return errors.New("session CID/termination/runtime/native conversation changed: restore or unexpected mutation")
	}
	last := before.Counts[len(before.Counts)-1]
	found := false
	for _, count := range after.Counts {
		if count == last {
			found = true
		}
	}
	if !found || after.Counts[len(after.Counts)-1] <= last {
		return errors.New("canary has no continuous progress across daemon restart")
	}
	return nil
}
func (s settings) killDaemon(before snapshot) error {
	fd, err := unix.PidfdOpen(before.DaemonPID, 0)
	if err != nil {
		return fmt.Errorf("pidfd required for identity-bound staging SIGKILL: %w", err)
	}
	defer unix.Close(fd)
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", before.DaemonPID))
	if err != nil {
		return err
	}
	token, err := tmux.ProcessStartToken(raw)
	if err != nil || token != before.DaemonToken {
		return errors.New("daemon changed before signal")
	}
	return unix.PidfdSendSignal(fd, unix.SIGKILL, nil, 0)
}
func (s settings) wait(ctx context.Context, before snapshot) (snapshot, error) {
	var last error
	for {
		out, err := s.command(ctx, s.binary, "status", "--json")
		var status struct {
			State string `json:"state"`
		}
		if err == nil && json.Unmarshal(out, &status) == nil && status.State == "ready" {
			after, err := s.take(ctx)
			if err == nil {
				if after.DaemonPID == before.DaemonPID && after.DaemonToken == before.DaemonToken {
					last = errors.New("daemon has not restarted")
				} else if err = compare(before, after); err == nil {
					return after, nil
				} else {
					last = err
				}
			} else {
				last = err
			}
		} else {
			last = fmt.Errorf("staging daemon not ready: %s", out)
		}
		select {
		case <-ctx.Done():
			return snapshot{}, fmt.Errorf("staging observation failed: %v: %w", last, ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (s settings) run() error {
	for _, action := range []string{"restart", "stop_start", "kill_9"} {
		ctx, cancel := context.WithTimeout(context.Background(), s.timeout)
		before, err := s.take(ctx)
		if err != nil {
			cancel()
			return err
		}
		switch action {
		case "restart":
			_, err = s.command(ctx, "systemctl", "--user", "restart", "--", s.unit())
		case "stop_start":
			if _, err = s.command(ctx, "systemctl", "--user", "stop", "--", s.unit()); err == nil {
				_, err = s.command(ctx, "systemctl", "--user", "start", "--", s.unit())
			}
		case "kill_9":
			err = s.killDaemon(before)
		}
		if err != nil {
			cancel()
			return fmt.Errorf("%s: %w", action, err)
		}
		after, err := s.wait(ctx, before)
		if err != nil {
			cancel()
			return fmt.Errorf("%s: %w", action, err)
		}
		// Doctor may report unrelated fake-agent prereqs; this check specifically
		// requires the shared cgroup diagnostic to be PASS with its full details.
		raw, _ := s.command(ctx, s.binary, "doctor", "--json")
		var doctor struct {
			Checks []struct {
				Name, Level string
				Details     tmux.ServerDiagnostic
			}
		}
		if json.Unmarshal(raw, &doctor) != nil {
			cancel()
			return errors.New("doctor did not return JSON")
		}
		found := false
		for _, check := range doctor.Checks {
			if check.Name == "tmux_cgroup" {
				found = check.Level == "PASS" && check.Details.Status == "ok"
			}
		}
		if !found {
			cancel()
			return errors.New("doctor tmux_cgroup did not PASS")
		}
		cancel()
		if err := json.NewEncoder(os.Stdout).Encode(struct {
			Action        string `json:"action"`
			Result        string `json:"result"`
			Before, After snapshot
		}{action, "PASS", before, after}); err != nil {
			return err
		}
	}
	return nil
}
