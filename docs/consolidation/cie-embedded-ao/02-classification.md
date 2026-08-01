# Phase 2 — Semantic Diff and Classification

Classification vocabulary:

- `A` Identical
- `B` Functionally equivalent but structurally different
- `C` CIE implementation more complete
- `D` `ao-pilot` implementation more complete
- `E` Generic capability missing from `ao-pilot`
- `F` Generic capability missing from CIE
- `G` CIE-specific adapter/policy/knowledge
- `H` Obsolete or unused
- `I` Conflicting behavior requiring explicit decision
- `J` Evidence insufficient

一个 capability 可同时具有两个分类，例如 `C/I` 表示 CIE 有更多行为，但该行为不是可以无条件复制的 universal default。

## Capability decision matrix

| Capability / class | Observed difference and evidence | Behavioral impact / callers | Canonical choice and reason | Migration / risk / required test |
|---|---|---|---|---|
| CLI facade `D/F` | AO `bin/ao-pilot.js` dispatches 13 commands including `init`; CIE has 12 direct `scripts/ao-*.js` facades | all CIE npm/operator/workflow callers currently execute embedded paths | AO CLI is canonical because it is installable/config-aware; retain CIE npm aliases as adapter UX | rewrite scripts/YAML/workflow caller paths; CLI help/exit/JSON contract tests |
| Package API `D` | initial AO has npm `bin` and pack verification; CIE is not a package | determines whether CIE can consume rather than copy | AO package canonical | add explicit `main`/`exports`; isolated tarball import/install test |
| Library API `I/J` | neither baseline exposes a documented stable JS library boundary; tests deep-import internals | CIE tests and future adapters need contracts without deep imports | define a narrow AO-owned public surface from already-stable modules | public export allowlist and no-deep-import guard; avoid promising every internal symbol |
| Configuration loading `D/I` | AO `config.js` validates project/providers/verification/eval; CIE hardcodes local defaults | project identity and provider policy differ | AO generic loader canonical; CIE supplies `ao.config.json` | add lifecycle/action policy config only where required; invalid/default/config roundtrip tests |
| Project identity `G/I` | AO default `my-project`; CIE operational state uses `ciecopilot-home`, and legacy `my-project` also exists | wrong id creates a parallel state namespace | CIE explicitly configures `ciecopilot-home`; AO retains generic default for new users | CIE consumer test and state path assertion; document root-only operational cwd |
| Controller loop `A/G` | baseline `controller-loop.js` blob `35e4503…` exact; surrounding config/policy differs | same lease/heartbeat/recovery semantics | identical AO copy canonical; CIE injects policy/config | parity replay and recovery/idempotency test |
| Controller lease/heartbeat `A` | exact shared controller/storage contracts and tests | concurrent controller exclusion | AO copy canonical | migrate tests; lease acquisition/expiry/heartbeat replay |
| Managed task model `A` | schema v10 state contracts exact | all durable AO tasks | AO contracts canonical | packed library contract + migration fixture |
| Parent/child relation `J/G` | generic schema does not establish a complete universal hierarchy; CIE issue orchestration carries campaign relations | risk of importing 9709 workflow semantics into core | keep CIE hierarchy adapter; do not invent new generic feature | retain domain tests; no feature expansion |
| Ownership lease `A` | identical durable contracts/repository behavior | task ownership and orphan/stale diagnostics | AO canonical | fixture replay for orphaned/stale ownership |
| PR binding `A` | same state contract and reconcile engine | binds task to PR/head | AO canonical | accepted/ambiguous fixture parity |
| Observation `D/B` | engines broadly equivalent; AO provider/config injection more explicit | live/local evidence collection | AO implementation canonical | fake GitHub/local provider; malformed payload parity |
| Event ingestion/dedupe `I` | same mechanism but release-ready action hint differs (`notify_human_ready` vs auto merge) | controller action proposal | AO generic ingest with injectable `releaseReadyAction`, conservative default | dedupe/idempotency and both-policy unit tests |
| Reconciliation `A/B` | core engine exact blob `5e3e73c…`; runner/report wiring differs | canonical truth and strict result | AO engine/runner canonical where behavior parity holds | six acceptance fixtures + normalized fingerprint |
| Doctor/diagnostics `B/G` | generic findings align; CIE report/config references repository workflow | operator/preflight | AO doctor canonical, CIE repo knowledge/config retained | strict exit/JSON semantic tests and CIE package smoke |
| Lifecycle decisions `C/I` | CIE recognizes `auto_merge` review gate and proposes `auto_merge_ready_pr`; AO proposes human-ready notification | can produce remote merge versus notification | generic engine supports explicit policy; safe AO default remains `notify_human_ready`; CIE may opt into legacy auto-merge policy | both branches with exact-head evidence; CIE adapter test; no production merge in test |
| Policy decisions `A/I` | most rule engine blobs/behavior align; release effect policy differs | action class/permission | AO rule engine canonical; domain/operational policy injected | fail-closed unknown-action and config validation tests |
| Action model `C/E` | CIE has action templates for auto merge and blocked notification absent from initial AO | missing generic provider capabilities | port generic action kinds/contracts, not CIE defaults | template/contract tests; public receipt shape |
| Execution behavior `I` | AO initial `executeAssistActions` records class-A actions as `executed` without running `action_model.commands`; CIE runs `gh` merge and optional webhook for two kinds, while other kinds remain state-only | durable record may falsely imply external effect | distinguish `state_only` from attempted/confirmed external effect; require fakeable runner and receipt | high-risk tests assert command, args, cwd, output/error, retry and persisted status |
| Handoff `A` | exact blob `4252e0e…` | continuity transfer | AO canonical | handoff fixture/library test |
| Resume/recovery `A/B` | continuity/checkpoint/controller semantics align | restart safety | AO canonical | crash/replay/no-duplicate-action test |
| Checkpoint `A` | exact blob `626985…` | explicit recovery point | AO canonical | state/checkpoint replay |
| Independent review/freeze `A` | review protocol exact blob `e7179e…` | independent verdict and frozen head | AO canonical | review/freeze/head-drift tests |
| Persistence `A` | storage/repository/collections exact blobs | all durable state | AO canonical | migration, atomic write, packed-install temp repo test |
| Locks `A` | same storage lease/lock mechanisms | prevents concurrent mutation | AO canonical | expiry/conflict tests |
| Schema migrations `A` | both latest schema v10; `state-migrations.js` exact `20003cda…` | backward compatibility | AO canonical, no migration rewrite | replay every available old fixture and compare canonical JSON/fingerprint |
| Metrics `D/I` | AO adds windows/rates/scope; CIE simpler output while nominal schema naming overlaps | dashboards/quality gates may compare incompatible objects | AO output canonical; explicitly record shape difference rather than claim byte parity | deterministic normalized report tests; version/compatibility note |
| Evaluation `D/I` | AO adds catalog, builtin runners, SHA-256 replay/scope fingerprints | product quality gate and package verification | AO canonical | scenario pack replay, stable fingerprint and scorecard baseline gate |
| Scorecards/baselines `D` | AO has richer public-product baseline/gate | release verification | AO canonical | `release:check`/eval gate and pack verification |
| Repository knowledge `A/G/I` | mechanism shared; content/path assumptions CIE-specific | doctor/preflight and operator guidance | AO contract/parser; CIE knowledge document/config | lint both generic template and CIE adapter content |
| TaskSpec `A` | exact blob `a4249f…` | admission/intake | AO canonical | TaskSpec validation through public API |
| Runtime preflight `D/I` | AO provider boundary more mature; CIE workflow has repository-specific preflight | controls execution eligibility | AO generic runtime contract; CIE workflow preflight remains adapter | fake provider success/failure and CIE workflow tests |
| GitHub integration `D/C/I` | AO has injectable read adapter; CIE has real auto-merge write path | possible remote side effect | AO owns provider interface/read adapter and generic write intent; a consumer may opt in, while CIE's current policy explicitly does not | command intent tests only; no live `gh merge` during consolidation |
| Agent runtime integration `D/G` | AO runtime contracts generic; `agent-orchestrator.yaml` is CIE-owned | external agent orchestration | AO contracts plus CIE YAML adapter | YAML/script target scan and consumer smoke |
| Blocked notification `E/G/I` | CIE optional webhook transport missing in AO; endpoint/config is environment-specific | external network notification | generic transport interface/mechanism in AO, disabled unless injected/configured; CIE endpoint remains external config | fake transport, no-secret/no-network test, failure receipt/retry |
| Windows relay `F` | AO-only relay and tests | optional Windows/WSL operator support | retain AO only; CIE need not wrap it | existing localhost test; classify sandbox EPERM correctly |
| 9709 manifest validator `G` | only CIE Python validator, workflow and VLM tests | CIE campaign admission | retain exclusively in CIE | keep exact domain tests; exclude from duplicate-core guard |
| Documentation generation `J` | reports can render Markdown/JSON, but no separate canonical doc-generation subsystem was proven | no active migration requirement | do not create a feature under consolidation gate | document current reports only |
| Historical/runtime artifacts `G/H` | CIE state/artifact directories include multiple identities and historical receipts | audit trail, not executable source | retain; never package or delete as duplicate source | package file allowlist and source scan |

