# Schema compatibility inputs

For `verify:fresh-clone --tarball ... --sha256 ... --release-payload ...`, the archived annotated-tag
lock still exercises bootstrap, offline replay, reinstall and PATH-shadow
rejection. Lifecycle acceptance then binds the installed package's complete
manifest and runtime pin to the exact cloned commit/tree. The complete frozen
payload is mandatory because npm omits dependency/tooling bytes by the existing
packaging policy; `AO_RELEASE_BUNDLE/payload` is also accepted. The verifier
checks the tarball against that full payload, checks each required installed
package file, then uses the npm-installed CLI to execute the same daemon bytes
from a private copy of the full payload. The ready, owned
PID/start-token exit and two ownership-lock checks are unchanged. The receipt
identifies the packed runtime separately from its archived bootstrap source;
no tag or runtime-lock promotion is needed for candidate acceptance.
The local release probe must provide a real independent
`ao-pilot-staging-fresh-tmux.service` using the generated private tmux directory;
tmux/systemctl are included in the safe tool path only for supplied packages.
Without the independent server the unchanged readiness check rejects the run.
The verifier does not install or start user units itself. Cloud tests continue
to use isolated fixtures and must not access workstation services or data.

A complete unified release requires a **tracked**, sanitized, empty SQLite
fixture and `release/compatibility.json` (or `--compatibility <tracked-path>`):

```json
{
  "schema_version": "ao.schema-compatibility-input.v1",
  "old_binary_sha256": "<independently selected exact old binary SHA256>",
  "fixture_database": "release/fixtures/empty-old-schema.db",
  "fixture_sha256": "<SHA256 of that tracked empty fixture>"
}
```

The placeholders above are documentation, not acceptable build inputs. This PR
does not certify an old artifact or supply production-derived database bytes.
The old binary is a separate explicit `--old-binary /absolute/path/to/ao` input;
its bytes must match the tracked descriptor. Never import a local installation
or accept a descriptor that merely says `passed`.

`verify-schema-compatibility.js` first requires zero projects, sessions and
worktrees, integrity `ok` and no foreign-key errors. It copies the fixture into
isolated private directories, executes the exact candidate and old artifacts,
queries empty sessions, proves owned process exit, checks migrated schema and
integrity, and binds all three input hashes to the generated result. Old-reader
failure records incompatibility; candidate failure or unknown exit blocks the
build. This empty-fixture harness is a promotion prerequisite, not production DB
migration or recovery acceptance. Recovery operations, realistic migrated data,
new→old→new and production-copy migration remain explicit local staging checks.

The generated `release/compatibility-result.json` is included in the manifest
and package. `previous_reader_compatible` never comes from a JSON `passed` label.
Missing descriptor, fixture, old artifact or platform digest rejects the build.
The release workflow remains blocked until these reviewable inputs are added.


## Checked-in release input (2026-10-24)

`compatibility.json` selects the exact currently deployed
`0.11.2-local.20261023` artifact as the primary old reader. Its SHA256 is
`45705237dcda7a8916b8291364869c181a1d9d70f7cd636932c301242268909a`.
The binary is a separate private `--old-binary` input; no installed binary,
production database, private log or session identity is committed here.

`fixtures/empty-schema43.db` is generated from a new empty database using the
migrations at source commit `47062799b4840463521ab45afa90920e63f324f4`.
It contains no production-derived pages. All non-migration tables are empty;
`projects`, `sessions` and `session_worktrees` each have zero rows. The schema
version is 43, integrity is `ok`, and foreign-key checking returns no rows.
Its SHA256 is `03ba28d7eeadb52cd2293fb1fe3fadd6514ed49b54dda6f917bead8b43d30f84`.
Only the SQLite database is tracked, never WAL/SHM files.

To generate it, use Go 1.25.7 with CGO disabled and the backend module's pinned
Go dependencies. In a fresh copy of that exact source, run a temporary Go
program from `runtime/headless/backend` that:

1. Opens a previously nonexistent SQLite file using `database/sql` and the
   backend's `modernc.org/sqlite` driver.
2. Calls `goose.SetBaseFS(os.DirFS("internal/storage/sqlite"))`,
   `goose.SetDialect("sqlite3")`, then `goose.UpTo(db, "migrations", 43)`.
3. Closes the Go database. With SQLite 3.45.1, opens that file, executes
   `UPDATE goose_db_version SET tstamp='2000-01-01 00:00:00'`, and commits.
4. Executes `PRAGMA journal_mode=DELETE`, then `VACUUM`, and closes the file.
5. Checks the schema, all table counts, integrity and foreign keys before
   comparing SHA256 with the descriptor. Two fresh independent generations
   using these same steps produced identical bytes.

Do not sanitize a production database to produce this public fixture. Use
SQLite's backup API when making private migration-test copies so committed WAL
content is included; copying only the main database file is insufficient.

