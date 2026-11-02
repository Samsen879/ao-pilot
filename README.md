<p align="center">
  <h1 align="center">ao-pilot</h1>
  <p align="center">
    <strong>A control plane for running AI coding agents in parallel</strong>
  </p>
  <p align="center">
    Observe → Reconcile → Decide → Recover → Verify
  </p>
</p>

<p align="center">
  <a href="#what-it-does">What It Does</a> •
  <a href="#in-practice">In Practice</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#cli">CLI</a> •
  <a href="#status">Status</a>
</p>

---

## What It Does

Running one AI coding agent in a terminal is easy. Running several at once — each on its own issue, branch, worktree and PR, with CI and code review in the loop — is where things start to drift. Sessions stop without leaving recovery context, PRs go stale while local state still thinks they are active, two sessions pick up the same task, and nobody can say afterwards why an automated action happened.

**ao-pilot** is the layer that keeps that work coherent. It sits on top of [agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) (AO), which spawns and coordinates the agent sessions, and adds:

- **durable task state** — tasks, ownership leases, PR bindings, handoffs and checkpoints that survive any single session;
- **reconciliation** — continuous comparison of what AO believes against what GitHub actually shows for PRs, CI and reviews;
- **lifecycle diagnostics** — classifying work as healthy, blocked, ambiguous, stale, orphaned or ready for review;
- **recovery** — successor handoff and checkpoint resume when a worker session dies mid-task;
- **policy gates and audit records** — every automated action is tied to an explicit decision;
- **evaluation** — replayable scenarios, metrics and scorecards to check that changes actually make the system better.

When sources disagree in a way that cannot be resolved safely, ao-pilot marks the work `blocked` or `ambiguous` and surfaces it, rather than letting automation continue on a guess.

## In Practice

ao-pilot is used every day to develop a separate (private) product repository:

- An **orchestrator session** (referred to as the *OR* throughout the docs) drives a chain of related issues.
- **Worker sessions** implement each issue on its own branch and worktree and open a PR.
- An **independent reviewer session** reviews each PR; corrections loop back to the worker, usually over several rounds.
- Once review passes, the OR merges.

ao-pilot observes and judges throughout — which tasks are healthy, which are stuck, which sessions need a successor — while the OR keeps the authority to act. Run this way, the system works unattended overnight and has carried more than 100 issues, across dozens of parent-issue chains, from issue to merged PR.

## Quick Start

**Platform:** Linux x64/arm64, including WSL2. Windows-native runtime is not supported.

### Prerequisites

- Node.js 20+ (the unified release launchers need Node ≥ 22.15)
- npm, Git, tmux
- `curl`, `tar` and `gzip` for the checksummed Go toolchain bootstrap
- GitHub CLI (`gh`), authenticated with `gh auth login`
- A repository where AO-style agent sessions will operate

### Install

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
npm ci
```

Bootstrap the pinned AO runtime into a content-addressed managed store:

```bash
./scripts/bootstrap.sh --json
```

The bootstrap builds the exact locked runtime source and never uses an `ao` found on `PATH`; it refuses to continue if one would shadow the managed binary. See [AO Runtime](docs/AO_RUNTIME.md) for paths, offline mode, reinstall and recovery, and [Unified installation](docs/AO_UNIFIED_INSTALL.md) for packaged releases with systemd services and rollback.

### Run

```bash
npm link
ao-pilot init --project my-project   # writes ao.config.json

ao-pilot doctor --json               # runtime provenance, auth availability, unhealthy work
ao-pilot start                       # start the managed runtime daemon
ao-pilot status --json
ao-pilot dashboard                   # localhost-only browser dashboard

