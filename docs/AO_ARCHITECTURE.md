# AO Architecture

`ao-pilot` is a generic AI coding agent control plane. It observes agent and
source-control state, reconciles conflicting evidence, applies conservative
policy gates, records durable state, and supports recovery and review.

The project complements an agent runtime. It does not own terminal sessions,
worktree creation, or model execution itself.

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

## Safety Posture

Unknown or contradictory evidence fails closed. Observe and shadow modes do not
execute workflow actions. Assist mode is limited by explicit policy decisions
and an action allowlist.