### Observed reader behavior and limits

The exact-main CGO=0 storage harness migrated a consistent private schema-43
copy to schema 44 without starting any sessions. Counts, session identity
hashes and integrity were preserved. On separate consistent schema-44 copies,
the following artifacts started, answered session queries, and exited cleanly:

| Old artifact | Exact SHA256 | Observed read | Schema/count/identity/integrity |
| --- | --- | --- | --- |
| 0.11.2-local.20261023 | 45705237dcda7a8916b8291364869c181a1d9d70f7cd636932c301242268909a | PASS | PASS |
| locked 0.11.2-p0.4 | 45d257d19810cb606917ce734ec281c16617b0ec0088591e3cea909c27868919 | PASS | PASS |

The old-reader probes used private filesystem, network and PID namespaces,
without production worktrees, credentials, sockets or service access. tmux and
systemctl execution were denied. No cloned production session was restored.
These are observed reads, not certification of restoration or all writes.
Untested artifacts and failed or unknown probes are incompatible for rollback;
there is no compatibility claim for any other binary. Operational rollback
remains **previous + pre-migration backup** until its complete behavior is
verified. The loss window is backup completion through writer stop at rollback;
external effects are not undone, and worktrees are not overwritten by DB restore.

### Original verifier blocker and corrected boot contract

The initial L1 empty-fixture verifier returned
`compatibility_candidate_failed`: after the candidate daemon starts, schema is
44 and session/worktree counts remain zero, but it creates one default scratch
project. The verifier required the post-start project count to remain zero.
The old phase of that attempt was therefore NOT_RUN, and no generated
`previous_reader_compatible` result or complete release PASS was claimed for
that attempt.
The input-only PR did not change that verifier, the daemon,
the installer, the runtime lock or any production service. Source review and
merge of these inputs do not establish L1 staging or production acceptance.

The separate verifier correction retains the empty input requirement. After
candidate boot it accepts either no projects, or exactly the built-in `scratch`
row: scratch kind, default name, no origin/archive, the exact private candidate
DataDir's `scratch/default` path, a registration time within the owned probe
(with one second of timestamp tolerance),
and only the default role configuration. The probe explicitly pins the agent
to `claude-code`; hooks, tracker intake and additional config are rejected.
All project columns are inspected, not just the count or display name.

The old reader must preserve the complete validated project snapshot, including
the original candidate path, timestamp and raw config. Deletion, reseeding,
relocation, any metadata mutation or extra project makes it incompatible.
Schema/version, integrity, foreign keys, zero sessions/worktrees, exact input
hashes and owned-process exit checks remain mandatory. The input database is
never pre-seeded or modified. An older artifact that does not seed is still
supported, but it may not add a project when reading the candidate's copy.

Real empty-fixture replay with the unchanged native development binary and the
two exact old artifacts above passed migration 43→44 and old-reader checks.
This corrects the schema harness contract; complete release construction,
staging, recovery/write behavior and production acceptance retain their
separate gates and historical FAIL/NOT_RUN qualifications.

## First migration from a legacy installation

`upgrade apply --release <id> --adopt-legacy` is an explicit first-migration
option, requiring `mode: "first"` and an install root with neither `current`
(including a dangling symlink) nor `install-journal.json`. It is rejected for
an existing installation, even if its journal is committed or rolled back.
Later upgrades retain the strict `AO_DATA_DIR` / `AO_RUN_FILE` ownership check.
Do not add environment variables to running legacy services to bypass that check.

The private install configuration must specify `legacyInventoryPath` and its
independently recorded byte SHA256 as `legacyInventorySha256`. This owner-only,
single-link regular JSON file is the L1 step-6 inventory in the following format:

```json
{
  "schema_version": "ao.legacy-adoption-inventory.v1",
  "namespace": "ao-pilot",
  "tmux": {
    "socket": "default",
    "tmpdir": "/example/legacy-tmux",
    "pid": 124,
    "start_token": "12345",
    "executable_sha256": "<exact old tmux executable SHA256>",
    "session_names": ["example-session"]
  },
  "units": [
    {
      "unit": "ao-pilot-runtime.service",
      "exec_start": {
        "path": "/example/legacy/ao",
        "argv": ["/example/legacy/ao", "daemon"],
        "files": [{"path": "/example/legacy/ao", "sha256": "<exact SHA256>"}]
      },
      "unit_files": [{"path": "/example/units/ao-pilot-runtime.service", "sha256": "<exact SHA256>"}],
      "process": {
        "pid": 123,
        "start_token": "<recorded process start token>",
        "cmdline": ["/example/legacy/ao", "daemon"],
        "executable": "/example/legacy/ao",
        "executable_sha256": "<exact SHA256>"
      }
    }
  ]
}
```

