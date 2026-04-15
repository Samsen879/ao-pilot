<p align="center">
  <h1 align="center">ao-pilot</h1>
  <p align="center">
    <strong>An autonomous control plane for AI coding agents</strong>
  </p>
  <p align="center">
    Observe → Reason → Decide → Act → Recover → Verify
  </p>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#why-ao-control-plane">Why</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#cli-reference">CLI</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## What Is This?

**AO Control Plane** is a heavily extended fork of [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) that transforms a lightweight agent scheduler into a **full autonomous control plane** for managing fleets of AI coding agents.

Where the original AO acts as a dispatcher (spawn agent → route feedback → notify human), AO Control Plane implements a **Kubernetes-style control loop**: continuously observing, reasoning, deciding, acting, recovering, and verifying — pulling humans in only when genuine judgment is needed.

### Original AO vs AO Control Plane

| Capability | Original AO | AO Control Plane |
|---|:---:|:---:|
| Spawn agent sessions (tmux) | ✅ | ✅ |
| Git worktree isolation | ✅ | ✅ |
| CI failure → route to agent | ✅ | ✅ |
| Review comments → route to agent | ✅ | ✅ |
| **Autonomous control loop** | ❌ | ✅ |
| **Persistent state machine** | ❌ | ✅ |
| **Lifecycle engine** (trigger → decision → action) | ❌ | ✅ |
| **Reconciliation engine** (AO state vs GitHub truth) | ❌ | ✅ |
| **Diagnostics engine** (full health checks) | ❌ | ✅ |
| **Handoff protocol** (death → diagnose → recover) | ❌ | ✅ |
| **State transition engine** (formal transition rules) | ❌ | ✅ |
| **Evaluation framework** (harness + scorecard) | ❌ | ✅ |
| **Decision chain reasoning** (matrix-driven) | ❌ | ✅ |
| **Checkpoint + recovery** | ❌ | ✅ |
| **Code review protocol** (read-write separation) | ❌ | ✅ |
| **Policy engine** (configurable behavior rules) | ❌ | ✅ |
| **Run metrics + measurement taxonomy** | ❌ | ✅ |

> **TL;DR** — Original AO = `cron + webhook router`. AO Control Plane = `Kubernetes control loop for coding agents`.

---

## Why AO Control Plane?

Running one AI agent in a terminal is easy. Running many across different issues, branches, and PRs is a **coordination problem**. The original AO handles basic dispatching well, but in production you quickly hit:

1. **Agents get stuck with no automatic recovery** — AO Control Plane provides continuity contracts, checkpoint recovery, and handoff protocols
2. **No audit trail for decisions** — Every decision flows through a formal decision chain with full traceability
3. **State drift** — The reconciliation engine continuously compares AO's internal state against GitHub's ground truth, correcting inconsistencies automatically
4. **No structured code review** — The review protocol separates implementation and reviewer sessions with read-write isolation
5. **No evaluation framework** — The eval harness and scorecard provide quantitative measurement of agent performance

---

## Quick Start

### Prerequisites

