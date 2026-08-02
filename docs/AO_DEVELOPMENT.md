# AO Development

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- `curl` and `tar` for runtime bootstrap
- `gh`, authenticated when live GitHub observation is required
- the package-managed runtime when live agent observation is required

Do not satisfy the final bullet with an arbitrary PATH binary, an npm package
whose provenance is unknown, or a hidden HOME checkout. `npm ci`, `npm test`,
and `verify:package` exercise the control-plane package only. The immutable
[runtime lock and bootstrap](AO_RUNTIME.md) establish deterministic identity,
retrieval, build, installation, and resolution. The incident and dependency
inventory remain recorded in
[P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

## Clean Install

```bash
npm ci
npm test
./scripts/bootstrap.sh --json
```

Install the command locally and create a project configuration:

```bash
npm link
ao-pilot init --project my-project
ao-pilot state --json
```

Run the focused acceptance suite:

```bash
npm run ao:test:acceptance
```

Run the fixture-backed operator smoke:

```bash
npm run ao:smoke
```

Verify the actual npm tarball in an isolated install directory:

```bash
npm run verify:package
npm run verify:runtime-lock
npm run verify:runtime-bootstrap
```

`verify:package` proves package-level portability only;
`verify:runtime-lock` proves the offline runtime identity contract, while
`verify:runtime-bootstrap` validates the toolchain lock and packaged entrypoint.
The explicit `bootstrap.sh` invocation performs installation. None of these
starts an OR or Worker.

Run the complete release candidate gate:

```bash
npm run release:check
```

See [AO Release](AO_RELEASE.md) for second-machine verification, tagging, and
the explicitly authorized npm publication flow.

Run the bundled evaluation suite:

```bash
ao-pilot eval --pack all
```

Run project-owned packs with stronger replay:

```bash
ao-pilot eval --fixture-root ./eval --pack smoke --replay-count 3
```

## Change Discipline

Keep migrations deterministic and file based. Add tests for every state or
controller behavior change. Do not add repository-specific policy or product
knowledge to the generic core.
