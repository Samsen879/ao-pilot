package tmux

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type healthyTestServer struct{}

func (healthyTestServer) Inspect(context.Context) ServerDiagnostic {
	return ServerDiagnostic{Status: "ok", ServerPID: 111, ServerStartToken: "1000"}
}
func (h healthyTestServer) Ensure(ctx context.Context) (ServerDiagnostic, error) {
	return h.Inspect(ctx), nil
}

type diagnosticTestServer struct{ diagnostic ServerDiagnostic }

func (s diagnosticTestServer) Inspect(context.Context) ServerDiagnostic { return s.diagnostic }
func (s diagnosticTestServer) Ensure(context.Context) (ServerDiagnostic, error) {
	if s.diagnostic.Status == "ok" {
		return s.diagnostic, nil
	}
	return s.diagnostic, errors.New("managed prerequisite failed")
}

type fixtureExit struct{}

func (fixtureExit) Error() string { return "exit status 1" }
func (fixtureExit) ExitCode() int { return 1 }

type serverFixture struct {
	mu          sync.Mutex
	absent      bool
	starts      int
	calls       []string
	files       map[string][]byte
	tokenReads  int
	changeToken bool
	unitPID     int
	unitGroup   string
	unitErr     bool
	startErr    bool
	version     string
}

func fixtureStat(token string) []byte {
	return []byte("111 (tmux: server (fixture)) S " + strings.Repeat("0 ", 18) + token + " 0\n")
}
func newServerFixture() *serverFixture {
	return &serverFixture{unitPID: 111, unitGroup: "/user/ao-tmux.service", version: "tmux 3.5a", files: map[string][]byte{
		"/proc/111/stat": fixtureStat("1000"), "/proc/222/stat": fixtureStat("2000"),
		"/proc/111/cgroup": []byte("0::/user/ao-tmux.service\n"), "/proc/222/cgroup": []byte("0::/user/ao-runtime.service\n"),
	}}
}
func (f *serverFixture) options() ServerOptions {
	return ServerOptions{Binary: "tmux", Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux", DaemonPID: 222, Command: f.command, ReadFile: f.readFile, Timeout: time.Second}
}
func (f *serverFixture) command(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	if !reflect.DeepEqual(env, []string{"TMUX_TMPDIR=/staging/tmux", "TMUX="}) {
		return nil, fmt.Errorf("wrong tmux namespace environment: %q", env)
	}
	if name == "tmux" {
		if reflect.DeepEqual(args, []string{"-V"}) {
			return []byte(f.version), nil
		}
		if !reflect.DeepEqual(args, []string{"-L", "ao-staging-test", "-N", "display-message", "-p", "#{pid}"}) {
			return nil, fmt.Errorf("unscoped or unexpected tmux command: %v", args)
		}
		if f.absent {
			return []byte("no server running on /staging/tmux/tmux-1000/ao-staging-test"), fixtureExit{}
		}
		return []byte("111\n"), nil
	}
	if name != "systemctl" {
		return nil, fmt.Errorf("unexpected process %s", name)
	}
	if reflect.DeepEqual(args, []string{"--user", "start", "--", "ao-staging-tmux.service"}) {
		f.starts++
		if f.startErr {
			return nil, errors.New("unit not found")
		}
		f.absent = false
		return nil, nil
	}
	if f.unitErr {
		return nil, errors.New("unit unavailable")
	}
	return []byte(fmt.Sprintf("MainPID=%d\nControlGroup=%s\nActiveState=active\nLoadState=loaded\n", f.unitPID, f.unitGroup)), nil
}
func (f *serverFixture) readFile(name string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if name == "/proc/111/stat" {
		f.tokenReads++
		if f.changeToken && f.tokenReads > 1 {
			return fixtureStat("1001"), nil
		}
	}
	data, ok := f.files[name]
	if !ok {
		return nil, os.ErrNotExist
	}
	return data, nil
}

func TestEnsureManagedServerBranches(t *testing.T) {
	for _, kind := range []string{"exists", "absent", "daemon_cgroup", "unit_missing", "pid_mismatch", "identity_changes", "old_version"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newServerFixture()
			switch kind {
			case "absent":
				fixture.absent = true
			case "daemon_cgroup":
				fixture.files["/proc/111/cgroup"] = fixture.files["/proc/222/cgroup"]
			case "unit_missing":
				fixture.absent = true
				fixture.startErr = true
			case "pid_mismatch":
				fixture.unitPID = 333
			case "identity_changes":
				fixture.changeToken = true
			case "old_version":
				fixture.version = "tmux 3.1c"
			}
			result, err := NewManagedServer(fixture.options()).Ensure(context.Background())
			success := kind == "exists" || kind == "absent"
			if (err == nil) != success {
				t.Fatalf("kind=%s diagnostic=%+v err=%v", kind, result, err)
			}
			if kind == "daemon_cgroup" && result.Status != "violation" {
				t.Fatalf("violation hidden: %+v", result)
			}
			wantStarts := 0
			if kind == "absent" || kind == "unit_missing" {
				wantStarts = 1
			}
			if fixture.starts != wantStarts {
				t.Fatalf("unexpected start effect: %v", fixture.calls)
			}
			for _, call := range fixture.calls {
				if strings.Contains(call, "new-session") || strings.Contains(call, "start-server") || strings.Contains(call, " -D") {
					t.Fatal("unmanaged start", call)
				}
			}
		})
	}
}