ao-pilot controller --holder my-session --mode observe
```

`doctor` reports whether GitHub and Codex credentials are available but never prints probe output or the credentials themselves.

### Test

```bash
npm test                         # unit and integration suite
npm run ao:test:acceptance       # lifecycle acceptance scenarios
ao-pilot eval --pack all         # bundled evaluation packs
```

## Architecture

ao-pilot is organised around a control loop:

```text
┌──────────────────────────────────────────────────────────────┐
│                          ao-pilot                            │
│                                                              │
│  Observation Sources                                         │
│  ├─ AO state                                                 │
│  ├─ GitHub PR state                                          │
│  ├─ CI/check state                                           │
│  └─ Review state                                             │
│          │                                                   │
│          ▼                                                   │
│  Event Ingest                                                │
│          │                                                   │
│          ▼                                                   │
│  Reconciliation                                              │
│  ├─ local AO state                                           │
│  ├─ GitHub-facing truth                                      │
│  └─ drift / ambiguity detection                              │
│          │                                                   │
│          ▼                                                   │
│  Lifecycle / Diagnostics                                     │
│  ├─ blocked                                                  │
│  ├─ ambiguous                                                │
│  ├─ stale                                                    │
│  ├─ orphaned                                                 │
│  └─ ready / needs review                                     │
│          │                                                   │
│          ▼                                                   │
│  Decision + Policy Gates                                     │
│          │                                                   │
│          ▼                                                   │
│  Action Proposal / Assisted Execution                        │
│          │                                                   │
│          ▼                                                   │
│  Persistent State + Audit Trail                              │
└──────────────────────────────────────────────────────────────┘
```

1. **Observe** — read active tasks, ownership leases, PR bindings, branch heads, CI checks, review decisions, handoff records and checkpoints.
2. **Reconcile** — compare local AO state with GitHub. If AO thinks a PR is failing but GitHub shows green checks, the stale local view loses. A task with an open PR but no valid owner becomes *orphaned*. A disagreement that cannot be resolved safely becomes *ambiguous*.
3. **Diagnose** — classify each task: healthy, blocked, ambiguous, stale, orphaned, review-pending, or ready for its next action.
4. **Decide** — map the diagnosis to an action: keep observing, refresh stale observations, retry bounded recovery, request review, propose a handoff, resume from a checkpoint, notify a session, or hold until CI or review changes.
5. **Act** — in `assist` mode, permitted actions execute through policy gates.
6. **Persist** — write state changes and decision records to the durable state model.

### Controller modes

| Mode | Observes | Reasons | Proposes actions | Executes actions |
|---|:---:|:---:|:---:|:---:|
| `observe` | ✅ | ✅ | ❌ | ❌ |
| `shadow` | ✅ | ✅ | ✅ | ❌ |
| `assist` | ✅ | ✅ | ✅ | ✅ |

`shadow` shows what the system would do without changing anything, which makes it the natural way to trial a new policy before enabling it.

### Durable state

Control-plane records live in a local, file-based state model:

```text
tasks · ownership leases · controller leases · PR bindings
actions · policy decisions · handoff requests / claims / transfers
checkpoints · review records · run metrics · audit entries
```

The schemas are still evolving; versioned JSON Schemas for the stable contracts are in [`schemas/`](schemas).

### Design principles

- Explicit state over hidden session memory.
- `blocked` or `ambiguous` over unsafe automatic progress.
- GitHub PR / CI / review state is the source of truth during reconciliation.
- Handoff and recovery are durable, not reconstructed from conversation history.
- Observing and acting are separated: ao-pilot judges, the orchestrator holds merge authority.
- Machine-readable output everywhere, for debugging and audit.

## CLI

All commands are subcommands of `ao-pilot`; most accept `--project <id>` (default: from `ao.config.json`) and `--json`. Run `ao-pilot <command> --help` for full options.

| Area | Commands |
|---|---|
| Control loop | `controller` |
| Diagnostics | `doctor`, `reconcile`, `lifecycle`, `state`, `metrics` |
| Task management | `manage`, `handoff`, `review`, `override`, `knowledge` |
| Runtime | `start`, `stop`, `status`, `runtime-path`, `runtime-project-get`, `runtime-contract`, `upgrade`, `restore` |
| Sessions & messages | `session`, `send`, `ack` |
| Tooling | `init`, `dashboard`, `eval`, `execution`, `publication-preflight` |

Common examples:

```bash
# Control loop: single pass, continuous, or focused on one issue
ao-pilot controller --holder dev-session --mode shadow --json
ao-pilot controller --holder dev-session --mode assist --continuous
ao-pilot controller --holder dev-session --issue 42

