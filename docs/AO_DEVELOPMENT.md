# AO Development

## Prerequisites

- Node.js 20 or newer
- npm
- Git
- `gh`, authenticated when live GitHub observation is required
- an `ao` compatible runtime when live agent observation is required

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

## Change Discipline

Keep migrations deterministic and file based. Add tests for every state or
controller behavior change. Do not add repository-specific policy or product
knowledge to the generic core.
