# Phase 1 — Full AO Inventory

本 inventory 由 tracked-file enumeration、symbol/import search、CLI/process caller search、test-name search、Git blob comparison 和 recent history inspection 共同生成；没有把目录名或 README 当成唯一证据。

## Scale and coverage

| Surface | `ao-pilot` initial tree | CIE embedded tree at `a670ecf…` |
|---|---:|---:|
| AO-related tracked files | 197 | embedded implementation 及其 tests/docs/config 均已枚举 |
| JavaScript implementation files | 152 in the AO product surface | 61 generic implementation files / 19,506 LOC under `scripts/ao/**`, plus one 212-line operator-smoke runner (62 files / 19,718 LOC total), 12 top-level CLI facades and 3 workflow/support callers outside the embedded core |
| Jest tests | 69 files / 320 baseline tests | 75 Jest files plus one domain Python test; 331 embedded AO cases |
| Fixtures | 32 | 32 shared/historically copied fixtures |
| AO CLI commands | 13 (`init` included) | 12 (`init` absent) |
| AO-specific docs | standalone product and operator docs | 13 embedded AO docs plus repository-wide workflow docs |

Across same-path source and test files, 58 blobs were byte-identical and 98 paths had drift. Within `scripts/ao` production source specifically, 41 blobs were exact matches and 21 same-path files differed; seven production modules were AO-only and two were CIE-only. This disproves both “完全独立实现” and “可以整目录覆盖” models.

## Module inventory

“State/effects” describes observable behavior, not merely function names. “Tests” names the primary oracle; adjacent CLI/report tests are included by the path glob even when not repeated in every row.

