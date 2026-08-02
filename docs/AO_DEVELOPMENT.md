# AO Development

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- `curl`, `tar`, and `gzip` for runtime bootstrap
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
npm run verify:runtime-lifecycle
npm run verify:fresh-clone
```

`verify:package` proves package-level portability only;
`verify:runtime-lock` proves the offline runtime identity contract, while
`verify:runtime-bootstrap` validates the toolchain lock and packaged entrypoint.
The explicit `bootstrap.sh` invocation performs installation. None of these
package/bootstrap verification commands starts an OR or Worker. P0-R06
lifecycle paths can be inspected with `node ./bin/ao-pilot.js runtime-path
--json`; lifecycle execution fails closed on missing, changed, incompatible,
or shadowed runtime state.

Run `npm run verify:runtime-lifecycle` after changing runtime-aware doctor,
observation, start/stop/status, or `scripts/ao/start-clean.sh`. The managed
start path launches the locked binary's `daemon` command directly and must not
be replaced with upstream's desktop acquisition command named `ao start`.

Run `npm run verify:fresh-clone` after changing bootstrap, runtime resolution,
provenance, lifecycle, or release workflows. It is an integration gate: it
creates a temporary exact clone with empty HOME, performs a real pinned runtime
build and daemon smoke, and removes the bounded state afterward. Use
`--cache <path>` to reuse only the verified source/toolchain/module cache.

`npm run verify:self-hosting -- --receipt <path>` is not a developer mock. It
validates the protected P0-R08 receipt and must remain blocked until a newly
bootstrapped AO on a different workstation creates and delivers issue #63.

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
