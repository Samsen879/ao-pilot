package tmux

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	DefaultSocket  = "ao-pilot"
	DefaultUnit    = "ao-pilot-tmux.service"
	MinimumVersion = "3.2"
)

var ErrServerAbsent = errors.New("managed tmux server absent")
var socketNamePattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$`)
var unitNamePattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.@-]*\.service$`)
var versionPattern = regexp.MustCompile(`^tmux ([0-9]+)\.([0-9]+)(?:[a-z0-9.-]*)$`)

type ServerDiagnostic struct {
	Status             string `json:"status"`
	Reason             string `json:"reason,omitempty"`
	Message            string `json:"message,omitempty"`
	ServerPID          int    `json:"server_pid"`
	ServerStartToken   string `json:"server_start_token"`
	Unit               string `json:"unit"`
	UnitMainPID        int    `json:"unit_main_pid"`
	UnitControlGroup   string `json:"unit_control_group"`
	ServerControlGroup string `json:"server_control_group"`
	DaemonControlGroup string `json:"daemon_control_group"`
	Absent             bool   `json:"-"`
}

// ServerController can be injected in tests; production always uses the managed
// implementation, including when Runtime Options are zero-valued.
type ServerController interface {
	Inspect(context.Context) ServerDiagnostic
	Ensure(context.Context) (ServerDiagnostic, error)
}

type ServerOptions struct {
	Binary, Socket, Unit, TmpDir string
	DaemonPID                    int
	Timeout                      time.Duration
	// Dependencies are injected together for cloud fixtures; no test needs a
	// real tmux server, systemd manager, or production proc filesystem.
	Command  func(context.Context, []string, string, ...string) ([]byte, error)
	ReadFile func(string) ([]byte, error)
	ProcRoot string
}

type ManagedServer struct {
	options   ServerOptions
	configErr error
	gate      chan struct{}
}

func ResolveServerOptions(options ServerOptions) ServerOptions {
	if options.Binary == "" {
		options.Binary = "tmux"
	}
	if options.Socket == "" {
		options.Socket = os.Getenv("AO_TMUX_SOCKET")
	}
	if options.Unit == "" {
		options.Unit = os.Getenv("AO_TMUX_UNIT")
	}
	if options.TmpDir == "" {
		options.TmpDir = os.Getenv("AO_TMUX_TMPDIR")
	}
	if options.DaemonPID == 0 {
		options.DaemonPID = os.Getpid()
	}
	if options.Timeout <= 0 {
		options.Timeout = 10 * time.Second
	}
	if options.Command == nil {
		options.Command = execRunner{}.Run
	}
	if options.ReadFile == nil {
		options.ReadFile = os.ReadFile
	}
	if options.ProcRoot == "" {
		options.ProcRoot = "/proc"
	}
	return options
}

func validateServerOptions(options ServerOptions) error {
	if options.Socket == "" || options.Unit == "" || options.TmpDir == "" {
		return fmt.Errorf("explicit AO_TMUX_SOCKET, AO_TMUX_UNIT and AO_TMUX_TMPDIR are required")
	}
	if !socketNamePattern.MatchString(options.Socket) || !unitNamePattern.MatchString(options.Unit) {
		return fmt.Errorf("invalid managed tmux socket or unit name")
	}
	if !filepath.IsAbs(options.TmpDir) || strings.ContainsAny(options.TmpDir, "\x00\r\n") {
		return fmt.Errorf("AO_TMUX_TMPDIR must be an absolute stable directory")
	}
	if options.DaemonPID <= 1 {
		return fmt.Errorf("daemon process identity unavailable")
	}
	return nil
}

func NewManagedServer(options ServerOptions) *ManagedServer {
	options = ResolveServerOptions(options)
	return &ManagedServer{options: options, configErr: validateServerOptions(options), gate: make(chan struct{}, 1)}
}

func (s *ManagedServer) Environment() []string {
	return []string{"TMUX_TMPDIR=" + s.options.TmpDir, "TMUX="}
}

// CheckVersion also rejects malformed/development output rather than treating
// an executable merely present in PATH as supporting -N/-D.
func CheckVersion(output string) error {
	matches := versionPattern.FindStringSubmatch(strings.TrimSpace(output))
	if len(matches) != 3 {
		return fmt.Errorf("unknown tmux version %q", strings.TrimSpace(output))
	}
	major, _ := strconv.Atoi(matches[1])
	minor, _ := strconv.Atoi(matches[2])
	if major < 3 || (major == 3 && minor < 2) {
		return fmt.Errorf("tmux >= %s required for managed foreground server and no-start clients", MinimumVersion)
	}
	return nil
}