| Repository / path | Primary responsibility and public entrypoint | Main callers / dependencies | State read-write and external effects | Tests / docs | Domain assumptions / applicability / maturity |
|---|---|---|---|---|---|
| AO `bin/ao-pilot.js`, `scripts/ao-{init,reconcile,doctor,lifecycle,state,knowledge,manage,handoff,override,controller,review,metrics,eval}.js` | CLI facade; `package.json#bin` exposes `ao-pilot` | npm scripts, operators; dispatches to runners below | reads config/repository state; provider effects only through invoked runner | `tests/ao/ao-*-cli.test.js`, `ao-pilot-cli.test.js`, acceptance | generic; AO has `init`, richer eval/metrics and config wiring; mature CLI but initial package lacked library API |
| Both `scripts/ao/lib/state-contracts.js`, `state-migrations.js` | durable entity/schema contracts; current schema v10 | repository, reports, controller, lifecycle, tests | validates/normalizes state; migrations transform earlier JSON schemas | `state-contracts.test.js`, `state-migrations.test.js` | generic and exact blob-identical; no schema-version drift found |
| Both `state-storage.js`, `state-repository.js`, `state-repository/collections.js`, `checkpoint-store.js` | filesystem persistence, collection CRUD, checkpoint storage | state runner, controller, handoff, metrics | writes `.ao-control-plane/<project-id>` JSON/JSONL with file locks/atomic replacement | storage/repository/collection/checkpoint tests | generic and exact-identical; worktree-relative `repoRoot` creates collision/isolation risk when operational cwd changes |
| Both `ao-observation-source.js`, `github-observation-source.js` | ingest local AO status and GitHub observations | reconcile, doctor, controller | local reads; GitHub command runner read calls; malformed evidence fails closed | observation-source tests and acceptance fixtures | generic; AO version has stronger injectable provider/config seams |
| Both `reconciliation-{contracts,engine,report,runner}.js` | derive canonical observed task/PR/ownership state | CLI, doctor, controller, acceptance | pure reconciliation plus persistence/audit in runner; external provider is read-only | reconciliation tests, `controller-shadow-parity.test.js` | engine is exact-identical; runner/report structure differs without core semantic drift |
| Both `doctor-{contracts,engine,local-state-source,report,runner}.js` | diagnostics and strict exit policy | CLI, workflow preflight, operators | reads state/GitHub; emits findings; no production mutation | doctor tests, acceptance | generic engine; CIE report/config embeds repository expectations |
| Both `lifecycle-{contracts,engine,report}.js`, `gate-model.js`, `transition-engine.js`, `policy-{engine,rules}.js` | lifecycle, gate and policy decisions; propose actions | CLI/controller | pure decisions; proposed actions persisted/executed later | lifecycle/gate/policy/transition tests | generic core mixed with one CIE operational policy: CIE chooses `auto_merge_ready_pr`, AO chooses conservative `notify_human_ready` |
| Both `action-executor.js`; CIE-only `blocked-notification-transport.js` | assist-mode action execution and receipt persistence | controller loop | AO initial implementation marked actions `executed` while only changing durable state; CIE additionally invokes `gh pr view/merge` and optional webhook for two action kinds | `action-executor.test.js`, controller policy tests | generic effect mechanisms missing in standalone; CIE-specific default/endpoint configuration must not become universal policy |
| Both `event-ingest.js` | delivery/review/provider-event normalization and deduplication | controller-loop delivery triggers | appends/deduplicates durable events; no direct external effect | `event-ingest.test.js`, controller-loop tests | generic; release-ready action hint drift follows lifecycle policy drift |
| Both `controller-loop.js` and `controller-loop/{constants,delivery-triggers,lease-helpers,review-inspection,shutdown,time}.js` | lease/heartbeat, observe→reconcile→decide→act loop, shutdown/recovery | `ao-controller.js` | acquires controller lease, reads/writes task/action/review/checkpoint state; delegates external commands | controller loop/helper/gating/state tests | core blob is exact-identical; AO has more explicit injectable command runner/runtime provider boundaries |
| Both `continuity*.js`, `decision-chain*.js`, `runtime-contracts.js`, `runtime-preflight.js`, `task-spec.js`, `issue-intake.js` | continuity/resume, decision-chain integrity, TaskSpec/intake, runtime admission | controller, manage, handoff, workflow integration | state validation and checkpoints; preflight may execute provider read commands | corresponding contract/engine tests | generic contracts; CIE repository knowledge and issue templates remain adapters/configuration |
| Both `handoff-protocol.js`, `review-{contracts,protocol}.js` | handoff, independent review, freeze and disposition protocol | handoff/review CLI and controller | durable handoff/review records; no provider write by itself | handoff/review tests | generic, exact-identical blobs at baseline |
| Both `manage-runner.js`, `override-runner.js`, `state-{audit,report,runner}.js` | task retirement/administration, audited override, state reporting | CLI and CIE workflow closeout | deliberate durable mutations with audit records; no implicit GitHub mutation | manage/override/state tests | generic; CIE workflow closes tasks through direct embedded script path |
| Both `run-metrics.js`, `measurement-taxonomy.js`, `scorecard.js` | run metrics, taxonomy, baselines and scorecards | metrics/eval CLI, controller receipts | reads durable records; writes reports/artifacts only when requested | metrics/taxonomy/scorecard tests | generic; AO computes richer time windows/rates/scope fingerprints while retaining the same nominal schema label as CIE—compatibility risk |
| Both `eval-harness.js`, AO-only `eval/{catalog,builtin-runners,replay}.js` | scenario packs, deterministic replay and quality gates | `ao-eval.js`, package verification | reads fixtures, emits report/artifact; no production provider effect | eval framework/harness/CLI tests and scenario packs | generic; standalone is substantially more complete and cryptographically fingerprints replay/scope |
| Both `repo-knowledge*.js`, `debt-report.js`, `fixture-support.js` | repository knowledge contracts/lint, debt and fixture support | CLI/eval/tests | reads repo docs/fixtures; optional report output | knowledge/debt/fixture consumers | mechanism generic; actual CIE knowledge text/paths remain domain configuration |
| AO-only `config.js` | load/validate `ao.config.json`, project/provider/verification/eval configuration | CLI facade | reads config only | `config.test.js` | generic and required package boundary; initial provider fields were partly nominal rather than fully wired |
| AO-only `providers/command-runner.js`, `runtime-providers/{index,github-local}.js` | injectable command/provider boundary | observation, runtime preflight, action execution | fakeable command intent; real adapter can run local `gh` read/write commands | command-runner/runtime tests | generic boundary and more mature than CIE’s direct command use |
| AO-only `windows-localhost-relay.js` plus wrapper | WSL/Windows loopback relay support | explicit CLI/script only | opens local sockets when explicitly run | localhost relay test | generic optional runtime utility; absent from CIE |
| AO-only `scripts/ao-init.js` | initialize config/state/knowledge template | CLI `init`, package verification | creates local config/templates; no remote effect | CLI and package verification | generic package-install capability |
| CIE-only `scripts/ao/validate_9709_active_issue_manifest_v1.py` | validate 9709 active-issue parent/campaign manifest | package scripts, `.github/workflows/9709-parent-creation-gate.yml`, `tests/vlm/test_validate_9709_campaign_a_parent_creation_gate_v1.py` | reads repository manifests/worktree; fail-closed validation, no generic AO state | Python contract test and VLM test | explicitly 9709/CIE-specific; stays in CIE and must not move into public AO |
| CIE `agent-orchestrator.yaml`, repository knowledge, prompts and workflow hooks | CIE operating policy and repository workflow integration | external agent-orchestrator, human operators, Git hooks | invokes AO CLI and CIE workflows; may coordinate live work | workflow/hook tests and docs | CIE-specific adapter/configuration; remains CIE-owned |
| CIE `.ao-control-plane/**`, `artifacts/**`, historical AO docs | runtime state, receipts, generated/historical evidence | operators and audit tooling | historical/durable data, not source implementation | audit/report readers | never migrated as source or deleted by consolidation; observed both `ciecopilot-home` and legacy `my-project` identities |

