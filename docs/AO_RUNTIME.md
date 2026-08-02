# AO Runtime Lock and Provenance

`ao-pilot` and the Agent Orchestrator runtime are separate deliverables. The
control-plane package must never treat a command named `ao` on `PATH`, an old
HOME checkout, an npm link, or a mutable Git branch as runtime authority.

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

- runtime ref: `runtime.agent_orchestrator.v0_11_2_p0_1`
- repository: `https://github.com/Samsen879/agent-orchestrator.git`
- upstream package identity: `@aoagents/ao@0.11.2` (identity only; not install
  authority for the fork delta)
- immutable tag: `ao-pilot-runtime-v0.11.2-p0.1`
- annotated tag object: `06ba07935cbacb7ff304779a2c1060ce98778200`
- commit: `711178ebe07d436db36020eb08f0c4e29613f97b`
- tree/integrity: `479fba6fd44f251f0c66fafc5cb5d638a6ff590a`
- source toolchain: Go `1.25.7`, `CGO_ENABLED=0`
- managed binary relative path: `bin/ao`
- Linux x64 expected binary SHA-256:
  `a403e096203e68e94dde5f45922b0880a4a2dd662c38aab3f0af6d47ec56aa34`
- Linux arm64 expected binary SHA-256:
  `132164dc29349ea2082d77d6758b3617be81c7cfcf27d3f0ba9a88d65a88c752`
- ao-pilot compatibility: `>=0.2.0` and `<0.3.0`

No GitHub Release or npm publication is implied by this source lock.

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
binary. Runtime daemon start invokes its `daemon` entrypoint directly; the
upstream `ao start` desktop download/open path is outside this contract.

## Deterministic managed bootstrap

Run the formal entrypoint from a clone or installed package:

```bash
./scripts/bootstrap.sh --json
```

The bootstrap:

1. validates the runtime lock and `runtime/go-toolchain.lock.json`;
2. fetches only the locked annotated tag from the public fork into an isolated
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
node ./bin/ao-pilot.js start --project my-project
node ./bin/ao-pilot.js status --project my-project --json
node ./bin/ao-pilot.js stop --project my-project
```

The doctor reports source/version/commit/tree/integrity, compatibility, exact
binary path/digest, shadowing, and GitHub/Codex auth availability without
retaining command output or secrets. A missing, changed, incompatible, or
shadowed runtime blocks lifecycle execution.

`npm run verify:runtime-lifecycle` checks the static exact-binary routing
contract. `npm run verify:fresh-clone` is the separate P0-R07 live integration
gate: exact clone, empty HOME, install, bootstrap, offline replay/reinstall,
hostile PATH rejection, provenance-aware doctor, daemon start/status/stop, and
bounded local worktree cleanup. It uses local/fake credential boundaries and
therefore does not prove a GitHub Worker delivery or workstation self-hosting.
Those remain exclusively gated by the P0-R08 receipt and manual workflow.
