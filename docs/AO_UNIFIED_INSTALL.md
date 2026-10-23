# Unified Linux installation (Lane B R3)

Supports Linux x64/arm64 and WSL2 with systemd. Windows-native runtime is outside
this implementation. Existing Node 20 control-plane commands remain supported;
new unified builders and execve launchers require Node >=22.15, Go 1.25.x with
CGO=0, tmux >=3.2, git, npm, sqlite3, flock, ss and a working systemd user manager.
Run only the host architecture's build; this is not a cross-compilation claim.

Source merge is separate from release promotion and deployment. The current
p0.4 runtime lock intentionally remains unchanged; a newly built native binary
that differs from its independently locked platform SHA causes doctor FAIL.
Neither fixtures nor source CI certify a production installation.

## Immutable build and artifact identity

```sh
node scripts/build-release.js --commit <exact-main-sha> --version <version> \
  --old-binary /private/pinned-old-ao --output /private/release-output
```

The builder exports `git archive` at the exact commit and rejects escaping or
absolute symlinks before npm or build execution. Root/browser lockfiles,
SOURCE_IMPORT, adapter sources/license, templates, compiled output, dependencies,
all regular file bytes/modes and symlink targets are inventoried. Build scripts
run inside the archive; dirty worktree and installed dist/node_modules are never
inputs. The checked-in adapter is
`integrations/dashboard-native-adapter/server.mjs`, with its real config contract
and first-party root MIT license; session-recovery remains a separate component.

The builder packs once. `package.tgz` contains the same `release.json` whose
inventory binds the installed payload; every packed entry must match it.
Every non-exempt inventory file, including modules, configs, launchers and all public exports, must be present in that exact tarball. npm's node_modules/lockfile/tooling metadata and Next cache exclusions remain bound by the complete payload inventory; the actual payload's public imports, CLI and root/browser/workspace dependency resolution are exercised separately. The output bundle contains `payload/`,
`package.tgz` and `release-envelope.json`. The envelope binds both manifest and
tarball hashes. Verification, upload and installer independently recheck these
pins. Transfer the **whole bundle** and its trusted envelope SHA. A package-only
npm installation is the existing control-plane installation, not a unified
release installation. See [schema input requirements](../release/README.md).

Root archive commit/tree, runtime lock target and running native artifact are
separate identities. Runtime verification re-reads the archived lock and its
platform `binary_sha256`; copying a newly built digest into the manifest cannot
certify a stale lock. A control-only lock-promotion root commit can differ from
the runtime tag commit when the native artifact identity matches exactly.

## Private configuration and staging

Generate a plan without starting or stopping any service:

```sh
node scripts/verify-install-staging.js --prepare /private/new-staging-root \
  --id example --production-descriptor /private/production-paths-only.json
```

The production descriptor supplies namespace, paths, ports and tmux socket only;
never copy secrets or production DB/session configuration. Preparation rejects
path/namespace/port collisions, creates private fake-agent/repository inputs and
writes `install.json` plus `LOCAL-VALIDATION.md`. It does not supply a real project
configuration, token, live CID or release attestation. Fill those with temporary
fake sessions locally before executing the runbook.

Installation JSON uses `ao.install-config.v1` (see generated plan and validation
in release-systemd.js), is owner-only mode 0600 and must be a regular owned file.
Bind install/state/data/discovery/config/control/trusted-host/tmux directories,
namespace, CLI path, explicit socket, loopback URLs and five unique listenPorts
in order: native, dashboard, adapter, direct-terminal, terminal. Register
`releaseCatalog[release_id] = { bundle: <absolute path>, envelope_sha256: <trusted
build digest> }` in that private file; do not compute trust from arbitrary remote
bytes at apply time. `legacyCliTarget` explicitly authorizes one prior symlink.

`AO_DASHBOARD_ADAPTER_CONFIG` points at the generated owner-only adapter JSON.
Managed runtime binary/SHA/data/run bindings form a complete quartet. install.env derives the SHA from the verified native bytes; launchers pin the binary to the immutable release rather than current, and observers require the same binding. The launcher removes inherited adapter configuration overrides and execs the
actual source entry. Adapter itself has no authentication; upstream terminal
WS must reject no token, bad token and bad Origin and deliver authorized fake
PTY canary bytes. HTTP 101 alone cannot pass. No auth is invented by installer.

## Transaction and recovery

