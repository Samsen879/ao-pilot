# Daemon process ownership and discovery handoff (#129)

The native daemon and offline importer now acquire OS locks before creating
browser authority, opening writable SQLite, or starting runtime/recovery work.
Admission conflicts and unknown legacy process observations return an error;
HTTP health failures never confer ownership.

## Protocol

Two permanent lock files protect the canonical DataDir and canonical discovery
parent: `.daemon-owner.lock` and `.daemon-discovery.lock`. The second protects
both running.json and the existing fixed Unix browser/supervisor socket names.
Paths become absolute before any chdir; directory aliases resolve to the same
files. The final run-file component must be a regular file or absent: symlink
run-files are rejected. Different DataDirs sharing one discovery directory also
conflict. Lock files must never be deleted, renamed, or replaced while in use.

Linux and other supported Unix targets use nonblocking flock. Windows uses an
exclusive nonblocking LockFileEx byte-range lock. Handles are non-inheritable.
After admission, the daemon/importer retains strong references to the handles
until **OS process exit**; `Run` returning, store.Close, or disappearance of the
run-file does not release them. Both cmd/ao and the compatibility backend main
exit after their entrypoint returns. These entrypoints are not reusable daemon
hosts inside a long-lived process. Short CLI cleanup leases remain releasable.

All production discovery mutations use the Publisher and these same locks.
Records gain optional `instanceId` and canonical `dataDir`; existing payload
fields remain. Cleanup matches the observed generation, preserving a successor
even when its PID matches the previous record. Missing-record repair retains
#120's atomic no-replace publication and cancel/join behavior. #119's early
health, restoration readiness gate, and normal-exit session retention remain.

The updated `stop` requires confirmed target-process exit and available locks,
even if the initial discovery record is absent. Timeout, unknown observations,
or successor takeover returns an error. A successful result is an observation
at command completion, not a permanent prohibition on subsequent starts.
`status` remains a discovery/health observation; a missing record by itself is
not admission authority. The underlying locks reject attempts during startup
or draining, even if an older observer reports stopped.

Updated CLI shutdown requests include `X-AO-Expected-Instance`, with an explicit
legacy sentinel for old records. A new server rejects a mismatched value before
acknowledging or invoking shutdown, preventing a port-reusing successor from
consuming the old stop. Older direct callers without that header remain accepted
for compatibility and do not receive generation binding. An old server ignores
the new header, so full protection requires the new cooperating protocol.

## Scope and remaining limits

- Legacy live or unknown PIDs are held even when health fails. Confirmed Unix
  zombies count as exited; process-inspection errors remain unknown. A bounded
  `ps` probe can add up to two seconds to an individual stop poll.
- This prevents overlap between cooperating process owners. It does not claim
  that every background writer is joined: preview callbacks, multi-listener
  STOPPING behavior, and other shutdown work remain separate findings. A stuck
  shutdown retains ownership and blocks a successor rather than allowing it to
  overlap. Normal shutdown still preserves managed session runtimes.
- Existing Windows pipe names are unchanged. Different complete directories
  with the same basename can still collide in the legacy named-pipe namespace;
  independent Windows namespace redesign is not claimed here.
- Cross-platform shared directories, NFS/SMB lock semantics, hostile external
  path/lock-file replacement, and mixed old/new binary writers are outside this
  guarantee. No lease is reclaimed by TTL, health failure, or deleting a file.
- Canonical directory aliases share ownership. Existing consumers that compare
  configured path strings exactly may hold on symlink aliases; use canonical
  configured deployment paths. This change does not weaken their identity gate.
- #124 sparse worktree materialization, ConPTY registry/stop defects and the
  separate recovery/reaper policies are unchanged.

## Validation and deployment boundary

Tests use private temporary directories, fake HTTP transports/handlers, and
special-purpose lock helper processes. They do not start real AO daemons, touch
user data directories, send real shutdown requests, or operate existing tmux or
systemd services. Coverage includes double-process admission, retained handles
surviving GC, process crash, noninheritance by a still-running test child,
namespace aliases, run-file symlink rejection, generation-safe cleanup, repair,
legacy unknown/alive observations, stop while discovery is absent, importer
admission, and shutdown request generation binding.

Linux execution and Windows cross-compilation must be reported separately.
Cross-compilation is not Windows runtime or platform-lock acceptance. No actual
Windows, macOS, installed-runtime, or service deployment execution is claimed.

There is no database schema migration. Deploy or roll back only after confirming
that the previous daemon process has actually exited. Never run old and new
binaries concurrently against the same state: old binaries do not obey these
locks. Permanent lock files can remain across upgrade/rollback and must not be
removed as a way to force takeover. This source change does not itself authorize
runtime installation, service restart, release publication, or cutover.
