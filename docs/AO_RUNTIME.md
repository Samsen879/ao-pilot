# AO Runtime Lock and Provenance

`ao-pilot` owns both its control plane and the minimal headless runtime source.
The package must never treat a command named `ao` on `PATH`, an old HOME
checkout, an npm link, or a mutable Git branch as runtime authority.

The canonical runtime contract is committed at
[`runtime/agent-orchestrator.lock.json`](../runtime/agent-orchestrator.lock.json).
Validate it without installing or starting the runtime:

```bash
npm run verify:runtime-lock
```

The verifier emits the lock schema and digest together with the public source,
upstream identity, version, annotated tag object, commit, tree integrity, build
contract, binary path, and compatibility range. This is an offline structural
gate. Validate the separate official Go archive lock and formal entrypoint with:

```bash
npm run verify:runtime-bootstrap
```

## Canonical runtime

- runtime ref: `runtime.ao_pilot_headless.v0_11_2_p0_4`
- repository: `https://github.com/Samsen879/ao-pilot.git`
- upstream package identity: `@aoagents/ao@0.11.2` (identity only; not install
  authority for the fork delta)
- immutable subtree tag: `ao-pilot-headless-runtime-v0.11.2-p0.4`
- annotated tag object: `7947c3ac8787576bce0d5d7627c8020e95643bef`
- commit: `43d37ef2a76e1949c8032c49c5e6197d98bf0b96`
- tree/integrity: `91282c19b408935e94d732e8e10699d393f3c821`
- source toolchain: Go `1.25.7`, `CGO_ENABLED=0`
- managed binary relative path: `bin/ao`
- Linux x64 expected binary SHA-256:
  `45d257d19810cb606917ce734ec281c16617b0ec0088591e3cea909c27868919`
- Linux arm64 expected binary SHA-256:
  `2b2025e9aaf3fd8799fa6c5ed149118f15d8d62e56123c3fa13c70c7c3ea3ffe`
- ao-pilot compatibility: `>=0.2.0` and `<0.3.0`

The tagged subtree contains only `backend/`, upstream license/provenance, and
the ao-pilot modification that makes `ao start` fail closed. It contains no
frontend, Electron, AppImage, installer, or desktop acquisition/open source.
No separate runtime repository or GitHub Release is required.

The p0.1 tag/commit/tree and binary digests remain immutable historical
evidence for the principal/bootstrap proof produced before this canonical
p0.4 transition. They are not the current runtime lock and must not be
rewritten in that historical receipt layer.

## Managed provenance contract

A runtime is usable only after a managed installation contains
`runtime-provenance.json` next to the locked `bin/ao`. The provenance record is
bound to:

- the normalized lock SHA-256 digest;
- the runtime ref and exact public repository;
- version, annotated tag object, commit, tree, and tree integrity;
- the binary name and managed relative path;
- the target OS/architecture and installed binary SHA-256;
- the exact compatibility contract.

The deterministic resolver requires an explicit managed-store root and derives
the runtime directory from the runtime ref, target OS/architecture, and commit
SHA. Each platform's expected binary SHA-256 is authenticated by the committed
lock rather than trusted from the writable provenance file. Repeated clean
builds with the locked Go toolchain produced byte-identical binaries for both
admitted targets. The resolver does not search `PATH` as an installation
mechanism. It fails closed on:

- absent or malformed managed provenance;
- an unknown repository or mutable ref;
- version, tag, commit, tree, or integrity mismatch;
- a missing, non-executable, or modified binary;
- a platform collision or any symlink within the managed runtime path;
- incompatible ao-pilot, OS, or architecture versions;
- a different executable named `ao` appearing first on `PATH`.

The final item makes shadowing visible and prevents accidental fallback to a
same-name package. P0-R06 lifecycle commands invoke only the verified absolute
managed binary path returned by this resolver. Reconciliation uses that same
path for runtime status observation and never falls back to a PATH command.
Runtime observation uses `ao session ls --all --project <id> --json` from that
binary. Runtime daemon start invokes its `daemon` entrypoint directly. The
runtime's own `ao start` command is disabled and cannot discover, download, or
open a desktop application. Verify the source boundary with
`npm run verify:headless-runtime-source`.

### Worktree capacity guard source status

The headless source tree contains a candidate capacity guard, but the immutable
managed runtime lock above still points to p0.4. That installed binary does not
consume the capacity environment variables. Do not rely on the guard until a
later release publishes and admits a runtime tag and binary digests containing
this source change. The release must document its operator configuration at
that cutover.

## Deterministic managed bootstrap

Run the formal entrypoint from a clone or installed package:

```bash
./scripts/bootstrap.sh --json
```

The bootstrap:

1. validates the runtime lock and `runtime/go-toolchain.lock.json`;
2. fetches only the locked annotated headless subtree tag from `ao-pilot` into an isolated
   content-addressed bare cache and verifies tag object, commit, tree, and Git
   object integrity;
3. downloads the matching official Go 1.25.7 Linux archive over HTTPS and
   verifies its committed SHA-256 before every extraction;
4. uses isolated Git/Go homes and never searches an old runtime checkout;
5. builds with the exact locked command, `GOTOOLCHAIN=local`, `CGO_ENABLED=0`,
   and a target-specific cache;