The example is incomplete and deliberately invalid as an input. Supply exactly
four records, ordered runtime, dashboard, dashboard-adapter, session-recovery.
Each includes the effective unit and every loaded drop-in file in order.
`exec_start.files` binds the executable **and** absolute file arguments such as
the Node script. Symlinked absolute arguments are rejected. Executable inputs
must belong to the service user or root and must not be group/other-writable;
unit files and the private inventory retain their service-user ownership checks.
`process` is null only for an inactive unit. For a live unit,
its actual cmdline must equal effective ExecStart argv, its executable digest
must match, and MainPID must belong to the unit's cgroup. Unknown or ambiguous
ExecStart syntax, missing units, stale loaded files or any mismatch are refused.

Record this inventory during the read-only L1 capture. Do not replace expected
values with current observations to make a mismatch pass. For staging, preserve
the explicit production-to-staging path/namespace mapping and independently
verified copied-file hashes alongside the projected inventory. No private
inventory, path, PID or cmdline belongs in a public PR receipt.

Preflight independently samples all four units and compares every field with
that inventory. The captured evidence and inventory SHA256 enter the private
journal before switch. Immediately before any legacy stop, the runner samples
again and requires equality. The ordinary release/environment checks for new
services and all verify/readback checks remain mandatory.

The inventory must also record the **actual old tmux** socket, temporary
directory, PID/start-token, executable SHA256 and session names. Legacy `default`
is accepted only in this digest-bound inventory; the new installation still
rejects `default`. Preflight probes that old socket and compares its identity;
switch rechecks it before stop. The new rendered units always use the new
configuration's socket. Staging must model `default` with a private
`TMUX_TMPDIR`, rather than renaming both old and new servers to one socket.

Before creating the install root or acquiring its lock, the real runner checks
all required host commands: node, flock, systemctl, sqlite3, loginctl, ss, tmux
and git, plus the process/shell tools used by recovery (ps, pgrep, pkill, sh,
bash and env). It reports every missing name and pins resolved absolute paths. Native
doctor/selected-agent tools retain their existing diagnostics; optional harness
warnings are not silently promoted to PASS. Baseline exceptions retain their
command-specific causes in private CLI diagnostics. Public receipts keep the
same strict allowlist and never include these details.

`upgrade preflight --release <id> --install-config <private-file> --adopt-legacy`
executes the same baseline collection without preparing a release, acquiring
an install lock, writing a journal, stopping services or running migrations.
`--prepared-config` and `--prepared-token` allow it to validate the reviewed
private inputs before their production destinations exist; these overrides
are rejected for apply. The Owner entrypoint `scripts/ao-owner-upgrade.py`
requires explicit `--check-only` or `--apply`, reads a receipt's frozen PATH
and absolute tool paths. Its trusted preflight runs in the host user namespace
so it can read the actual service process identities under /proc. The additional
bwrap wrapper was removed with Owner authorization after its child user namespace
blocked these reads; no identity or preflight check is skipped. Check-only writes no receipt; stdout/stderr are private
diagnostics. Explicit apply delegates only to the receipt's hash-bound Owner
draft after that check succeeds. It does not inherit shell loader options or
caller PATH. Cloud tests use injected tools and never call workstation services.

An interrupted first transaction retains its recorded adoption evidence; an
ordinary `--resume` uses it without enabling `--adopt-legacy` a second time.
Only a durably completed stop permits the recorded fully stopped state, with
unchanged unit files, ExecStart and digests. A new adoption request cannot reuse
an existing journal.

### Offline first migration after the old installation has stopped

`--adopt-legacy-offline` explicitly selects the first-migration path when a WSL
restart has removed the old processes. It is mutually exclusive with
`--adopt-legacy`; it is rejected for daily upgrades, resume, or an installation
with `current` or a journal. The original inventory is retained unchanged.
All four legacy units must be loaded, inactive/dead with MainPID zero and no
ControlGroup; unit/drop-in bytes, ExecStart and executable/script digests must
still match that inventory. The recorded old processes must be gone, the actual
old socket absent, and no matching legacy entrypoint may run outside its unit.
Process matching resolves `/proc` executable identity and absolute/relative or
symlinked script arguments; invoking an interpreter through PATH cannot hide an
old recovery loop. An unreadable identity remains a blocking observation error.
The sole protected-process exception is the user manager and its PAM helper:
the system manager's `user@UID.service` MainPID, its reserved `init.scope`,
parent identity and root-owned manager executable must prove that identity.
No basename prefilter excludes other processes before actual executable/script
resolution; unreadable old components or arbitrary processes still refuse admission.
The tmux probe always uses `-N`. Observation errors refuse admission.

