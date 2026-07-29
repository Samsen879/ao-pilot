<p align="center">
  <h1 align="center">ao-pilot</h1>
  <p align="center">
    <strong>Experimental control-plane tooling for AI-assisted coding workflows</strong>
  </p>
  <p align="center">
    Observe → Reconcile → Decide → Recover → Verify
  </p>
</p>

<p align="center">
  <a href="#what-is-this">What Is This?</a> •
  <a href="#why-this-exists">Why</a> •
  <a href="#quick-start">Quick Start</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#cli-reference">CLI</a> •
  <a href="#current-status">Status</a>
</p>

---

## What Is This?

**ao-pilot** is an independently maintained control-plane companion for
[ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
and compatible AI coding-agent runtimes.

The original project provides a lightweight way to run and coordinate AI coding
agents. `ao-pilot` adds a separate control-plane layer around that workflow:
task state, PR reconciliation, ownership, handoff, recovery, diagnostics,
policy gates, and evaluation.

This repository packages those control-plane capabilities as a standalone,
file-based Node.js tool. It remains conservative and experimental, but its
installation, configuration, tests, and CLI are maintained independently from
any downstream product repository.

The core question behind this project is:

> How can AI-assisted coding work stay auditable, recoverable, and reviewable when agents are working across multiple tasks?

## Why This Exists

Running one AI coding agent in a terminal is relatively easy. The harder problem starts when there are multiple issues, branches, worktrees, PRs, CI results, and review threads.

Without a control layer, several problems appear quickly:

1. A worker session may stop without leaving enough recovery context.
2. A PR can become stale while local state still assumes it is active.
3. CI and review state can drift away from what the agent believes happened.
4. Multiple sessions can accidentally overlap ownership of the same task.
5. Automation can become hard to audit if actions are not tied to explicit decisions.
6. A human operator may lose track of which tasks are blocked, ambiguous, or ready for review.

**ao-pilot** experiments with ways to make those states visible, durable, and recoverable.

The goal is not to remove human judgment. The goal is to make the automation boundary clearer.

## Relationship to the Original Project

This repository is a companion to `ComposioHQ/agent-orchestrator`, not a copy of
its session runtime.

The original AO project focuses on agent orchestration primitives such as
spawning sessions, routing feedback, and coordinating work. This companion
project adds experimental control-plane layers around:

- persistent task state;
- ownership and handoff;
- PR / CI / review reconciliation;
- lifecycle reasoning;
- diagnostics;
- policy decisions;
- review separation;
- checkpoints and recovery;
- evaluation and scorecards.

Some implementation details may still reflect the original project structure. That is expected.

## Current Status

This repository is currently an **experimental prototype**.

What is reasonably implemented:

- CLI tools for controller runs, task management, reconciliation, lifecycle checks, diagnostics, handoff, state inspection, overrides, and knowledge inspection.
- Persistent state contracts for tasks, ownership leases, controller leases, handoffs, checkpoints, review records, actions, overrides, and policy decisions.
- A reconciliation model for comparing AO state with GitHub-facing PR / CI / review state.
- Lifecycle and diagnostic checks for blocked, ambiguous, orphaned, stale, or review-dependent work.
- Handoff and checkpoint concepts for recovering interrupted agent sessions.
- Acceptance tests for several representative lifecycle scenarios.
- Deterministic evaluation packs, bounded metrics, scorecards, and baseline gates.

What is not guaranteed:

- Stable public API.
- Production deployment safety.
- Complete documentation for external users.
- Compatibility with every AI coding workflow.
- Clean separation from every assumption in the original project.
- A polished installation or onboarding experience.

In other words: this repo is a working lab for control-plane ideas, not a finished product.

## What The Control Plane Adds

Compared with the original AO runtime, this project experiments with the
following areas:

| Area | What the control plane explores |
|---|---|
| Task state | Durable task records, PR bindings, ownership leases, lifecycle status |
| Reconciliation | Comparing local AO state with GitHub PR / CI / review state |
| Recovery | Checkpoints, handoff requests, successor claims, stale-worker detection |
| Diagnostics | Doctor-style checks for blocked, ambiguous, orphaned, or stale work |
| Review flow | Separation between implementation and review-oriented sessions |
| Policy | Explicit decision points before automation is allowed to mutate state |
| Evaluation | Replay-stable scenarios, metrics windows, scorecards, and baseline gates |
| Auditability | Machine-readable state, decision records, and run metrics |

These pieces are intentionally conservative. The preferred failure mode is to mark work as `blocked` or `ambiguous`, rather than allowing automation to continue based on unclear state.

## Design Principles

The project is built around a few assumptions:

- Prefer explicit state over hidden session memory.
- Prefer `blocked` or `ambiguous` over unsafe automatic progress.
- Keep human review gates visible.
- Treat GitHub PR / CI / review state as a source of truth during reconciliation.
- Make handoff and recovery durable instead of relying only on conversation history.
- Let automation propose or assist, but keep policy boundaries clear.
- Keep machine-readable output available for debugging and audit trails.

## Quick Start

### Prerequisites

- Node.js 20+
- npm
- Git
- tmux
- GitHub CLI (`gh`)
- A repository/workflow where AO-style agent sessions are expected to operate

Make sure GitHub CLI is authenticated:

```bash
gh auth login
```

### Install

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
npm install
```

For a reproducible install after the lockfile is present:

```bash
npm ci
```

Link the unified CLI and create a project configuration:

```bash
npm link
ao-pilot init --project my-project
```

### Run Tests

```bash
npm test
```

If you only want to run the AO acceptance tests:

```bash
npm run ao:test:acceptance
```

### Run the Controller

Single pass:

```bash
ao-pilot controller --holder my-session
```

Continuous mode:

```bash
ao-pilot controller --holder my-session --continuous
```

Observe-only mode:

```bash
ao-pilot controller --holder my-session --mode observe
```

Target a specific issue:

```bash
ao-pilot controller --holder my-session --issue 42
```

The project id is read from `ao.config.json`. A command-level `--project`
option overrides it. Most commands support `--json` for machine-readable
output, and the original `node scripts/ao-*.js` entrypoints remain compatible.

## Architecture

At a high level, `ao-pilot` is organized around a control loop:

```text
┌──────────────────────────────────────────────────────────────┐
│                          ao-pilot                            │
│                                                              │
│  Observation Sources                                         │
│  ├─ AO state                                                  │
│  ├─ GitHub PR state                                           │
│  ├─ CI/check state                                            │
│  └─ Review state                                              │
│          │                                                    │
│          ▼                                                    │
│  Event Ingest                                                 │
│          │                                                    │
│          ▼                                                    │
│  Reconciliation                                               │
│  ├─ local AO state                                             │
│  ├─ GitHub-facing truth                                        │
│  └─ drift / ambiguity detection                                │
│          │                                                    │
│          ▼                                                    │
│  Lifecycle / Diagnostics                                      │
│  ├─ blocked                                                    │
│  ├─ ambiguous                                                  │
│  ├─ stale                                                      │
│  ├─ orphaned                                                   │
│  └─ ready / needs review                                       │
│          │                                                    │
│          ▼                                                    │
│  Decision + Policy Gates                                      │
│          │                                                    │
│          ▼                                                    │
│  Action Proposal / Assisted Execution                         │
│          │                                                    │
│          ▼                                                    │
│  Persistent State + Audit Trail                               │
└──────────────────────────────────────────────────────────────┘
```

The control loop does not assume that automation should always act. Depending on mode and policy, it may only observe, propose, block, or escalate.

## Controller Modes

| Mode | Observes | Reasons | Proposes Actions | Executes Actions |
|---|:---:|:---:|:---:|:---:|
| `observe` | ✅ | ✅ | ❌ | ❌ |
| `shadow` | ✅ | ✅ | ✅ | ❌ |
| `assist` | ✅ | ✅ | ✅ | ✅ |

The separation is intentional:

- `observe` is useful for diagnostics and understanding state.
- `shadow` is useful for seeing what the system would do without mutating state.
- `assist` allows permitted actions to execute through policy gates.

## CLI Reference

The project provides several focused CLI entry points.

### `ao-controller`

Runs the main control loop.

```bash
node scripts/ao-controller.js --holder <id> [options]
```

Common options:

```bash
--project <id>                 Project identifier
--controller <id>              Controller identity
--holder <id>                  Durable holder identity
--mode observe|shadow|assist   Controller mutation mode
--issue <number>               Focus on a specific issue
--continuous                   Keep running until stopped
--poll-interval-ms <ms>        Poll interval in continuous mode
--shutdown-timeout-ms <ms>     Shutdown grace bound
--json                         Machine-readable JSON output
```

Examples:

```bash
node scripts/ao-controller.js --holder dev-session --mode observe
node scripts/ao-controller.js --holder dev-session --mode shadow --json
node scripts/ao-controller.js --holder dev-session --mode assist --continuous
```

### `ao-reconcile`

Compares AO state with GitHub-facing state.

```bash
node scripts/ao-reconcile.js [options]
```

Examples:

```bash
node scripts/ao-reconcile.js --project my-project
node scripts/ao-reconcile.js --pr 42 --json
node scripts/ao-reconcile.js --pr 42 --json --strict
```

Use this when you want to know whether AO state agrees with PR, branch, CI, and review state.

### `ao-doctor`

Runs diagnostic checks.

```bash
node scripts/ao-doctor.js [options]
```

Examples:

```bash
node scripts/ao-doctor.js --project my-project
node scripts/ao-doctor.js --pr 42 --json
node scripts/ao-doctor.js --pr 42 --json --strict
```

Use this to surface blocked, ambiguous, orphaned, stale, or otherwise unhealthy work.

### `ao-lifecycle`

Inspects lifecycle state and readiness.

```bash
node scripts/ao-lifecycle.js [options]
```

Examples:

```bash
node scripts/ao-lifecycle.js --project my-project
node scripts/ao-lifecycle.js --pr 42 --json
node scripts/ao-lifecycle.js --pr 42 --json --strict
```

Use this to inspect whether a task or PR has enough continuity, CI, and review evidence to move forward.

### `ao-manage`

Manages task lifecycle records.

```bash
node scripts/ao-manage.js <command> [options]
```

Supported commands include:

```text
enroll
adopt
resume
unmanage
retire
```

Example:

```bash
node scripts/ao-manage.js enroll \
  --project my-project \
  --issue 42 \
  --title "Fix failing parser test" \
  --branch feat/fix-parser-test \
  --worktree ../worktrees/fix-parser-test
```

### `ao-handoff`

Handles successor-session handoff.

```bash
node scripts/ao-handoff.js <command> [options]
```

Supported commands include:

```text
request
claim
accept
reject
expire
inspect
```

Examples:

```bash
node scripts/ao-handoff.js request \
  --project my-project \
  --issue 42 \
  --successor-session next-worker

node scripts/ao-handoff.js inspect \
  --project my-project \
  --issue 42 \
  --json
```

### `ao-state`

Inspects persistent AO state.

```bash
node scripts/ao-state.js --project my-project
node scripts/ao-state.js --project my-project --json
```

### `ao-override`

Manages explicit overrides.

```bash
node scripts/ao-override.js <command> [options]
```

Overrides are intended for controlled operator intervention, not as a replacement for fixing state.

### `ao-knowledge`

Inspects repository knowledge files and related metadata.

```bash
node scripts/ao-knowledge.js --project my-project
node scripts/ao-knowledge.js --project my-project --json
```

## How It Works

### 1. Observe

The controller reads available state from AO and GitHub-facing sources.

Typical observed inputs include:

- active tasks;
- ownership leases;
- PR bindings;
- GitHub PR status;
- branch/head state;
- CI checks;
- review decisions;
- handoff records;
- checkpoints.

### 2. Reconcile

The reconciliation engine compares local AO state with external state.

For example:

- If AO believes a PR is failing but GitHub shows passing checks, the stale AO view should not be blindly trusted.
- If a task has no valid owner but still has an open PR, it may be marked as orphaned.
- If local state and GitHub state disagree in a way that cannot be safely resolved, the result should become ambiguous.

### 3. Diagnose

The doctor and lifecycle logic classify work into states such as:

- healthy;
- blocked;
- ambiguous;
- stale;
- orphaned;
- review-pending;
- ready for next action.

This is meant to make operator decisions easier, not to hide them.

### 4. Decide

The decision layer maps observed state and diagnostics into possible actions.

Examples:

- continue observing;
- request human review;
- mark work as blocked;
- propose a handoff;
- recover from checkpoint;
- notify a session;
- hold until CI or review changes.

### 5. Act

In `assist` mode, allowed actions can be executed through policy gates.

In `observe` and `shadow` modes, the system should avoid mutating state directly.

### 6. Persist

State changes are written into the persistent AO state model, with audit-oriented records where applicable.

## Persistent State

The project uses a local persistent state model for control-plane records.

Conceptually, it includes:

```text
tasks
ownership leases
controller leases
PR bindings
actions
policy decisions
handoff requests
handoff claims
handoff transfers
checkpoints
review records
run metrics
audit entries
```

The exact schema is still experimental and may change.

## Testing

Run the default test suite:

```bash
npm test
```

Run AO acceptance tests:

```bash
npm run ao:test:acceptance
```

Run the bundled generic evaluation suite:

```bash
ao-pilot eval --pack all
```

See [AO Evaluation](docs/AO_EVALUATION.md) for project-owned packs, replay,
metrics windows, scorecards, and baselines.

Release candidates use `npm run release:check`. See
[AO Release](docs/AO_RELEASE.md) for the second-machine checklist, tagging, and
npm publication boundary.

The acceptance tests cover representative situations such as:

- clean PR continuity;
- failed CI;
- approved and green PRs;
- orphaned ownership;
- stale worker ownership;
- cross-source disagreement between AO and GitHub state.

## Project Structure

The exact structure may change, but the important areas are:

```text
scripts/
  ao-controller.js        Main controller loop CLI
  ao-reconcile.js         State reconciliation CLI
  ao-doctor.js            Diagnostics CLI
  ao-lifecycle.js         Lifecycle inspection CLI
  ao-manage.js            Task management CLI
  ao-handoff.js           Handoff CLI
  ao-state.js             State inspection CLI
  ao-override.js          Override CLI
  ao-knowledge.js         Repository knowledge CLI

scripts/ao/lib/
  controller-loop.js      Main control loop implementation
  state-contracts.js      State contract definitions
  reconciliation-*.js     Reconciliation contracts, runner, engine
  doctor-*.js             Diagnostic contracts, runner, engine
  lifecycle-*.js          Lifecycle contracts and engine
  handoff-*.js            Handoff protocol
  checkpoint-*.js         Checkpoint storage and recovery concepts
  policy-*.js             Policy evaluation
  action-*.js             Action proposal/execution
  run-metrics.js          Measurement and run summaries
  eval-harness.js         Generic eval orchestration
  eval/                    Catalog, replay, and built-in scenario runners
  scorecard.js             Eval scorecards and baseline comparison

tests/
  ao/                     AO-specific acceptance and unit tests
```

## Intended Use

This repo is mainly useful if you are interested in:

- AI-assisted software engineering;
- coding-agent orchestration;
- PR-based automation;
- recovering interrupted agent sessions;
- making agent workflows auditable;
- designing conservative automation gates;
- thinking about state machines around AI coding tools.

It is probably not the right tool if you want:

- a plug-and-play production agent platform;
- a polished SaaS-style product;
- a stable public API;
- a fully documented contributor experience;
- an agent that can safely operate without human review.

## Development Notes

This project intentionally keeps many concepts explicit:

- task IDs;
- owner sessions;
- controller leases;
- PR bindings;
- decision records;
- policy decisions;
- handoff records;
- checkpoint records;
- diagnostic findings.

That makes the system more verbose, but also easier to inspect when something goes wrong.

The current codebase may still contain rough edges, old assumptions, and names inherited from the original AO project. Those are part of the prototype status.

## Contributing

Contributions are welcome, but please treat this repository as experimental.

Useful contribution areas include:

- clearer documentation;
- smaller examples;
- better tests;
- simpler setup;
- bug fixes in CLI behavior;
- improved diagnostics;
- safer default policies;
- clearer state transition rules.

Before making large architectural changes, opening an issue first is recommended.

## License

MIT License.

See [LICENSE](./LICENSE).