6. verifies the final binary against the platform digest in the runtime lock;
7. writes read-only `runtime-provenance.json` and `runtime-bootstrap.json`;
8. atomically promotes the staged runtime, then re-runs the resolver.

Default locations are:

```text
store: ${XDG_DATA_HOME:-$HOME/.local/share}/ao-pilot/runtimes
cache: ${XDG_CACHE_HOME:-$HOME/.cache}/ao-pilot/runtime-bootstrap
```

Use `--store`/`--cache` or `AO_PILOT_RUNTIME_STORE`/
`AO_PILOT_RUNTIME_CACHE` to choose explicit roots. The store identity is
`runtime_ref / OS-architecture / commit`. Neither root contains credentials,
sessions, leases, or copied Agent Orchestrator state.

### Recovery and reinstall

- A second run is idempotent and returns `reused` only after full resolver
  verification.
- `--offline` forbids public Git fetches and downloads. It succeeds only from
  verified source/toolchain/module caches; the final locked binary digest still
  authenticates the result.
- `--reinstall` builds in a new staging directory and atomically replaces the
  previous target only after the candidate passes integrity checks. A failed
  build preserves the prior verified runtime.
- Bootstrap locks bind PID and Linux process-start identity. A live owner blocks
  concurrency; a dead owner permits bounded cleanup of only its matching
  staging and partial-cache paths. Promotion backups belonging to that verified
  dead owner are restored and re-verified when the target is missing; ambiguous
  target/backup combinations fail closed.
- Managed symlinks, corrupt caches, wrong digests, unsupported platforms, and
  a shadowing PATH `ao` all fail closed with machine-readable diagnostics.

## Boundary with later P0 gates

The lock plus bootstrap now establish deterministic identity, retrieval,
build, installation, cache reuse, and resolution. P0-R06 adds runtime-aware
doctor output and verified `start`, `stop`, `status`, and
`runtime-path` entrypoints:

```bash
node ./bin/ao-pilot.js runtime-path --json
node ./bin/ao-pilot.js doctor --json
node ./bin/ao-pilot.js start
node ./bin/ao-pilot.js status --json
node ./bin/ao-pilot.js runtime-project-get my-project --json
node ./bin/ao-pilot.js stop
```

The doctor reports source/version/commit/tree/integrity, compatibility, exact
binary path/digest, shadowing, and GitHub/Codex auth availability without
retaining command output or secrets. A missing, changed, incompatible, or
shadowed runtime blocks lifecycle execution.

`runtime-contract` probes only version and command help on that exact binary. It
publishes the supported global status, project readback, and spawn-custody
surfaces as normalized JSON. Installed browser services pass the verified
absolute binary, its verified SHA-256, and the exact deployment daemon namespace
to Codex workers as `AO_MANAGED_RUNTIME_BINARY`,
`AO_MANAGED_RUNTIME_BINARY_SHA256`, `AO_MANAGED_RUNTIME_DATA_DIR`, and
`AO_MANAGED_RUNTIME_RUN_FILE`; their `~/.ao/bin/ao` wrapper rejects an absent,
relative, non-executable, symlinked, or digest-mismatched binding before
execution. Partial dashboard/recovery service installs inherit this identity
from the effective active runtime foreground process and its sole daemon child
(PIDs, working directory, commands, environments, child executable path, and
live executable digest) instead of trusting only the static unit or mixing a
new CLI with an old daemon. Operator `runtime-contract` invocations recover the same active
binding when service-only environment variables are absent, and authenticate
the launcher with a valid version probe, a deliberate digest-rejection probe,
and a namespace-sensitive status probe with poisoned ambient data/run paths.
The active service store is resolved before the operator runtime, preserving a
custom `AO_PILOT_RUNTIME_STORE` even when it is absent from the shell.
Run that installed-boundary check only after the runtime service is active and
a managed Codex worker/orchestrator has been spawned (or a pinned Codex session
restored), because that workspace hook provisions the launcher:

```bash
node ./bin/ao-pilot.js runtime-contract --json
```

Foreground browser launches that do not supply all four managed bindings omit
the Codex worker CLI contract. Their wrapper keeps the `git`/`gh` metadata
interceptors active while delegating `ao` to the ambient command outside
every canonical alias of `~/.ao/bin`; unbound tmux launches explicitly clear
all four managed bindings, while partial bindings remain fail-closed. Restores rerun
the agent workspace hook before runtime creation and inject current managed CLI
compatibility guidance into the resumed Codex conversation. Bound Codex orchestrators use
`ao status --json` only for daemon health, use project-scoped JSON session
listing for coordination, and receive managed spawn/send/claim command forms. An
active service's `AO_PILOT_RUNTIME_STORE` override is preserved during installed
provenance resolution and emitted into every generated service unit. Launcher
authentication probes are bounded to five seconds and timeouts fail closed.

`npm run verify:runtime-lifecycle` checks the static exact-binary routing
contract. `npm run verify:fresh-clone` is the separate P0-R07 live integration
gate: exact clone, empty HOME, install, bootstrap, offline replay/reinstall,
hostile PATH rejection, provenance-aware doctor, daemon start/status/stop, and
bounded local worktree cleanup. It uses local/fake credential boundaries and
therefore does not prove a GitHub Worker delivery or workstation self-hosting.
Those remain exclusively gated by the P0-R08 receipt and manual workflow.
