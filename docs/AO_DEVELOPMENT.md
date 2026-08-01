# AO Development

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- `gh`, authenticated when live GitHub observation is required
- an `ao` compatible runtime when live agent observation is required

The final bullet is not currently a reproducible installation contract. During
the P0 recovery, do not satisfy it with an arbitrary PATH binary, an npm package
whose provenance is unknown, or a hidden HOME checkout. `npm ci`, `npm test`,
and `verify:package` exercise the control-plane package only. The incident and
dependency inventory are recorded in
[P0-R01](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

## Clean Install

```bash
npm ci
npm test
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
```

This proves package-level portability only. It does not install or run an
Agent Orchestrator daemon, OR, or Worker.

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