## High-risk semantic decision: `executed`

The baseline AO action executor’s durable status was not proof of an external effect. A command template under `action_model.commands` could exist while the executor wrote `executed` without invoking it. This is not a textual difference: downstream recovery may suppress a required action because durable state says it already happened.

Canonical rule:

1. Pure durable bookkeeping actions may be explicitly identified as `state_only`; their receipt must say that no external provider effect was intended.
2. Provider-effect actions are `executed` only after an injected runner/transport returns a confirmed success receipt.
3. A proposed command, skipped/disabled provider, or failed attempt is not silently converted to confirmed execution.
4. Retry/idempotency uses the durable action identity plus effect receipt; tests assert command intent, arguments, cwd and provider result.
5. Standalone AO’s default lifecycle remains human-notification oriented. Supporting CIE’s existing auto-merge action does not enable it globally.

This intentional clarification is a consolidation bug fix allowed by the Hard Gate; it is not a new controller feature.

## Metrics/evaluation compatibility decision

AO’s richer metrics and evaluation implementation is canonical because its replay hashes, scenario catalog and package gates are observable product capabilities not present in CIE. Because some similarly named objects have different derived fields while sharing old schema labels, migration claims semantic parity only for their common contract. The richer AO-only fields are an approved behavior difference and are compared to AO baselines, not discarded to match CIE text output.

## Unknowns retained as explicit limits

- Shallow/limited CIE history prevents conclusive authorship chronology for some pre-July modules (`J`). Exact current blobs and behavior are sufficient for cutover, but not for historical attribution.
- Historical `.ao-control-plane` data was inventoried but not mutated. A live-state conversion is neither necessary nor authorized because schema v10 is already identical.
- External provider success is verified through fake integrations and command receipts. No live merge, webhook, deployment or production state change is permitted in this task.