# Does AO state agree with the PR's branch, CI and review state?
ao-pilot reconcile --pr 42 --json --strict

# Is there enough continuity, CI and review evidence to move forward?
ao-pilot lifecycle --pr 42 --json

# Enroll an issue as a managed task
ao-pilot manage enroll --issue 42 --title "Fix failing parser test" \
  --branch feat/fix-parser-test --worktree ../worktrees/fix-parser-test

# Hand a task to a successor session
ao-pilot handoff request --issue 42 --successor-session next-worker

# Check Git publication identity and credentials without pushing or changing config
ao-pilot publication-preflight --expected-repository owner/repo \
  --expected-principal github-login --worker-principal github-login --json
```

### Library API

The supported ESM entrypoints are `ao-pilot`, `ao-pilot/cli`, `ao-pilot/contracts`, `ao-pilot/repository`, `ao-pilot/engines`, `ao-pilot/protocols`, `ao-pilot/providers`, `ao-pilot/authority` and `ao-pilot/execution`:

```js
import { createStateRepository } from 'ao-pilot/repository';
import { reconcileObservations, runControllerLoop } from 'ao-pilot/engines';
import { createLocalCommandRunner } from 'ao-pilot/providers';
```

Paths outside `package.json#exports` intentionally fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Status

ao-pilot is at **v0.2.0** and runs a real development workflow every day (see [In Practice](#in-practice)), but it is a single-maintainer project rather than a general-purpose product:

- The declared library exports and CLI are maintained; internals under `scripts/` may change without notice.
- Documentation is written for the maintainer's workflow first; onboarding for other setups is still thin.
- It assumes human review stays in the loop and is not designed to operate without it.

See the [CHANGELOG](CHANGELOG.md) for release history.

### P0 Runtime Portability Incident

Installing the package and running it on a fresh workstation are verified separately. The package-level portability claim (`npm ci`, `npm run verify:package`) is accepted; runtime bootstrap is covered by an empty-HOME fresh-clone gate (`npm run verify:fresh-clone`); full new-workstation self-hosting is still awaiting its receipt. Details are in the [P0-R01 incident baseline](docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md) and [AO Runtime](docs/AO_RUNTIME.md).

## Repository Layout

```text
bin/ao-pilot.js        Unified CLI entrypoint
lib/                   Public ESM entrypoints (package.json#exports)
scripts/               CLI command implementations
scripts/ao/lib/        Engines: controller loop, reconciliation, lifecycle,
                       doctor, handoff, checkpoints, policy, actions, eval
schemas/               Versioned JSON Schemas for stable contracts
dashboard/             Localhost dashboard front end
browser/               Imported upstream dashboard source (see browser/SOURCE_IMPORT.json)
integrations/          Dashboard native adapter
runtime/               Runtime locks and the vendored headless AO runtime source
templates/             Example config, systemd units, tmux layouts
docs/                  Architecture, runtime, release, evaluation and design notes
tests/ao/              Unit, integration and acceptance tests
```

## Relationship to agent-orchestrator

[agent-orchestrator](https://github.com/Untrivial-ai/agent-orchestrator) (formerly `ComposioHQ/agent-orchestrator`) provides the session runtime: spawning agent sessions, routing feedback and coordinating work. ao-pilot is maintained independently and adds the control plane described above. To make installs reproducible it also vendors two pieces of upstream code:

- [`runtime/headless/`](runtime/headless/ORIGIN.md) — a reduced copy of the upstream Go runtime, pinned to an exact commit, with the desktop launcher replaced by a fail-closed command;
- [`browser/`](browser/SOURCE_IMPORT.json) — the upstream browser dashboard source, imported byte-for-byte with a hash manifest.

## Contributing

Issues and PRs are welcome. For larger architectural changes, please open an issue first. Useful areas include clearer docs, smaller examples, simpler setup, better diagnostics and safer default policies.

## License

ao-pilot is released under the [MIT License](LICENSE). Vendored upstream code keeps its original license: [`runtime/headless/`](runtime/headless/LICENSE.upstream) is Apache-2.0, and [`browser/`](browser/LICENSE) is MIT.