func (s *ManagedServer) command(ctx context.Context, name string, args ...string) ([]byte, error) {
	callCtx, cancel := context.WithTimeout(ctx, s.options.Timeout)
	defer cancel()
	out, err := s.options.Command(callCtx, s.Environment(), name, args...)
	if callCtx.Err() != nil {
		return out, callCtx.Err()
	}
	return out, err
}

func (s *ManagedServer) serverPID(ctx context.Context) (int, bool, error) {
	// CMD_FIND_CANFAIL and CMD_CLIENT_CANFAIL in tmux >=3.2 permit this global
	// format even when the managed -D server has no sessions/clients.
	out, err := s.command(ctx, s.options.Binary, "-L", s.options.Socket, "-N", "display-message", "-p", "#{pid}")
	if err != nil {
		text := strings.ToLower(string(out))
		var exitErr interface{ ExitCode() int }
		absent := errors.As(err, &exitErr) && exitErr.ExitCode() == 1 && (strings.Contains(text, "no server running") || strings.Contains(text, "no such file or directory"))
		return 0, absent, err
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil || pid <= 1 {
		return 0, false, fmt.Errorf("invalid tmux server PID")
	}
	return pid, false, nil
}

type unitObservation struct {
	PID                 int
	Group, Active, Load string
}

func (s *ManagedServer) unit(ctx context.Context) (unitObservation, error) {
	out, err := s.command(ctx, "systemctl", "--user", "show", "--property=MainPID", "--property=ControlGroup", "--property=ActiveState", "--property=LoadState", "--", s.options.Unit)
	if err != nil {
		return unitObservation{}, err
	}
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			return unitObservation{}, fmt.Errorf("invalid systemd unit observation")
		}
		if _, exists := fields[key]; exists {
			return unitObservation{}, fmt.Errorf("duplicate systemd property")
		}
		fields[key] = value
	}
	pid, err := strconv.Atoi(fields["MainPID"])
	if err != nil || pid < 0 {
		return unitObservation{}, fmt.Errorf("invalid systemd MainPID")
	}
	return unitObservation{pid, fields["ControlGroup"], fields["ActiveState"], fields["LoadState"]}, nil
}

// ProcessStartToken parses Linux proc stat, including command names containing parentheses.
func ProcessStartToken(stat []byte) (string, error) {
	end := strings.LastIndexByte(string(stat), ')')
	if end < 0 {
		return "", fmt.Errorf("invalid proc stat")
	}
	fields := strings.Fields(string(stat[end+1:]))
	if len(fields) < 20 {
		return "", fmt.Errorf("incomplete proc stat")
	}
	token := fields[19]
	parsed, err := strconv.ParseUint(token, 10, 64)
	if err != nil || parsed == 0 {
		return "", fmt.Errorf("invalid process start token")
	}
	if fields[0] == "Z" || fields[0] == "X" {
		return "", fmt.Errorf("process has exited")
	}
	return token, nil
}
func (s *ManagedServer) token(pid int) (string, error) {
	stat, err := s.options.ReadFile(filepath.Join(s.options.ProcRoot, strconv.Itoa(pid), "stat"))
	if err != nil {
		return "", err
	}
	return ProcessStartToken(stat)
}
func (s *ManagedServer) groups(pid int) (map[string]string, error) {
	data, err := s.options.ReadFile(filepath.Join(s.options.ProcRoot, strconv.Itoa(pid), "cgroup"))
	if err != nil {
		return nil, err
	}
	return ParseCgroups(data)
}