func TestInspectEmptyServerIsReadOnly(t *testing.T) {
	fixture := newServerFixture()
	result := NewManagedServer(fixture.options()).Inspect(context.Background())
	if result.Status != "ok" || fixture.starts != 0 || result.ServerPID != 111 || result.ServerStartToken != "1000" {
		t.Fatalf("%+v calls=%v", result, fixture.calls)
	}
	for _, call := range fixture.calls {
		if strings.Contains(call, "list-sessions") || strings.Contains(call, "new-session") {
			t.Fatalf("empty server probe depended on sessions: %s", call)
		}
	}
	fixture = newServerFixture()
	fixture.absent = true
	if result = NewManagedServer(fixture.options()).Inspect(context.Background()); !result.Absent || fixture.starts != 0 {
		t.Fatalf("inspection started server: %+v", result)
	}
}

func TestManagedServerRejectsInvalidNamespaceWithoutEffects(t *testing.T) {
	for _, change := range []func(*ServerOptions){func(o *ServerOptions) { o.Socket = "default/socket" }, func(o *ServerOptions) { o.Unit = "--all" }, func(o *ServerOptions) { o.TmpDir = "relative" }} {
		fixture := newServerFixture()
		options := fixture.options()
		change(&options)
		if _, err := NewManagedServer(options).Ensure(context.Background()); err == nil || len(fixture.calls) != 0 {
			t.Fatalf("invalid configuration had effects: %v", fixture.calls)
		}
	}
}

