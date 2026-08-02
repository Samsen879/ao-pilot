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
gate. P0-R05 owns public retrieval, source-object verification, managed-store
installation, and provenance materialization.

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
- admitted platform scope: Linux `x64` and `arm64`
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
- the installed binary SHA-256;
- the exact compatibility contract.

The deterministic resolver requires an explicit managed-store root and derives
the runtime directory from the runtime ref and commit SHA. It does not search
`PATH` as an installation mechanism. It fails closed on:

- absent or malformed managed provenance;
- an unknown repository or mutable ref;
- version, tag, commit, tree, or integrity mismatch;
- a missing, non-executable, or modified binary;
- incompatible ao-pilot, OS, or architecture versions;
- a different executable named `ao` appearing first on `PATH`.

The final item makes shadowing visible and prevents accidental fallback to a
same-name package. Lifecycle commands added by P0-R06 must invoke only the
verified absolute managed binary path returned by this resolver.

## Boundary with later P0 gates

This contract establishes deterministic identity and resolution. It does not
yet install Go, clone/build the runtime, create the managed provenance file,
start the OR, or prove self-hosting. Those claims remain gated by P0-R05 through
P0-R08.