```sh
ao-pilot upgrade apply --release <version+commit> --install-config /private/install.json
ao-pilot upgrade inspect --install-config /private/install.json
ao-pilot doctor --install --install-config /private/install.json
ao-pilot restore --project <temporary-project> --all --concurrency 2
```

Root `restore` delegates to `current/native/ao session restore`; the existing
`ao-pilot session` pinned browser recovery commands retain their behavior.

A permanent kernel flock inode serializes processes. UID/boot/PID/start-token,
nonce and transaction ID bind the writer; every publication checks ownership.
The lock is never age-reclaimed or unlinked. An owned `.partial` is validated,
fsynced and renamed before `current` changes; an unknown partial is preserved.
Same-version prepare failure can retry. Crash journals require explicit
`--resume` with the identical envelope and configuration, then repeat verify and
readback rather than inferring success from a symlink.

The journal durably marks effects before stopping adapter/recovery/dashboard
and daemon. The default runner verifies owned PID/start-token exit and both
ownership locks available. It then reads the final DB CID set and requires it
matches preflight before taking a consistent SQLite backup. A changed set holds
for rebaseline. This controlled stopped-writer boundary is not a native global
maintenance API: before stop, direct local CLI requests cannot be frozen by
READ_ONLY/AUTOMATION flags. No running writer is accepted for backup/switch.

All original units and drop-ins, their hashes/modes, install.env,
installation.json, adapter JSON and CLI symlink are private transaction backups.
Backups must finish before replacements. Final units share one namespace and
stable `current` entry. At most one allowlisted environment-only override is
accepted; ExecStart/KillMode/dependency overrides reject. Legacy deployment
scripts delegate to this apply path and require a registered release. Legacy
read-only template rendering and standalone p0.4 bootstrap remain for existing
installs; AO_INSTALL_ROOT rejects mixed bootstrap stores.

Verify and readback require all fixed checks PASS: current/CLI/service identity,
strict readyz status=ready, ready=true with no reasons (distinct from CLI status.state), exact CIDs, schema/integrity, held daemon locks,
shared Go tmux cgroup doctor, compatible tmux generation, linger, loopback
listeners, terminal auth/canary, LAN disabled, trusted-host disabled, and control
lock start-token metadata. UNKNOWN blocks. Daily upgrades preserve tmux server
PID/start-token; executable incompatibility holds for a planned interruption.
First scheme-B requires explicit restoreProjects and restoreConcurrency (1..16) before any stop. After boot REST is available, it delegates each named project to native batch restore, accepts only complete restored/skipped_hold result sets, preserves original AOID→native conversation/CID and raw orphan custody/hash snapshots, then requires strict readyz and full readback. Daily mode never restores. Missing projects, failed results, CID drift or removed/changed custody hold. Custody JSON validation remains UNKNOWN; no Node authority algorithm is invented. Migration requires locally verified owned resources and the planned interruption runbook; no broad kill or automatic adoption of an
unknown server is attempted. Legacy artifacts lacking the new contract fail.

Rollback stops all writers again. Verified old-reader compatibility allows
previous plus old environment/units, followed by the same readback. Otherwise
`--allow-database-restore` is required to restore the consistent pre-migration DB
and previous release. Data loss spans backup completion through writer stop;
external effects are not undone. Worktree/WIP backups must be reviewed locally
and are never blindly overwritten by DB rollback. A first installation failure
restores/removes CLI/environment and preserves recovery_required; it cannot
restart an unknown legacy service or claim rolled_back. GC runs only after a
durable committed journal, protects current/previous/process pins, and a GC
failure is a warning rather than rollback.

## Evidence and release boundary

Complete receipts with PID/start-token/paths/CIDs remain local mode 0600. Public
receipts are an allowlist projection into
`schemas/ao.install-public-receipt.v1.schema.json`, with fixed check IDs/statuses
and failure enums. Arbitrary messages, paths, tokens, addresses, PIDs and session
text are excluded. `inspect` is private diagnostics, not an uploadable receipt.

Before promotion, replay the generated staging runbook, real archive build,
real old/candidate schema harness, exact-final-head gates, migration copy,
new→old→new and restart/stop+start/SIGKILL WebSocket canary checks. Two daemon
locks and actual owned exit are now mandatory in fresh-clone; health query
failure alone never proves no leak. Existing p0.4 does not certify these newer
contracts. No real systemd, AO daemon or production data was used for cloud
fixture validation. AO05-F07/F08, LAN STOPPING and broader business-policy fixes
remain outside this installation change. Final R3 release attestation, tag,
lock promotion and deployment require their separate authorized gates.