func TestManagedServerCancellationAndTimeout(t *testing.T) {
	fixture := newServerFixture()
	options := fixture.options()
	options.Timeout = 10 * time.Millisecond
	options.Command = func(ctx context.Context, _ []string, _ string, _ ...string) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if _, err := NewManagedServer(options).Ensure(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("timeout ignored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewManagedServer(fixture.options()).Ensure(ctx); err == nil {
		t.Fatal("cancelled ensure succeeded")
	}
	if len(fixture.calls) != 0 {
		t.Fatal("cancelled operation ran commands")
	}
}

func TestCgroupFixturesAndBoundary(t *testing.T) {
	for _, kind := range []string{"v1", "v2"} {
		t.Run(kind, func(t *testing.T) {
			read := func(which string) map[string]string {
				data, err := os.ReadFile(filepath.Join("testdata", kind+"-"+which+".cgroup"))
				if err != nil {
					t.Fatal(err)
				}
				groups, err := ParseCgroups(data)
				if err != nil {
					t.Fatal(err)
				}
				return groups
			}
			server, daemon := read("tmux"), read("daemon")
			if ok, err := IndependentCgroups(server, daemon); err != nil || !ok {
				t.Fatalf("independent groups rejected: %v", err)
			}
			child := map[string]string{}
			boundary := map[string]string{}
			for key, path := range daemon {
				child[key] = path + "/child"
				boundary[key] = path + "-other"
			}
			if ok, _ := IndependentCgroups(child, daemon); ok {
				t.Fatal("descendant accepted")
			}
			if ok, err := IndependentCgroups(boundary, daemon); err != nil || !ok {
				t.Fatal("path prefix mistaken for ancestor")
			}
		})
	}
	for _, data := range []string{"", "broken", "0::relative", "0::/x\n0::/y", "bad:cpu:/x", "0::/x/../y"} {
		if _, err := ParseCgroups([]byte(data)); err == nil {
			t.Fatalf("malformed cgroups accepted: %q", data)
		}
	}
	if _, err := IndependentCgroups(map[string]string{"v2": "/server"}, map[string]string{"v1:cpu": "/daemon"}); err == nil {
		t.Fatal("unknown hierarchies accepted")
	}
}

func TestClientsUseNamedSocketAndNoImplicitStart(t *testing.T) {
	runtime := New(Options{Binary: "tmux", Shell: "/bin/sh", Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux", Server: healthyTestServer{}})
	recorder := &recordingRunner{}
	runtime.runner = recorder
	for _, args := range [][]string{{"new-session", "-d", "-s", "test"}, {"has-session", "-t", "test"}, {"capture-pane", "-p", "-t", "test"}, {"kill-session", "-t", "test"}} {
		if _, err := runtime.run(context.Background(), args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, call := range recorder.calls {
		if !strings.HasPrefix(call, "-L ao-staging-test -N ") {
			t.Fatalf("implicit-start client: %q", call)
		}
	}
	attached := false
	runtime.attachSpawn = func(_ context.Context, argv, env []string, _, _ uint16) (ports.Stream, error) {
		attached = true
		if !reflect.DeepEqual(argv[:4], []string{"tmux", "-L", "ao-staging-test", "-N"}) {
			t.Fatalf("attach bypass: %v", argv)
		}
		if !strings.Contains(strings.Join(env, "\n"), "TMUX_TMPDIR=/staging/tmux") {
			t.Fatal("attach wrong namespace")
		}
		return nil, nil
	}
	if _, err := runtime.Attach(context.Background(), ports.RuntimeHandle{ID: "session-a"}, 24, 80); err != nil || !attached {
		t.Fatalf("attach %v", err)
	}
}

func TestAbsentAndUnknownServerDoNotCreateOrMisclassifySessions(t *testing.T) {
	for _, status := range []string{"absent", "unknown", "violation"} {
		t.Run(status, func(t *testing.T) {
			diagnostic := ServerDiagnostic{Status: status, ServerPID: 111, ServerStartToken: "1000"}
			if status == "absent" {
				diagnostic.Status = "unknown"
				diagnostic.Absent = true
			}
			runtime := New(Options{Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux", Server: diagnosticTestServer{diagnostic}})
			recorder := &sessionListRunner{output: "session-a\n"}
			runtime.runner = recorder
			alive, err := runtime.IsAlive(context.Background(), ports.RuntimeHandle{ID: "session-a"})
			if status == "absent" {
				if alive || err != nil {
					t.Fatalf("absence not definitive: %v %v", alive, err)
				}
				if err := runtime.Destroy(context.Background(), ports.RuntimeHandle{ID: "session-a"}); err != nil {
					t.Fatal(err)
				}
			}
			if status == "unknown" && err == nil {
				t.Fatal("unknown identity collapsed to dead")
			}
			if status == "violation" && (!alive || err != nil) {
				t.Fatal("diagnostic readonly probe unavailable")
			}
			for _, call := range recorder.calls {
				if strings.Contains(call, "new-session") || strings.Contains(call, "start-server") {
					t.Fatal("readonly started server")
				}
			}
		})
	}
}

type disappearRunner struct {
	calls    [][]string
	implicit bool
}

func (r *disappearRunner) Run(_ context.Context, _ []string, _ string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, append([]string(nil), args...))
	if !slices.Contains(args, "-N") {
		r.implicit = true
	}
	return []byte("no server running on staging socket"), fixtureExit{}
}
func TestServerDisappearingAfterEnsureCannotImplicitlyRestart(t *testing.T) {
	runtime := New(Options{Server: healthyTestServer{}, Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux"})
	runner := &disappearRunner{}
	runtime.runner = runner
	if _, err := runtime.run(context.Background(), "new-session", "-d", "-s", "test"); err == nil {
		t.Fatal("disappeared server reported success")
	}
	if runner.implicit || len(runner.calls) != 1 {
		t.Fatalf("implicit restart or retry: %+v", runner)
	}
}
func TestUnknownOrViolationDestroyHasNoReapEffects(t *testing.T) {
	for _, status := range []string{"unknown", "violation"} {
		runtime := New(Options{Socket: "ao-staging-test", Unit: "ao-staging-tmux.service", TmpDir: "/staging/tmux", Server: diagnosticTestServer{ServerDiagnostic{Status: status, ServerPID: 111, ServerStartToken: "token"}}})
		runtime.runner = &recordingRunner{}
		runtime.reapSessions = func(context.Context, []int, time.Duration) { t.Fatal("failed prerequisite killed pane processes") }
		if err := runtime.Destroy(context.Background(), ports.RuntimeHandle{ID: "session-a"}); err == nil {
			t.Fatal("unverified destroy succeeded")
		}
	}
}
func TestConcurrentEnsureStartsOnlyConfiguredUnitOnce(t *testing.T) {
	fixture := newServerFixture()
	fixture.absent = true
	managed := NewManagedServer(fixture.options())
	var done sync.WaitGroup
	for i := 0; i < 8; i++ {
		done.Add(1)
		go func() {
			defer done.Done()
			if _, err := managed.Ensure(context.Background()); err != nil {
				t.Error(err)
			}
		}()
	}
	done.Wait()
	if fixture.starts != 1 {
		t.Fatalf("unit started %d times", fixture.starts)
	}
}
func TestPIDPermissionFailureRemainsUnknown(t *testing.T) {
	fixture := newServerFixture()
	options := fixture.options()
	options.Command = func(ctx context.Context, env []string, name string, args ...string) ([]byte, error) {
		if name == "tmux" && len(args) > 1 {
			return []byte("error connecting: Permission denied"), fixtureExit{}
		}
		return fixture.command(ctx, env, name, args...)
	}
	result, err := NewManagedServer(options).Ensure(context.Background())
	if err == nil || result.Absent || fixture.starts != 0 {
		t.Fatalf("permission error treated as absent: %+v %v", result, err)
	}
}
func TestVersionMinimumAndUnknown(t *testing.T) {
	for _, version := range []string{"tmux 3.2", "tmux 3.2a", "tmux 3.5a", "tmux 4.0"} {
		if err := CheckVersion(version); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []string{"tmux 3.1c", "tmux 2.9", "", "unknown", "tmux next"} {
		if err := CheckVersion(version); err == nil {
			t.Fatal("unsupported version accepted", version)
		}
	}
}

func TestMissingManagedNamespaceFailsWithoutDefaultSocket(t *testing.T) {
	for _, missing := range []string{"socket", "unit", "tmpdir"} {
		t.Run(missing, func(t *testing.T) {
			t.Setenv("AO_TMUX_SOCKET", "")
			t.Setenv("AO_TMUX_UNIT", "")
			t.Setenv("AO_TMUX_TMPDIR", "")
			fixture := newServerFixture()
			options := fixture.options()
			switch missing {
			case "socket":
				options.Socket = ""
			case "unit":
				options.Unit = ""
			case "tmpdir":
				options.TmpDir = ""
			}
			result, err := NewManagedServer(options).Ensure(context.Background())
			if err == nil || result.Status != "unknown" || len(fixture.calls) > 0 {
				t.Fatalf("missing namespace used defaults: %+v %v calls=%v", result, err, fixture.calls)
			}
		})
	}
}

func TestV1SystemdOwnershipAllowsSharedResourceControllers(t *testing.T) {
	read := func(which string) []byte {
		data, err := os.ReadFile(filepath.Join("testdata", "v1-shared-resources-"+which+".cgroup"))
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	server, err := ParseCgroups(read("tmux"))
	if err != nil {
		t.Fatal(err)
	}
	daemon, err := ParseCgroups(read("daemon"))
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := IndependentCgroups(server, daemon); err != nil || !ok {
		t.Fatalf("shared resource roots mistaken for daemon ownership: %v", err)
	}
	fixture := newServerFixture()
	fixture.files["/proc/111/cgroup"] = read("tmux")
	fixture.files["/proc/222/cgroup"] = read("daemon")
	if result := NewManagedServer(fixture.options()).Inspect(context.Background()); result.Status != "ok" {
		t.Fatalf("legitimate v1 layout not usable: %+v", result)
	}
	for _, group := range []string{daemon["v1:name=systemd"], daemon["v1:name=systemd"] + "/child"} {
		changed := maps.Clone(server)
		changed["v1:name=systemd"] = group
		if ok, err := IndependentCgroups(changed, daemon); err != nil || ok {
			t.Fatalf("daemon ownership accepted: %q %v", group, err)
		}
	}
	for _, group := range []map[string]string{{"v1:cpu": "/"}, {"v1:memory": "/user.slice"}} {
		if _, err := IndependentCgroups(group, group); err == nil {
			t.Fatal("missing ownership hierarchy treated as known")
		}
	}
	// Hybrid resource-only unified hierarchy is not systemd's unit ownership.
	server["v2"], daemon["v2"] = "/", "/"
	if ok, err := IndependentCgroups(server, daemon); err != nil || !ok {
		t.Fatalf("hybrid resource root mistaken for ownership: %v", err)
	}
	if actual, _ := systemdCgroup(server); actual != "/user/ao-tmux.service" {
		t.Fatalf("wrong hybrid authority: %s", actual)
	}
}