## Exact identical core evidence

Git blob hashing established that the following baseline modules are byte-identical, so “CIE is automatically newer” is false for these capabilities:

| Module | Shared blob prefix |
|---|---|
| `state-contracts.js` | `d7387329…` |
| `state-migrations.js` | `20003cda…` |
| `state-repository.js` | `277377e2…` |
| `state-repository/collections.js` | `5067126a…` |
| `state-storage.js` | `2cdbd74c…` |
| `controller-loop.js` | `35e4503…` |
| `reconciliation-engine.js` | `5e3e73c…` |
| `handoff-protocol.js` | `4252e0e…` |
| `review-protocol.js` | `e7179e…` |
| `checkpoint-store.js` | `626985…` |
| `task-spec.js` | `a4249f…` |

## Embedded AO internal dependency graph

```text
agent-orchestrator.yaml / npm scripts / workflow closeout / AO operations gate
                                 |
                                 v
                 scripts/ao-*.js CLI facades
                                 |
          +----------------------+----------------------+
          v                      v                      v
 observation + doctor     reconcile/lifecycle      manage/state/handoff
          |                      |                      |
          +-----------> controller-loop <--------------+
                                 |
                  policy / gate / action-executor
                    |             |          |
                    v             v          v
               review        event ingest  provider commands
                    \             |          /
                     +----- state repository -----+
                               | locks
                               v
               .ao-control-plane/<project-id> JSON/JSONL
```

`validate_9709_active_issue_manifest_v1.py` is deliberately outside this generic graph: it is called by the 9709 parent-creation gate and VLM tests, not by generic controller/state modules.

## CIE business-to-embedded caller graph

```text
agent-orchestrator.yaml C2/C4/C5
  -> node scripts/ao-lifecycle.js / ao-reconcile.js / ao-doctor.js

package.json ao:* scripts
  -> twelve embedded scripts/ao-*.js facades

scripts/workflow/cli.js:291 task closeout
  -> node scripts/ao-manage.js retire ...

scripts/workflow/lib/codex-preflight.js:447
  -> requires package script ao:doctor (indirect process contract)

.github/workflows/ao-operations-gate.yml:64-75
  -> embedded acceptance, smoke and three direct CLI --help calls

tests/ao/** (67 deep-importing tests)
  -> scripts/ao/lib/** implementation internals

9709 parent creation workflow / VLM test
  -> CIE-only Python validator (retained)
```

No production module under `api/**` or `src/**` imports embedded AO. Therefore cutover is primarily a declared-package/process boundary migration, followed by removal/replacement of tests that were coupled to implementation internals.

## Direct answers to inventory questions

- **哪些业务模块直接 import embedded AO？** Application source does not. Direct production callers are package scripts, `agent-orchestrator.yaml`, `scripts/workflow/cli.js`, workflow preflight’s script contract, and the AO operations workflow. Tests contain the deep imports.
- **是否存在 deep import？** Yes: 67 embedded tests import `scripts/ao/lib/**`. Production uses direct script paths rather than JavaScript deep imports; both forms violate the desired public package boundary.
- **是否存在 copy-paste / renamed equivalents？** Yes: at least 41 production source blobs are exact copies; several report/runner files are structurally different but behaviorally equivalent. No evidence supports retaining both generic copies.
- **哪些 generic capabilities only in CIE？** Real `auto_merge_ready_pr` effect execution and optional blocked-notification transport. They require generic extraction with conservative policy defaults and fake-provider tests.
- **哪些 capabilities newer in standalone？** Config loading, injectable command/runtime providers, modular eval catalog/replay, SHA-256 fingerprints, richer metrics windows/rates, package init/verification, and Windows relay.
- **哪些依赖 CIE domain？** The 9709 Python validator and workflow, CIE repo knowledge/prompts/paths, repository issue taxonomy, and local operational policy/configuration.
- **哪些 tests are parity oracles？** Acceptance fixtures, reconciliation/lifecycle/policy/action tests, state migration/repository tests, review/handoff/checkpoint tests, controller recovery/idempotency tests, and eval scenario packs. Text-only CLI snapshots are secondary to normalized semantic objects and command intents.

## History and evidence limits

The CIE repository’s locally available history is shallow around some embedded AO origins. Pre-July source provenance cannot be conclusively reconstructed and is classified `J` where commit authorship/order would otherwise decide a choice. Current behavior, callers, tests, contracts, blob identity and packaging constraints—not assumed history—drive canonical decisions.
