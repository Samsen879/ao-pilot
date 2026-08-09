# Retry, refresh, and authority-escalation migration

Issue #21 advances new lifecycle reports to `ao.lifecycle.v1alpha3` and defines
`ao.intervention-judgment.v1`. The migration separates evidence recovery from
human authority. It does not change the provider implementation or grant new
authority.

## Current judgments

| Observation | Judgment | Automated posture | Human gate |
| --- | --- | --- | --- |
| Provider/source failure, including provider 5xx | `retry_required` | Record bounded recovery for the affected scope | No |
| Missing PR assessment or stale observation | `refresh_required` | Require a new observation; cached evidence is insufficient | No |
| Doctor, ownership, release, review, or scope authority ambiguity | `escalation_required` | Pause the affected scope only | Yes |

`retry_required` carries the complete deterministic recovery envelope: three
attempts using exponential backoff at 1000, 2000, and 4000 milliseconds. The
envelope is auditable and requires a fresh observation after exhaustion. AO
records the judgment and does not execute an unbounded retry loop. A later
controller pass cannot treat exhaustion, timeout, or provider failure as human
approval.

`refresh_required` requires a new observation and explicitly rejects a cached
observation. It covers both an absent PR assessment and source health marked
`degraded`. Neither case emits the blocked-human notification action.

`escalation_required` is reserved for unresolved authority ambiguity. Its
`affected_scope` identifies one project or PR scope and its pause contract is
`affected_scope_only`. The controller processes other active tasks normally.

## Immutable legacy mapping

Lifecycle v1alpha1/v1alpha2 reports are cloned for observation and never
rewritten in storage, delivery events, audit history, or replay inputs. When an
old `human_gate` or `source_failure` release decision has a recognized basis,
the observation adapter adds a non-authoritative projection:

| Legacy basis | Observation projection |
| --- | --- |
| `source_failure` | `retry_required` |
| `missing_pr_assessment` | `refresh_required` |
| `doctor_ambiguous`, `ownership_ambiguous`, `release_readiness_ambiguous`, `review_escalated`, `trigger_requires_pr_scope` | `escalation_required` |

The projection retains the source disposition, basis, authority flag, and
immutable/deprecated markers. Unknown legacy bases are not guessed or silently
expanded into authority escalation.

## Metrics taxonomy

Controller-run and execution-attempt measurement records advance to
v1alpha3; aggregate metrics reports advance to v1alpha3. Legacy v1alpha1 and
release-judgment v1alpha2 identifiers remain exported for replay.

- Action classes add `retry`, `refresh`, and `escalation`.
- Intervention counts add `retry_required`, `refresh_required`, and
  `escalation_required`.
- Retry causes distinguish `source_recovery` and `observation_refresh`.
- Failure classes retain `source_failure` and add `missing_evidence` and
  `authority_ambiguity`; these are measurement classifications, not provider
  outcomes.

The fixture pack at
`tests/ao/fixtures/intervention-dispositions/pack.v1.json` covers source
failure, missing assessment, doctor ambiguity, release ambiguity, success,
failure, missing evidence, and deterministic replay. The controller regression
also proves an escalated PR does not pause an unrelated active task.
