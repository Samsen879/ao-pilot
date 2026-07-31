# Phase 3 — Canonical Package Boundary

## Source-of-truth rule

`ao-pilot` owns every generic control-plane contract, persistence primitive, reconciliation/lifecycle/policy engine, provider boundary, controller workflow, review/handoff/checkpoint protocol, metrics/evaluation implementation, CLI facade and generic test fixture.

`ciecopilot-home` owns only CIE configuration and adapters: 9709 manifest/domain validation, CIE repository knowledge/prompts/paths, workflow governance, operational policy selection and domain Skills. It must not contain a second implementation of generic state/lifecycle/controller logic.

```text
external agent-orchestrator / GitHub / command runtime
                         |
                         v
               ao-pilot public package
  CLI + contracts + repository + engines + protocols + providers
                         ^
                         |
       ciecopilot-home config / workflow / 9709 adapters
```

## Public npm boundary

The package has one executable and explicit ESM exports:

| Export | Responsibility | Compatibility rule |
|---|---|---|
| `ao-pilot` | supported aggregate library entry | only documented/re-exported generic API; no CIE type |
| `ao-pilot/cli` | unified CLI and named CLI runner aliases | process-independent test/integration seam |
| `ao-pilot/contracts` | state, reconciliation, lifecycle, review and runtime contracts | durable/semantic contracts, not filesystem internals |
| `ao-pilot/repository` | state repository/storage/checkpoint APIs | generic persistence boundary |
| `ao-pilot/engines` | reconciliation, doctor, lifecycle, policy and transition pure logic | accepts data/config, no CIE constants |
| `ao-pilot/protocols` | handoff, review, continuity/decision protocols | generic coordination semantics |
| `ao-pilot/providers` | command runner and runtime/source-control adapters | injectable/fakeable external-effect boundary |
| `ao-pilot/package.json` | package metadata | tooling only |

`package.json#main` points to `./lib/index.js`; `exports` allow only the entries above. Unlisted `scripts/ao/lib/**` paths remain private even if they are physically packaged.

The CLI module provides `runAoPilotCli`, `runInitCli` and named aliases for the twelve CIE-used commands (`runControllerCli`, `runDoctorCli`, `runEvalCli`, `runHandoffCli`, `runKnowledgeCli`, `runLifecycleCli`, `runManageCli`, `runMetricsCli`, `runOverrideCli`, `runReconcileCli`, `runReviewCli`, `runStateCli`). Each public subpath is imported from an isolated installed tarball during package verification, preventing accidental success through a source-tree relative import.

## Canonical module map

| Generic capability | Canonical AO location | CIE remainder |
|---|---|---|
| CLI dispatch/config | `bin/ao-pilot.js`, `lib/cli.js`, `scripts/ao/lib/config.js` | npm aliases and `ao.config.json` |
| domain/state contracts | `lib/contracts.js`, internal state/continuity/lifecycle/review/runtime contracts | no duplicate; 9709 schemas remain separate |
| persistence/migrations/locks | `lib/repository.js`, internal repository/storage/checkpoint/migrations | project identity/config only; historical state retained |
| pure decisions | `lib/engines.js`, internal reconciliation/doctor/lifecycle/policy/transition engines | operational policy selection, no engine copy |
| controller/application workflow | installed CLI + internal controller loop | `agent-orchestrator.yaml` process adapter |
| review/handoff/recovery | `lib/protocols.js` and CLI | CIE governance text and domain handoff content |
| provider effects | `lib/providers.js`, command runner, GitHub adapter, blocked-notification transport | endpoint/credentials external to Git; CIE no-merge default |
| metrics/evaluation | AO metrics/eval/scorecard/replay | CIE may invoke package CLI; no copied eval core |
| repository knowledge | AO parser/linter/contracts | CIE knowledge document/template values |
| 9709 validation | none | CIE Python validator/workflow/tests only |

## Adapter interfaces and policy

External effects are passed through provider interfaces, never inferred from an action template alone:

```text
action proposal
  -> policy permits/denies action kind
  -> injected command runner or notification transport
  -> effect receipt (intent, args/cwd, provider result)
  -> durable status
```

`state_only` means no provider effect was intended. A provider-effect action is confirmed only with a success receipt. A disabled or missing provider leaves the action proposed; confirmed failures carry kind-specific retryability, while an ambiguous dispatched irreversible effect remains `attempted`, non-retryable and replay-blocked. Fake providers are the mandatory test adapter.

The generic lifecycle engine accepts a release-ready action policy. Default is `notify_human_ready`. `auto_merge_ready_pr` remains a supported generic mechanism only for an explicit consumer opt-in with exact-head evidence. CIE does **not** opt in during this migration because `agent-orchestrator.yaml` rows C7 and the approved-and-green trigger outcome explicitly require decide-only/no merge.

## CIE package consumption model

For this local two-repository consolidation, CIE declares the sibling package explicitly (`file:../ao-pilot`) and commits its lockfile change. Verification uses two independent paths:

1. AO is packed to a `.tgz` and installed into an isolated temporary consumer; all public imports/CLI/runtime assets are exercised without the AO source tree.
2. CIE is tested in a fresh sibling layout and against the exact packed artifact. The governed worktree’s nested physical path is an implementation detail and must not change the declared root-level sibling relation.

The future release-safe substitution is a published semver of the same package API. Changing `file:../ao-pilot` to that immutable published version must not require CIE source changes. Until the local consolidation commits are published, a single-repository CI checkout must also checkout the sibling AO revision or install the exact packed artifact. The current CIE AO workflow has no `ref`, so it resolves remote AO `origin/main` (`ba362622…`, package 0.1.0 without public exports), not this canonical local line; that release blocker is explicit rather than hidden by deep imports.

## Compatibility and deprecation

- CIE keeps npm script names such as `ao:doctor` so workflow/preflight contracts remain stable, but their command body invokes the installed package.
- Direct `node scripts/ao-*.js` and imports from `scripts/ao/lib/**` are forbidden after cutover.
- No permanent source compatibility shim is planned for the duplicate generic tree. A shim is acceptable only if a caller cannot be safely moved before the deletion gate; it must be listed in the manifest with a removal blocker.
- CIE’s `scripts/ao/start-clean.sh` is an agent-orchestrator operational adapter, not generic AO core, and remains.
- CIE’s `scripts/ao/validate_9709_active_issue_manifest_v1.py` remains at its current domain path for workflow compatibility.

## State location and identity

Canonical default storage stays `.ao-control-plane/<project-id>` under the repository root discovered from the invocation cwd. CIE config pins `project_id` to `ciecopilot-home`. Operational AO commands must be invoked from the CIE root (the path configured in `agent-orchestrator.yaml`), not an arbitrary governed implementation worktree, because Git worktrees have distinct top-level roots. Consolidation tests use temporary repositories and never migrate or edit live CIE state.

The unified CLI must carry the configured project identity even for PR-scoped doctor/lifecycle/reconcile calls; tests guard against silently falling back to `my-project`.

## Deletion plan and order

1. Land package exports and packed-install contract.
2. Land generic effect capability and explicit receipt semantics.
3. Establish deterministic parity/recovery harness.
4. Declare CIE dependency/config; switch npm/YAML/workflow/process callers.
5. Add CIE consumer and boundary tests using public imports only.
6. Prove zero production caller/deep import/hidden-script references.
7. Remove top-level embedded CLI facades, generic `scripts/ao/lib/**`, copied generic fixtures/tests/smoke.
8. Retain only CIE adapters/domain validator and add static no-reintroduction guard.
9. Run packed/fresh-install, both focused suites, parity/recovery and repository-level gates; document rollback.

If any step before 7 fails, deletion stops and a compatibility shim is retained. No caller is allowed to “pass” merely because an old test still exercises the deleted implementation.
