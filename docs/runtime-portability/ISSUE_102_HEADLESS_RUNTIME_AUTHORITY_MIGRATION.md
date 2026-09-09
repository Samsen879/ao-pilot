# Issue #102 headless runtime authority migration

## Decision

`ao-pilot` is the sole fetch and execution authority for its managed runtime.
The former `Samsen879/agent-orchestrator` fork remains historical provenance
only and is no longer required by bootstrap, installation, or runtime use.

## Immutable source

- repository: `https://github.com/Samsen879/ao-pilot.git`
- tag: `ao-pilot-headless-runtime-v0.11.2-p0.4`
- annotated tag object: `7947c3ac8787576bce0d5d7627c8020e95643bef`
- source commit: `43d37ef2a76e1949c8032c49c5e6197d98bf0b96`
- source tree: `91282c19b408935e94d732e8e10699d393f3c821`
- Linux x64 binary SHA-256: `45d257d19810cb606917ce734ec281c16617b0ec0088591e3cea909c27868919`
- Linux arm64 binary SHA-256: `2b2025e9aaf3fd8799fa6c5ed149118f15d8d62e56123c3fa13c70c7c3ea3ffe`

The tag points to a `git subtree split` of `runtime/headless`, so fetching the
runtime does not fetch the full control-plane repository. The source retains
the upstream Apache-2.0 license and exact import provenance.

## Desktop boundary

The source subtree has no frontend, Electron, AppImage, installer, or desktop
packaging paths. The upstream `ao start` resolver/downloader/launcher was
replaced with a command that always exits nonzero. Static verification rejects
known desktop acquisition symbols, paths, stale recovery guidance, and any
unreviewed change to the exact fail-closed implementation. The fresh-clone
release gate executes the SHA-256-verified locked binary's `start` command in
an isolated filesystem/network posture, requires exit 1 with the admitted
error, and rejects any filesystem mutation.

## Reproducible validation

On 2026-09-09, a new empty store and cache fetched the tagged source from
`Samsen879/ao-pilot`, downloaded the SHA-256-locked Go 1.25.7 archive, built the
runtime, and returned `status: installed` plus internal `status: verified`.
A second empty store rebuilt with `--offline` from that new cache. Both x64
binaries were byte-identical at the locked digest. Direct execution of
`ao start` returned exit 1 with `desktop entrypoint disabled`.

Required repeatable gates are:

- `npm run verify:runtime-lock`
- `npm run verify:headless-runtime-source`
- focused runtime-lock/source-boundary tests
- `npm run verify:package`
- fresh online bootstrap into an empty store/cache
- offline rebuild into a second empty store
- full repository and lifecycle release gates before merge

## Rollback and retirement

The p0.2 lock and historical receipts remain in Git history. Rollback is a
normal revert of the migration commit while the old immutable tag remains
available. The old fork must not be archived or deleted until the merged-main
replay proves no current lock/bootstrap reference and obsolete PRs/branches
have been closed or removed.