// Inspect is entirely read-only. Violation is reported even for an old server
// outside the new unit, so doctor diagnoses the old dangerous configuration.
func (s *ManagedServer) Inspect(ctx context.Context) ServerDiagnostic {
	ctx, cancel := context.WithTimeout(ctx, s.options.Timeout)
	defer cancel()
	result := ServerDiagnostic{Status: "unknown", Reason: "tmux_identity_unknown", Unit: s.options.Unit}
	fail := func(err error) ServerDiagnostic { result.Message = err.Error(); return result }
	if s.configErr != nil {
		return fail(s.configErr)
	}
	if runtime.GOOS != "linux" {
		return fail(fmt.Errorf("managed runtime supports Linux (including WSL2) only"))
	}
	version, err := s.command(ctx, s.options.Binary, "-V")
	if err != nil {
		return fail(err)
	}
	if err := CheckVersion(string(version)); err != nil {
		return fail(err)
	}
	pid, absent, err := s.serverPID(ctx)
	result.ServerPID, result.Absent = pid, absent
	if err != nil {
		if absent {
			result.Reason = "tmux_unit_unavailable"
		}
		return fail(err)
	}
	start, err := s.token(pid)
	if err != nil {
		return fail(err)
	}
	result.ServerStartToken = start
	daemonStart, err := s.token(s.options.DaemonPID)
	if err != nil {
		return fail(err)
	}
	serverGroups, err := s.groups(pid)
	if err != nil {
		return fail(err)
	}
	daemonGroups, err := s.groups(s.options.DaemonPID)
	if err != nil {
		return fail(err)
	}
	result.ServerControlGroup, err = systemdCgroup(serverGroups)
	if err != nil {
		return fail(err)
	}
	result.DaemonControlGroup, err = systemdCgroup(daemonGroups)
	if err != nil {
		return fail(err)
	}
	independent, err := IndependentCgroups(serverGroups, daemonGroups)
	if err != nil {
		return fail(err)
	}
	unit, unitErr := s.unit(ctx)
	result.UnitMainPID, result.UnitControlGroup = unit.PID, unit.Group
	// Re-read identities after proc and systemd observations. Errors remain
	// unknown, never a definitive absent session or permission to start another.
	again, err := s.token(pid)
	if err != nil || again != start {
		return fail(fmt.Errorf("server identity changed during inspection"))
	}
	daemonAgain, err := s.token(s.options.DaemonPID)
	if err != nil || daemonAgain != daemonStart {
		return fail(fmt.Errorf("daemon identity changed during inspection"))
	}
	observed, _, err := s.serverPID(ctx)
	if err != nil || observed != pid {
		return fail(fmt.Errorf("socket server changed during inspection"))
	}
	if !independent {
		result.Status, result.Reason, result.Message = "violation", "tmux_cgroup_violation", "tmux server is inside daemon cgroup"
		return result
	}
	if unitErr != nil {
		return fail(unitErr)
	}
	if unit.Load != "loaded" || unit.Active != "active" || unit.PID != pid || unit.Group == "" || unit.Group != result.ServerControlGroup {
		return fail(fmt.Errorf("socket server does not match active managed unit MainPID/ControlGroup"))
	}
	unitAgain, err := s.unit(ctx)
	if err != nil || unitAgain != unit {
		return fail(fmt.Errorf("managed unit changed during inspection"))
	}
	serverAgain, err := s.groups(pid)
	if err != nil || !maps.Equal(serverAgain, serverGroups) {
		return fail(fmt.Errorf("server cgroup changed during inspection"))
	}
	daemonGroupsAgain, err := s.groups(s.options.DaemonPID)
	if err != nil || !maps.Equal(daemonGroupsAgain, daemonGroups) {
		return fail(fmt.Errorf("daemon cgroup changed during inspection"))
	}
	result.Status, result.Reason, result.Message = "ok", "", ""
	return result
}

// Ensure's only effect is starting the configured user unit for a definitively
// absent server. Unknown/violation never causes a bare tmux or default socket
// start, nor any migration/kill/restart of a running server.
func (s *ManagedServer) Ensure(ctx context.Context) (ServerDiagnostic, error) {
	ctx, cancel := context.WithTimeout(ctx, s.options.Timeout)
	defer cancel()
	select {
	case s.gate <- struct{}{}:
		defer func() { <-s.gate }()
	case <-ctx.Done():
		return ServerDiagnostic{Status: "unknown"}, ctx.Err()
	}
	result := s.Inspect(ctx)
	if ctx.Err() != nil {
		return result, ctx.Err()
	}
	if result.Status == "ok" {
		return result, nil
	}
	if !result.Absent {
		return result, fmt.Errorf("%s: %s", result.Reason, result.Message)
	}
	if _, err := s.command(ctx, "systemctl", "--user", "start", "--", s.options.Unit); err != nil {
		return result, fmt.Errorf("start managed tmux unit: %w", err)
	}
	for {
		result = s.Inspect(ctx)
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if result.Status == "ok" {
			return result, nil
		}
		if !result.Absent {
			return result, fmt.Errorf("%s: %s", result.Reason, result.Message)
		}
		select {
		case <-ctx.Done():
			return result, ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
