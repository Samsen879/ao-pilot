# Issue #102 headless runtime authority migration

## Decision

`ao-pilot` is the sole fetch and execution authority for its managed runtime.
The former `Samsen879/agent-orchestrator` fork remains historical provenance
only and is no longer required by bootstrap, installation, or runtime use.

## Immutable source

- repository: `https://github.com/Samsen879/ao-pilot.git`
- tag: `ao-pilot-headless-runtime-v0.11.2-p0.3`
- annotated tag object: `5389a01a13c50c510af326165797eb7774a1ba62`
- source commit: `6d9168b244600bb14629c6545d667429ad81b981`
- source tree: `4e92c96cef54ffd9ed28d041a391294249e605db`
- Linux x64 binary SHA-256: `d122f25278537945ea21356df7a6ac28c2d66c27009c645380dac46f97c2a71d`
- Linux arm64 binary SHA-256: `4fdc3fa31a44a04d70e28dd291440ef93532342f707c6d47eaef3c079fdfa626`

The tag points to a `git subtree split` of `runtime/headless`, so fetching the
runtime does not fetch the full control-plane repository. The source retains
the upstream Apache-2.0 license and exact import provenance.

## Desktop boundary

The source subtree has no frontend, Electron, AppImage, installer, or desktop
packaging paths. The upstream `ao start` resolver/downloader/launcher was
replaced with a command that always exits nonzero. Static verification rejects
known desktop acquisition symbols and paths before release.

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