- [Node.js 20+](https://nodejs.org)
- [Git 2.25+](https://git-scm.com)
- [tmux](https://github.com/tmux/tmux/wiki/Installing) — `brew install tmux` (macOS) or `sudo apt install tmux` (Linux)
- [GitHub CLI](https://cli.github.com) — `gh auth login` must be completed

### Install

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
npm install
```

### Run the Controller

```bash
# Single pass — observe, reason, decide, then exit
node scripts/ao-controller.js --holder my-session --project my-project

# Continuous mode — keep the control loop running
node scripts/ao-controller.js --holder my-session --project my-project --continuous

# Observe-only (no mutations)
node scripts/ao-controller.js --holder my-session --mode observe

# Target a specific issue
node scripts/ao-controller.js --holder my-session --issue 42
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        AO Control Plane                         │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Observation │  │    Event     │  │   Decision Chain       │ │
│  │   Sources    │→ │   Ingest     │→ │   (Matrix-Driven)      │ │
│  └─────────────┘  └──────────────┘  └───────────┬────────────┘ │
│                                                  │              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────▼────────────┐ │
│  │  GitHub      │  │ Lifecycle    │  │   Controller Loop      │ │
│  │  Observation │→ │ Engine       │→ │ (Observe→Decide→Act)   │ │
│  │  Source      │  │              │  │                        │ │
│  └─────────────┘  └──────────────┘  └───────────┬────────────┘ │
│                                                  │              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────▼────────────┐ │
│  │   Policy     │  │Reconciliation│  │   Action Executor      │ │
│  │   Engine     │→ │   Engine     │→ │ (with Policy Gates)    │ │
│  └─────────────┘  └──────────────┘  └───────────┬────────────┘ │
│                                                  │              │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────▼────────────┐ │
│  │ Checkpoint   │  │  Handoff     │  │   State Repository     │ │
│  │ Store        │  │  Protocol    │  │ (Persistent + Audited) │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
│                                                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Diagnostics │  │   Review     │  │   Eval Harness +       │ │
│  │  (Doctor)    │  │   Protocol   │  │   Scorecard            │ │
│  └─────────────┘  └──────────────┘  └────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘

         Persistent State (.ao-pilot/)
         ├── state.json        # Full control plane state
         ├── schema.json       # Schema version + migrations
         ├── audit/            # Append-only audit trail
         ├── checkpoints/      # Task checkpoint snapshots
         └── handoffs/         # Handoff request/claim/transfer
```

### Core Engines

| Engine | Purpose | Size |
|--------|---------|------|
| **Controller Loop** | Main observe → reason → decide → act loop with lease-based leadership | 56 KB |
| **State Contracts** | Normalized, validated data structures for the entire control plane | 49 KB |
| **Eval Harness** | Automated evaluation of agent runs with configurable scenarios | 42 KB |
| **Lifecycle Engine** | Deterministic trigger → decision → action reasoning chain | 29 KB |
| **State Repository** | Atomic read/write with file-level locking and migration support | 27 KB |
| **Diagnostics Engine** | Full git/worktree/AO/GitHub health checks | 25 KB |
| **Reconciliation Engine** | AO internal state vs GitHub ground truth auto-correction | 24 KB |
| **Handoff Protocol** | Worker death → diagnose → checkpoint → recover/replace/escalate | 22 KB |
| **Transition Engine** | Formal state transition rules and validation | 22 KB |
| **Action Executor** | Executes proposed actions with policy gate enforcement | 22 KB |
| **Manage Runner** | Task CRUD, PR binding, ownership lease management | 18 KB |
| **Run Metrics** | Quantitative measurement of controller runs | 15 KB |
| **Policy Engine** | Configurable rules governing orchestration behavior | 13 KB |
| **Repo Knowledge** | Scan and lint repository knowledge files | 14 KB |
| **Scorecard** | Agent performance scoring and grading | 13 KB |
| **State Storage** | Low-level JSON persistence with atomic writes | 13 KB |
| **State Migrations** | Schema evolution across control plane versions | 13 KB |
| **Checkpoint Store** | Task interruption checkpoints for recovery | 12 KB |
| **Debt Report** | Automated technical debt auditing and tracking | 12 KB |
| **Continuity** | Stuck/exit/needs-input formal detection and recovery | 10 KB |
| **Review Protocol** | Independent reviewer sessions with read-write separation | 8 KB |
| **Decision Chain** | Matrix-driven trigger → decision → action chains | 6 KB |

---

## CLI Reference

AO Control Plane provides **12 specialized CLIs**, each focused on one concern:

### `ao-controller` — The Control Loop

```bash
# Run one control loop pass
node scripts/ao-controller.js --holder <id> [--project <id>] [--mode observe|shadow|assist]

# Continuous operation
node scripts/ao-controller.js --holder <id> --continuous [--poll-interval-ms 30000]

# Options:
#   --project <id>             Project identifier (default: my-project)
#   --controller <id>          Controller identity (default: default)
#   --holder <id>              Required. Durable holder identity
#   --mode <observe|shadow|assist>  Controller mutation mode
#   --issue <number>           Focus on a specific issue
#   --continuous               Keep running until SIGINT/SIGTERM
#   --poll-interval-ms <ms>    Poll interval in continuous mode (default: 30000)
#   --json                     Machine-readable JSON output
```

### `ao-manage` — Task Management

```bash
node scripts/ao-manage.js <command> [options]

# Commands: create, list, bind-pr, retire, ...
```

### `ao-lifecycle` — Lifecycle Reasoning

```bash
node scripts/ao-lifecycle.js --holder <id> [--issue <number>]
```

### `ao-reconcile` — State Reconciliation

```bash
node scripts/ao-reconcile.js --holder <id> [--project <id>]
```

### `ao-doctor` — Diagnostics

```bash
node scripts/ao-doctor.js [--project <id>] [--json]
```

### `ao-handoff` — Worker Handoff

```bash
node scripts/ao-handoff.js <command> [options]
```

### `ao-review` — Code Review Protocol

```bash
node scripts/ao-review.js <command> [options]
```

### `ao-eval` — Evaluation Harness

```bash
node scripts/ao-eval.js [options]
```

### `ao-state` — State Inspection

```bash
node scripts/ao-state.js [--project <id>] [--json]
```

### `ao-metrics` — Run Metrics

```bash
node scripts/ao-metrics.js [--project <id>]
```

### `ao-override` — Override Management

```bash
node scripts/ao-override.js <command> [options]
```

### `ao-knowledge` — Repository Knowledge

```bash
node scripts/ao-knowledge.js [options]
```

---

## How It Works

### The Control Loop

The core of AO Control Plane is a **continuous control loop** inspired by Kubernetes controllers:

```
┌────────────────── CONTROL LOOP ──────────────────┐
│                                                    │
│  1. ACQUIRE LEADERSHIP (lease-based)               │
│     └─ Prevents duplicate controllers              │
│                                                    │
│  2. OBSERVE                                        │
│     ├─ Poll AO internal state                      │
│     ├─ Poll GitHub (PRs, checks, reviews)          │
│     └─ Merge into unified observation set          │
│                                                    │
│  3. INGEST EVENTS                                  │
│     ├─ Deduplicate delivery events                 │
│     ├─ Classify into families (PR/check/review)    │
│     └─ Map to lifecycle triggers                   │
│                                                    │
│  4. REASON (per task)                              │
│     ├─ Run reconciliation (AO vs GitHub truth)     │
│     ├─ Run lifecycle engine (trigger → decision)   │
│     ├─ Run diagnostics (health checks)             │
│     ├─ Evaluate decision chain                     │
│     └─ Check continuity contracts                  │
│                                                    │
│  5. DECIDE                                         │
│     ├─ Propose actions based on reasoning          │
│     ├─ Pass through policy engine                  │
│     └─ Record policy decisions                     │
│                                                    │
│  6. ACT (if mode = assist)                         │
│     ├─ Execute allowed actions                     │
│     ├─ Block denied actions                        │
│     └─ Record execution results                    │
│                                                    │
│  7. PERSIST                                        │
│     ├─ Update state atomically                     │
│     ├─ Append audit entries                        │
│     └─ Renew controller lease                      │
│                                                    │
│  (repeat if --continuous)                          │
└────────────────────────────────────────────────────┘
```

### Controller Modes

| Mode | Observes | Reasons | Proposes Actions | Executes Actions |
|------|:--------:|:-------:|:----------------:|:----------------:|
| `observe` | ✅ | ✅ | ❌ | ❌ |
| `shadow` | ✅ | ✅ | ✅ | ❌ |
| `assist` | ✅ | ✅ | ✅ | ✅ |

### Matrix-Driven Decisions

Instead of hardcoded if-else reactions, AO Control Plane uses a **three-layer matrix system**:

```yaml
# Layer 1: Chain Matrix — formal contract rules (C0-C11)
AO_PHASE2_CHAIN_MATRIX

# Layer 2: Workflow Matrix — engineering process rules (W0-W11)
AO_WORKFLOW_MATRIX

# Layer 3: Trigger Matrix — event → decision chain mapping
AO_TRIGGER_MATRIX[approved-and-green] =
  preflight:C0+C1               # Calibrate with GitHub truth
  | entry:C2(trigger=xxx)        # Enter lifecycle engine
  | inspect:C3+C11               # Check decision chain + review gate
  | drilldown:C4,C5              # Reconcile + diagnose
  | outcome:hold_or_notify       # Output decision
```

This produces **auditable, traceable, extensible** decision records.

### Reconciliation

The reconciliation engine continuously compares AO's internal state against GitHub's ground truth:

> "When AO says a PR is still failing CI, but GitHub shows CI has passed — **GitHub wins.**"

This prevents state drift, duplicate work, and stale notifications.

### Worker Continuity

When an agent dies, the system doesn't just notify a human:

```
Agent dies → Diagnose why → Check if recoverable →
  → Try checkpoint recovery → If failed, spawn successor →
    → If still failed, escalate to human
```

### Code Review Protocol

Implementation and review are **structurally separated**:

- **Implementation session**: Read-write access, makes code changes
- **Reviewer session**: Read-only independent session, evaluates changes against verification baseline

---

## Project Structure

```
scripts/
├── ao-controller.js          # Main control loop CLI
├── ao-doctor.js              # Diagnostics CLI
├── ao-eval.js                # Evaluation harness CLI
├── ao-handoff.js             # Handoff protocol CLI
├── ao-knowledge.js           # Repo knowledge CLI
├── ao-lifecycle.js           # Lifecycle engine CLI
├── ao-manage.js              # Task management CLI
├── ao-metrics.js             # Run metrics CLI
├── ao-override.js            # Override management CLI
├── ao-reconcile.js           # Reconciliation CLI
├── ao-review.js              # Code review protocol CLI
├── ao-state.js               # State inspection CLI
└── ao/
    └── lib/
        ├── controller-loop.js          # Core control loop
        ├── state-contracts.js          # Data structure contracts
        ├── state-repository.js         # Atomic state persistence
        ├── state-storage.js            # Low-level storage
        ├── state-migrations.js         # Schema evolution
        ├── lifecycle-engine.js         # Lifecycle reasoning
        ├── lifecycle-contracts.js      # Lifecycle data types
        ├── reconciliation-engine.js    # State reconciliation
        ├── reconciliation-contracts.js # Reconciliation types
        ├── doctor-engine.js            # Health diagnostics
        ├── doctor-contracts.js         # Diagnostics types
        ├── handoff-protocol.js         # Worker handoff
        ├── transition-engine.js        # State transitions
        ├── action-executor.js          # Action execution
        ├── event-ingest.js             # Event ingestion
        ├── decision-chain.js           # Decision chains
        ├── policy-engine.js            # Policy evaluation
        ├── review-protocol.js          # Code review
        ├── eval-harness.js             # Eval framework
        ├── scorecard.js                # Performance scoring
        ├── checkpoint-store.js         # Checkpoint persistence
        ├── continuity.js               # Continuity detection
        ├── run-metrics.js              # Run measurement
        ├── measurement-taxonomy.js     # Metric taxonomy
        ├── repo-knowledge.js           # Knowledge management
        ├── debt-report.js              # Tech debt tracking
        └── ...                         # 52 modules total

tests/ao/                     # 68 test files, ~18,000 lines
```

## Code Stats

| Dimension | Value |
|-----------|-------|
| Core library modules | **52** |
| CLI entry points | **12** |
| Core code lines | **~22,000** |
| Test files | **68** |
| Test lines | **~18,000** |
| Total | **~40,000 lines** |

---

## Testing

```bash
# Run all AO tests
npx vitest run tests/ao/

# Run a specific test file
npx vitest run tests/ao/controller-loop.test.js

# Watch mode
npx vitest tests/ao/
```

68 test files covering all core engines with ~18,000 lines of test code.

---

## Configuration

AO Control Plane uses an `agent-orchestrator.yaml` configuration file:

```yaml
# agent-orchestrator.yaml
port: 3000
defaults:
  runtime: tmux
  agent: claude-code
  workspace: worktree

projects:
  my-project:
    repo: owner/repo
    path: ~/my-project
    defaultBranch: main

    reactions:
      ci-failed:
        auto: true
        action: send-to-agent
        retries: 2
      changes-requested:
        auto: true
        action: send-to-agent
        escalateAfter: 30m
      approved-and-green:
        auto: false
        action: notify
```

---

## Acknowledgments

AO Control Plane is built on top of [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) (MIT License). The original project provides the foundational agent spawning, worktree isolation, and feedback routing that this project extends with autonomous control-plane capabilities.

## License

[MIT](LICENSE) — same as the original agent-orchestrator.

---

<p align="center">
  <sub>Based on <a href="https://github.com/ComposioHQ/agent-orchestrator">agent-orchestrator</a> by ComposioHQ (MIT License)</sub>
</p>
