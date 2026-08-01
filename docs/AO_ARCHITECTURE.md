# AO Architecture

`ao-pilot` is a generic AI coding agent control plane. It observes agent and
source-control state, reconciles conflicting evidence, applies conservative
policy gates, records durable state, and supports recovery and review.

The project complements an agent runtime. It does not own terminal sessions,
worktree creation, or model execution itself.

## P0 Operational Portability Boundary

The package/control-plane boundary and the external runtime boundary are
different. `ao-pilot@0.2.0` can be packed and installed, but it does not yet
lock, install, resolve, authenticate, start, or stop a publicly retrievable
Agent Orchestrator runtime. The P0 recovery lane therefore treats the complete
system as three explicit layers:

```text
public immutable Agent Orchestrator runtime
  -> ao-pilot control and judgment layer
  -> repository-specific configuration, policy, and adapters
```

Until P0-R08 proves this stack on a fresh workstation, an arbitrary PATH `ao`,
an old HOME checkout, and package-only verification are not runtime authority.
See [the incident baseline](runtime-portability/P0-R01_INCIDENT_BASELINE.md).

## Control Loop

1. Observe the configured agent runtime and source-control provider.
2. Normalize observations into stable records.
3. Reconcile durable state with current external evidence.
4. Diagnose blocked, ambiguous, stale, or review-dependent work.
5. Evaluate policy before proposing or executing an action.
6. Persist state, decisions, checkpoints, handoffs, reviews, and metrics.

## Evaluation Boundary

The evaluation framework separates:

- pack and scenario catalog validation;
- built-in AO scenario runners;
- caller-supplied runner registration;
- deterministic replay and fingerprinting;
- metrics aggregation;
- scorecard generation, scope comparison, and quality gates.

Installed packages carry a small public eval pack. Downstream repositories may
point configuration at their own pack root without adding domain logic to the
generic control plane.

## Boundaries

- Runtime providers expose agent-session observations and capabilities.
- Source-control providers expose pull-request, check, and review observations.
- External commands run through an injectable command-runner boundary.
- File-based state remains the default persistence model.
- Repository policy and verification commands are configuration, not core code.
- Domain-specific product workflows belong in downstream repositories.

## Public Package Boundary

Downstream repositories consume only the declared ESM exports:

- `ao-pilot/cli`
- `ao-pilot/contracts`
- `ao-pilot/repository`
- `ao-pilot/engines`
- `ao-pilot/protocols`
- `ao-pilot/providers`

The internal `scripts/ao/lib/**` layout is not a compatibility contract. Package
verification installs the tarball in an isolated consumer, imports every public
subpath, and proves an undeclared deep import is rejected.

## External Effect Contract

Durable state and provider effects are different observables:

- `durable_only` records a control-plane transition and does not claim a remote
  command or notification occurred;
- `attempted` is persisted before a provider call;
- `succeeded` requires a provider receipt and live confirmation where available;
- `failed` remains retryable only when the failure is known not to have produced
  an ambiguous remote result.

The effect-status vocabulary is exactly `durable_only`, `attempted`, `succeeded`,
and `failed`. An unconfirmed in-flight effect is represented separately by
`execution.outcome=effect_attempted` with `effect.status=attempted`; it is not a
fifth status and is not automatically replayed.

This release has no claim-resolution CLI or public API. Recovery therefore starts
with a live provider-state check, followed by a deliberate, audited manual repair
of durable state under the consuming repository's operator procedure. That gap is
explicit: callers must not clear the claim or retry an irreversible effect merely
because the provider result is unknown. Notification transports receive a stable
idempotency key and use an at-least-once contract.

`auto_merge_ready_pr` is an irreversible remote effect. It is disabled by the
conservative lifecycle default and requires explicit durable authorization bound
to the expected head SHA. Execution re-reads live PR/review/check state, rejects
unknown or unstable status, passes `--match-head-commit`, and confirms the merged
head afterward. TaskSpec `independent_review` gates require a current-head passing
review before such an action can be proposed.

## Safety Posture

Unknown or contradictory evidence fails closed. Observe and shadow modes do not
execute workflow actions. Assist mode is limited by explicit policy decisions
and an action allowlist. The default release-ready action is
`notify_human_ready`, not automatic merge.
