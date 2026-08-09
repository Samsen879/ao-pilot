# Release judgment vocabulary migration

Issue #20 advances lifecycle output from `ao.lifecycle.v1alpha1` to
`ao.lifecycle.v1alpha2` and defines `ao.release-judgment.v1`.

## Current contract

`release_ready` is an AO judgment. It authorizes the Agent Orchestrator to begin
its own fresh release preflight. Its authority scope is exactly
`or_preflight_only`, and its machine-readable claims are all false for merge,
external effect, and human approval.

The associated lifecycle action has class `release_judgment` and no commands.
Persisting or executing that durable action records AO control state only. A
provider observation remains the sole authority for an external merge outcome.
Execution fails closed unless the persisted decision matches the v1 contract,
scope, basis, authority, and all three non-claims. The new action class advances
controller-run and execution-attempt measurement records from v1alpha1 to
v1alpha2; legacy measurement records retain their original schema identifiers.

## Compatibility and immutable legacy interpretation

| Source value | Source meaning | Observation behavior | Finding |
| --- | --- | --- | --- |
| `release_ready` | Current AO judgment | Read directly | none |
| `notify_human_ready` | Legacy notification request | Preserve the source decision and expose a separate, observation-only `release_ready` vocabulary projection with the complete legacy source interpretation attached | `legacy_notify_human_ready_deprecated` |
| `auto_merge_ready_pr` | Legacy irreversible effect request | Preserve as a distinct legacy effect request; never relabel it as `release_ready` | `legacy_auto_merge_ready_pr_deprecated` |

Adapters clone their inputs. They do not rewrite lifecycle reports, delivery
events, action records, audit history, or persisted control-plane state.
Deprecation findings are informational so mixed-version replay and unattended
delivery continue without turning vocabulary age into a control blocker.
Malformed current judgments are not repaired by observation: their original
values remain visible and a blocking `release_ready_contract_invalid` finding
records the mismatch. Legacy projections are explicitly non-authoritative.

## Decision and effect boundary

The decision chain and lifecycle renderer consume the observation adapter. A
legacy notification therefore renders its original disposition plus
`observed_as=release_ready`; the projection has `observation_only` scope and
cannot expand legacy authority. The source schema, disposition, basis, action,
and immutable/deprecated markers remain intact. The current `release_ready`
action contains no GitHub merge command and does not invoke the legacy
auto-merge executor.

GitHub merge, TaskSpec vNext, the later `human_gate` split, and removal of all
historical wording are outside this migration.