The private configuration must additionally bind `offlineBaselinePath` and
`offlineBaselineSha256`. This owner-only single-link JSON file has
`schema_version: "ao.legacy-offline-baseline.v1"`, the original
`inventory_sha256`, and `snapshot` containing the previously approved
`identities`, `native_cids`, `custody`, `projects`, and `database` fields.
It is derived from retained preflight evidence, not silently refreshed from a
changed database. Current identities/CIDs/custody/schema must match exactly.
Both daemon locks must exist and be free, all five configured ports unused,
linger enabled, and existing trusted-host/control-lock checks must pass.

The offline observation records DB/WAL byte digests before and after reading.
It requires an absent or empty WAL and uses immutable read-only SQLite URIs
to avoid creating WAL/SHM files during check-only. Pending WAL bytes are an
explicit failure; it never ignores them or performs an automatic checkpoint.
Quiescent collection and the offline source side of `.backup` use the same
immutable URI, so taking a backup cannot invalidate the recorded DB/WAL fence
or obstruct a legitimate resume before unit installation.
Its exact evidence is journaled and checked again before service mutation.
No old HTTP readiness or tmux generation is invented: these observations are
explicitly offline/absent. The stop step rechecks and leaves the stopped old
services untouched. The regular backup, migration, explicit restore scope,
all 17 verify/readback checks, and rollback policy remain unchanged.
The Owner entrypoint requires the same `--adopt-legacy-offline` flag for its
check-only and apply commands; the hash-bound apply draft must select it too.

Custody backups and restores explicitly reproduce source directory/file modes
after copying. Node `fs.cpSync` creates new directories according to the caller's
umask; with umask 022, a source 0700 directory otherwise becomes 0755. The full
inventory equality check, including permission modes, remains in force.

## Managed terminal admission

Prepare `terminalTokenFile` before preflight: an owner-only, single-link regular
file containing a randomly generated capability (at least 32 characters), with
mode 0600. Missing, symlinked or shared-readable credentials block preflight
before any service stop. Staging credentials must remain within its private
state root. Never reuse a production capability in staging.

The generated private adapter JSON carries `TERMINAL_TOKEN_FILE` and the exact
`TERMINAL_ORIGIN`. Both browser and adapter use the existing
`AO_DASHBOARD_ADAPTER_CONFIG` pointer; no new environment-override keys are
allowed. Managed adapter and direct terminal reject missing/incorrect credentials
before WebSocket upgrade and reject a foreign original Origin before proxying.

CLI probes use `Authorization: Bearer`. An ordinary browser authenticates to
the adapter using HTTP Basic, username `ao`, with the capability as its password.
Its origin-scoped HTTP authentication cache also authenticates WebSocket
upgrades. Terminal capabilities are never placed in cookies (which are shared
across localhost ports), URLs or unauthenticated responses. Do not publish
credentials or pass them in process arguments.

Managed browser tmux clients use the configured named socket and `-N`, including
PTY attach. They cannot implicitly start a default server. The terminal URL uses
`/ao-terminal-ws?session=<fake-session-id>` for staging. Existing unmanaged
standalone browser/adapter behavior is outside this managed-release admission
claim; new release entrypoints always require the managed credential binding.

## Batch recovery scope

`ao session restore --all --project <id>` selects the project's live rows at
request time and leaves previously terminated rows untouched. Orchestrators
finish before workers; HOLD checks and native conversation identity rules still
apply. Include historical rows only with explicit `--include-terminated`.
`--session-id <id>` is repeatable and restricts a batch to those IDs; duplicate
or unknown IDs reject the entire selection before any restore.

The first-install runner captures the live ID set before starting the new
daemon. Reconciliation may mark those sessions terminated during boot, so the
runner passes both the explicit ID set and `--include-terminated`. Historical
terminated rows are excluded from that set. Empty live sets issue no restore
command. The native result must cover exactly the captured live set, with only
native/already-running or skipped-HOLD outcomes; extra, missing or duplicate
results fail verification. The API equivalents are `includeTerminated` and
`sessionIds`; omitted values retain the live-only default.

First-install journal `restore_baseline` persists the original live selection
before any stop and is reused across resumes. A fresh stopped observation never
replaces it. Requests are split within the existing 4096-byte body limit, with
all project orchestrators completed before any project workers; each request
and the combined selection retain exact-set checks.


Read-only preflight uses `native/ao doctor --json --tmux-only`: this invokes the
shared ownership diagnostic without creating DataDir, probing writes, executing
agent harness probes, or sending CLI telemetry. Ordinary doctor remains
unchanged. A legacy HTTP 503 with exactly the known tmux cgroup violation is
recorded as degraded, never PASS; unknown response failures still reject baseline
collection. Verify/readback retain strict readiness and all 17 checks.

The trusted Python Owner entrypoint verifies the manifest digest from the pinned
envelope and the full unpacked inventory (bytes, modes, types, symlinks, no extra
entries) before executing any payload code, in addition to the tarball digest.
