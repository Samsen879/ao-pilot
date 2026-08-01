# AO Pilot Canonical Consolidation and CIE Embedded AO Cutover

## 1. Executive Summary

**Verdict: `PASS_WITH_EXPLICIT_LIMITATIONS`.**

The local consolidation gate passed. `ao-pilot` is now the only generic AO implementation on the migration branches; `ciecopilot-home` declares and consumes its public package API and no longer contains a production generic AO core. CIE retains only configuration, workflow adapters, the agent-orchestrator bootstrap and the 9709-specific manifest validator/test.

The result is not an unconditional `PASS` because no push/npm publication was authorized, the committed CIE workflow does not yet pin a remotely resolvable canonical AO revision, live provider writes were intentionally not exercised, CIE's broad repository baseline still contains unrelated pre-existing test/lint failures, and the provider protocol has a crash window between remote success and durable receipt that requires manual reconciliation. None of those limitations creates a fallback embedded core.

## 2. Initial Repository State

| Repository | Initial branch / HEAD | Initial status | Migration surface |
|---|---|---|---|
| AO | `main` / `ba36262289c105471837d5ed191ebd424d6a61f4`, tree `35cb2752…` | clean, synced with origin | local branch `codex/cie-ao-consolidation` |
| CIE root | `main` / `5bb8b4951a015950396d453c7f784f5bf1708922`, tree `91059970…` | clean; ahead 1, behind 9; local-only YAML commit | preserved read-only |
| CIE exact migration base | `origin/main` / `a670ecf52688ce6653a3296aa3e4447dda3b1a75`, tree `7ada7693…` | fetched read-only | governed `task/local-ao-consumer-cutover` worktree |

Node was `v22.22.1`, npm `11.15.0`, Corepack `0.34.6`; both repositories use npm lockfile v3. Exact commands, counts and environment-failure classification are in `00-baseline.md`.

The live AO z work, handoffs, sessions, `.ao-control-plane` state and AO start/stop/manage operations were explicitly outside the migration surface and were not changed.

## 3. How Embedded AO and Standalone AO Differed

The two lines were neither independent rewrites nor safe directory copies:

- 41 embedded production blobs were exact matches to AO; 21 same-path production files had drift.
- AO had seven production modules absent from CIE, including config/package/runtime/eval product seams; CIE had two, notably the blocked-notification transport and 9709 validator.
- State schema v10, migrations, persistence, reconciliation core, controller core, checkpoint, review, handoff and TaskSpec were already exact or behaviorally aligned.
- AO was more complete in packaging, `init`, injectable read/runtime providers, metrics, deterministic evaluation, scorecards and Windows relay.
- CIE had a real merge/webhook effect path that AO lacked, but its own active orchestration configuration required decide-only/no merge.
- AO's initial `executed` action state could mean durable bookkeeping only. CIE ran real effects for selected actions, creating a high-risk semantic ambiguity.
- CIE callers were process/script/config callers; no CIE application module under `api/**` or `src/**` deep-imported the embedded core.

## 4. Complete Capability Inventory

The file/symbol/caller-level ledger is `01-inventory.md`. The consolidation result by capability is:

| Capability group | Canonical owner | Result |
|---|---|---|
| CLI, configuration, project identity | AO | explicit binary, named CLI runners, config-preserving cwd/project behavior |
| state/domain contracts, managed tasks, PR binding, ownership | AO | schema-v10 contracts and public contract export |
| persistence, locks, migrations | AO | unchanged canonical implementation; packed repository API |
| observation, provider reads, event dedupe | AO | injectable provider seams; configurable conservative release action |
| reconciliation, doctor, lifecycle, policy, transition | AO | pure engines/public API; CIE policy stays configuration |
| action execution | AO | migrated CIE capability; hardened authorization, exact-head and effect receipts |
| controller lease/heartbeat/recovery | AO | TaskSpec review gate and provider/cwd wiring hardened |
| review/freeze, handoff, checkpoint, continuity | AO | canonical protocol exports and recovery tests |
| metrics, evaluation, scorecards | AO | richer AO behavior retained and fingerprinted |
| repository knowledge mechanism | AO | generic parser/lint contract; CIE content stays CIE |
| agent-runtime/GitHub mechanism | AO | fakeable generic provider boundary |
| CIE orchestration/paths/prompts/Skills | CIE | retained as adapters/domain knowledge |
| 9709 manifest/data/evidence/custody rules | CIE | validator/workflow/tests retained; never moved to AO |
| historical state/artifacts/docs | repository of origin | retained as evidence; not treated as executable duplication |

## 5. Canonical Decisions

1. AO's exact/shared generic modules are canonical because their contracts, callers and tests align; CIE duplication is removed rather than re-copied.
2. AO's richer metrics/evaluation/packaging is canonical because it is tested observable generic capability, not CIE domain behavior.
3. CIE's effect mechanism was migrated, but not its environment-specific webhook endpoint or auto-merge default.
4. Generic release-ready behavior defaults to `notify_human_ready`. Auto merge is supported only as an explicit, irreversible, exact-head-authorized effect.
5. `executed` is proof of a completed durable-only action or confirmed provider effect; effect status/kind makes the distinction explicit.
6. `file:../ao-pilot` is the lowest-risk local sibling dependency. Only declared public exports may be imported.
7. 9709 validation, bootstrap and repository workflow remain in CIE; they are not disguised as AO adapters merely to reduce file count.

The per-capability A–J classifications, evidence and compatibility risks are in `02-classification.md`; the final package/module map is `03-target-boundary.md`.

## 6. Migration Sequence

The order followed the requested contract-to-consumer dependency direction:

```text
baseline and inventory
  -> canonical package/contracts boundary
  -> generic action/provider capability
  -> semantic parity and approval fingerprints
  -> exact-head/review/effect safety hardening
  -> CIE package/config/caller cutover
  -> no-deep-import/no-duplicate guard
  -> embedded duplicate deletion
  -> fresh/packed/full verification
```

The exact commits and correction history, including the independent review rejection and remediation, are in `04-migration-log.md`.

## 7. Behavioral Parity Evidence

The deterministic fixture `generic-control-plane-parity-v1` covers input state, observation, reconciliation, diagnostics, lifecycle, policy/action, review, handoff, checkpoint/recovery, metrics, evaluation and migrations.

```text
fingerprint:              6f81aed7a563f69bad533ebb4cb99c7c62fbf6d8cec5417806ed97e3afd9cca6
standalone baseline:      matched
expectation failures:     0
cross-repository status:  passed
differences:              85
approved:                 85
unapproved:               0
unused approvals:         0
```

The 85 approved paths comprise 74 AO modular-evaluation fields, seven bounded-metrics fields and four explicit action-effect fields. Evaluation/metrics groups are bound by `path_prefix` plus an aggregate difference fingerprint; action approvals bind exact paths and expected AO/CIE values. The harness proves stale, missing or newly introduced drift fails. See `05-parity-report.md`.

## 8. CIE Consumer Cutover

CIE commit `7bf90defb`:

- declares runtime dependency `ao-pilot: file:../ao-pilot` and lockfile metadata;
- pins `project_id: ciecopilot-home` in `ao.config.json`;
- changes AO npm commands to `ao-pilot <command>`;
- rewires `agent-orchestrator.yaml`, workflow closeout, AO operations CI and active runbooks;
- preserves stable npm script names consumed by preflight/workflow code;
- keeps the explicit decide-only/no-merge policy.

CIE package consumers import only `ao-pilot` and its seven declared scoped exports. Public package tests load the installed artifact and assert an internal deep import is rejected.

CIE commit `4a5f83f33b51063c7d60003dd4455c40e1b1f4ed` restores the CIE-owned runbook, topology, roadmap and secret-symlink oracles at the consumer boundary and adds a process-level installed-CLI `state -> reconcile -> lifecycle` smoke. It does not restore any embedded generic implementation.

## 9. Duplicate Core Removed

CIE commit `d68243fe10ad2a132237582b88f0e01a3edba0b4` touches 183 files, deletes 182 files from the embedded topology and removes 43,012 lines:

- 12 embedded CLI entrypoints;
- 62 files under `scripts/ao/**` (61 generic modules plus copied smoke runner);
- 108 test/fixture paths: 100 generic oracles are present or behaviorally absorbed in AO, while eight CIE-owned contracts were rewritten at the package/adapter boundary;
- one preflight fixture updated to the package command.

The CIE branch as a whole changes 207 files with 1,312 insertions and 42,999 deletions from exact base `a670ecf…`: the insertions are package wiring, tests, boundary guard, config and documentation, not a replacement embedded kernel.

## 10. Remaining CIE-specific Components

- `ao.config.json` and `agent-orchestrator.yaml`;
- `scripts/ao/start-clean.sh`;
- `scripts/ao/validate_9709_active_issue_manifest_v1.py`;
- `tests/ao/test_validate_9709_active_issue_manifest_v1.py`;
- `scripts/quality/ao-package-boundary-guard.mjs` and `tests/ao-consumer/**`;
- CIE workflow, VLM/9709 validators, prompts, issue taxonomy, paths, domain knowledge and Skills;
- historical/live `.ao-control-plane` state, artifacts and reports.

Within the legacy `scripts/ao/**` and `tests/ao/**` namespaces, the static guard allowlists only the bootstrap, 9709 validator and its domain test. The consumer tests live separately under `tests/ao-consumer/**` and import only public package surfaces.

## 11. Tests and Verification

The final verification ledger records exact command, cwd, exit status, counts, duration/warnings and classification. A command is not called green when it failed before diagnostics.

### AO implementation and package

| Command | Cwd | Exit | Count / duration | Result, warning and classification |
|---|---|---:|---|---|
| `npm test` | `<AO_PILOT_REPO>` | 0 | 73/73 suites, 371/371 tests; Jest 9.472 s | passed at docs-only descendant `f9d56b3` of implementation `fb6c04f`; VM Modules experimental warning only |
| `npm run ao:test:acceptance` | AO root | 0 | 1 suite, 7/7 tests; Jest 0.167 s / wall 0.854 s | lifecycle acceptance passed |
| `npm run ao:smoke` | AO root | 0 | one `ci-failed-pr` fixture; wall 0.241 s | reconcile blocked, doctor blocked and lifecycle hold as expected |
| `npm run ao:eval -- --pack policy-fail-closed --json` | AO root | 0 | 1/1 scenario, two stable replays; wall 0.320 s | quality gate passed; generated operator artifact was removed, ignored durable eval receipt retained |
| `npm run verify:package` | AO root | 0 | 149 entries; wall 6.3 s | isolated pack/install, CLI/public groups/eval/deep-import checks passed with the consolidation docs present; later receipt-only text edits do not change runtime files |
| `npm audit --omit=dev` | AO root | 0 | 0 vulnerabilities; wall 0.424 s | passed |
| lint / build | AO root | n/a | no declared scripts | not invented or reported as passed |

### CIE final candidate `4a5f83f33`

| Command | Cwd | Exit | Count / duration | Result, warning and classification |
|---|---|---:|---|---|
| `npm run ao:boundary:check` | governed CIE worktree | 0 | 0 violations; wall 4.397 s | no embedded core, deep import or duplicate fingerprint |
| `npm run ao:test:consumer` | governed CIE worktree | 0 | 4/4 suites, 21/21 tests; Jest 4.897 s / wall 6.301 s | public imports, CIE adapter/security contracts and installed-CLI workflow smoke passed; sandbox child-process attempt was environment-only and the complete narrow-permission rerun passed |
| `npm run ao:smoke` | governed CIE worktree | 0 | version `0.2.0`; wall 0.214 s | binary/version smoke only; the process workflow smoke is the consumer test above |
| focused `codex-preflight.test.js` + `workflow-scripts.test.js` | governed CIE worktree | 0 | 2/2 suites, 18/18 tests; Jest 2.017 s / wall 3.718 s | workflow caller cutover passed |
| `npm run 9709:active-issue-manifest:contract-test` | governed CIE worktree | 0 | `passed: true`, 0 errors; wall 0.281 s | retained CIE domain validator passed |
| `npm run build` | governed CIE worktree | 0 | 2,502 modules; Vite 5.54 s / wall 6.566 s | passed; stale Browserslist and large-chunk warnings remain |
| `npm run lint` | governed CIE worktree | 1 | 47 errors, 11 warnings; 29.972 s | exact known baseline lint debt; no new lint count |
| `npm test -- --runInBand --no-color` | governed CIE worktree | 1 | 552 suites: 531 passed/21 failed; 3,892 tests: 3,843 passed/49 failed; one failed snapshot; Jest 506.871 s | all 21 final failing suite identities equal the post-deletion `d68243fe1` set; new failures 0 |

### Cross-repository, fresh and packed consumption

| Command / gate | Cwd | Exit | Count / duration | Result, warning and classification |
|---|---|---:|---|---|
| `node scripts/consolidation/parity-harness.js --cie-root <CIE_REPO>` | AO root | 0 | 85/85 approved, 0 unapproved, 0 CIE expectation failures; wall 0.304 s | stable fingerprint `6f81aed7…` matched |
| fresh sibling `npm ci` and `npm run ao:test:consumer` | clean Git exports of AO `f9d56b3` / runtime `fb6c04f` and CIE `4a5f83f33` | 0 | 804 packages; consumer 4/4 suites, 21/21 tests; Jest 5.067 s / command 6.45 s | true sibling install passed; npm reported 24 dependency vulnerabilities (1 low, 5 moderate, 18 high), recorded as an important CIE dependency warning rather than an AO assertion failure |
| fresh boundary / binary / workflow gates | same fresh CIE export | 0 | 0 boundary violations; version `0.2.0`; CIE `workflow-scripts.test.js` fixture smoke 1 suite/7 tests | no source-tree-relative package dependency or deep import |
| `npm pack` from clean AO export | clean AO `f9d56b3` | 0 | 140 entries; 172,340 bytes; unpacked 889,346 bytes; SHA-256 `780d710c65683672fafe78c47f3cd4f0a106a99ad70e4094614c1bb848663fb8` | runtime implementation parent is exact `fb6c04f`; npm shasum `4ff477c5dc730a6a667ec10cddd36db6b29cb91c` |
| packed isolated CIE install / public API / deep-import / workflow gates | `<TEMP_DIR>/packed-isolated/ciecopilot-home` | 0 (deep import 1 expected) | offline install 804 packages / wall 10.553 s; consumer 4/4 suites, 21/21 tests (Jest 5.75 s / wall 7.349 s); boundary 0 (4.212 s); workflow 1 suite/7 tests (2.663 s); version `0.2.0` | no sibling AO directory; installed package is a regular tarball directory; seven public imports passed; undeclared deep import failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`; package-owned fixture smoke ran `state -> reconcile -> lifecycle`; restricted first install was `EPERM`, identical narrow-permission rerun passed |

In addition, the first final AO full-suite attempt on `03b3951` found one real new test failure: the controller fixture expected auto merge without the newly required durable authorization. Commit `72b3b81598ed628cd83ce6883b7bea5f5f8d9f76` corrected the fixture to verify block-then-authorize behavior; it did not weaken the implementation gate.

## 12. Intentional Behavior Changes

- release-ready defaults to human notification instead of automatic merge;
- missing notification transport remains proposed/blocked without a succeeded receipt instead of “executed”;
- auto merge needs durable authorization bound to the expected head, current-head review PASS and `--match-head-commit`;
- provider-effect status is exactly `durable_only`/`attempted`/`succeeded`/`failed`; an unknown in-flight result is represented separately by `execution.outcome=effect_attempted`;
- CheckRun/StatusContext and command exit/signal parsing fail closed;
- CLI library calls honor caller cwd;
- richer AO metrics/evaluation fields remain canonical.

## 13. Pre-existing Failures

- CIE exact-base broad test: 623 suites, 600 passed/23 failed; 4,202 tests, 4,145 passed/57 failed; 653.421 s.
- CIE exact-base lint: 47 errors and 11 warnings.
- CIE final broad test: 552 suites, 531 passed/21 failed; 3,892 tests, 3,843 passed/49 failed; 506.871 s. Relative to post-deletion `d68243fe1`, the two restored suites and 12 restored cases all pass and the 21 failing-suite/49 failing-case set is unchanged.
- CIE final lint is unchanged at 47 errors and 11 warnings. The final 21 failing suites are outside the cutover files and remain classified as repository debt; the exact names and baseline disposition are recorded with the verification manifest.
- The baseline-to-final reduction of two failing suites/eight failing cases is not test deletion: `paper-workspace-characterization.test.js` (seven cases) and `closed-loop-release-gate.test.js` (one case) are byte-unchanged between base and final and pass in the final run. The former was a baseline `beforeAll` timeout; the latter observed polluted global `process.exitCode` in the baseline log, but its precise root cause is not claimed. The 12 new/rehomed CIE consumer cases are a separate count.
- Initial sandbox-only AO/CIE test failures were loopback `EPERM`; initial package verification/cache failures were process/default-cache environment restrictions. Identical narrow-permission reruns separated them from product defects.

Final broad CIE results are compared with this baseline. No assertion was removed or weakened to hide these failures.

## 14. Remaining Risks and Limitations

1. **Publication/revision binding:** no push or npm publish was authorized. `.github/workflows/ao-operations-gate.yml` checks out `Samsen879/ao-pilot` without `ref`; remote `origin/main` is still `ba362622…` (package 0.1.0, no public `exports`), not this local canonical line. The current remote workflow therefore cannot reproduce the verified consumer boundary. A release must first make the canonical commit remotely resolvable, then pin an immutable SHA/tag or package artifact.
2. **External-effect crash window:** provider success followed by process death before durable receipt needs manual live-state reconciliation; automatic replay is blocked.
3. **Live provider validation:** GitHub merge/webhook effects were tested with fakes only, by design and authorization boundary.
4. **CIE repository debt:** broad pre-existing test/lint failures remain and are unrelated to the consumer cutover.
5. **Historical evidence:** old docs/artifacts may describe the embedded era; executable scans intentionally do not delete audit history.
6. **API breadth:** the aggregate root export intentionally mirrors the seven scoped groups and is broad. Future changes must preserve documented/scoped names or use a semver-compatible deprecation; internal `scripts/**` paths remain private.

There is no remaining local generic-capability or consumer blocker. These are explicit operational/distribution limitations, hence `PASS_WITH_EXPLICIT_LIMITATIONS` rather than `PASS`.

## 15. Rollback Procedure

1. Do not change live AO state or remote provider state as part of source rollback.
2. Revert CIE `d68243fe1` to restore the embedded duplicate snapshot if the package cutover must be backed out.
3. Revert CIE `7bf90defb` to restore pre-cutover callers/dependency metadata.
4. Reinstall the selected lockfile with `npm ci`.
5. For an AO-only defect, revert the smallest focused AO commit and rerun pack, parity and CIE consumer gates before altering CIE.

No rollback uses `reset --hard`, `git clean`, history rewriting or deletion of `.ao-control-plane`/artifacts.

## 16. Final Source-of-Truth Declaration

At verified implementation heads:

```text
ao-pilot:        fb6c04f546d049a257f52886d8bc22fe4b78073a
ciecopilot-home: 4a5f83f33b51063c7d60003dd4455c40e1b1f4ed
```

`ao-pilot` is the canonical generic AO source of truth. CIE consumes it as a package and contains no duplicate generic AO core. Public package documentation and clean packed verification are bound to `f9d56b3a4d5d6272df71ab9a2ed522fd1adeafcb`, a docs-only descendant of the runtime head above. The consolidation-report commit follows it; the terminal handoff reports the actual repository HEAD to avoid an impossible self-referential commit hash inside that commit.

## 17. Exact File and Commit References

Primary files:

- AO `package.json`, `lib/{index,cli,contracts,repository,engines,protocols,providers}.js`;
- AO `scripts/ao/lib/{action-executor,controller-loop,event-ingest,lifecycle-engine,blocked-notification-transport}.js`;
- AO `scripts/consolidation/parity-harness.js` and fixture/approval files;
- AO `scripts/verify-package-install.js`;
- CIE `package.json`, `package-lock.json`, `ao.config.json`, `agent-orchestrator.yaml`;
- CIE `scripts/quality/ao-package-boundary-guard.mjs`;
- CIE `tests/ao-consumer/{ao-package-consumer,ao-boundary-guard,cie-ao-adapter-contract,orchestrator-secret-symlink-contract}.test.js`;
- CIE `scripts/workflow/cli.js`, `.github/workflows/ao-operations-gate.yml`.

AO commits are `a1a3d59`, `9570878`, `b248e92`, `43c72b1`, `99106f0`, `5823b80`, `34edb3a`, `cb06763`, `219d060`, `07537fc`, `03b3951`, `72b3b81`, `d7a18a9`, `fb6c04f`, `f9d56b3`. CIE commits are `4de96ce29`, `7bf90defb`, `d68243fe1`, `4a5f83f33`.

## 18. Completion Gate and Verdict

- [x] complete two-implementation inventory
- [x] classify all major capability differences
- [x] define generic/CIE boundary and public exports
- [x] migrate the only missing generic effect capability into AO
- [x] establish deterministic behavioral parity and approval registry
- [x] cut over every identified CIE production caller
- [x] prove no embedded generic production dependency/deep import
- [x] delete safely replaceable duplicate generic source/tests/fixtures
- [x] retain CIE-specific adapters/domain rules
- [x] verify AO package install and CIE public consumer
- [x] document rollback, pre-existing failures and limitations
- [x] declare AO canonical generic source

**FINAL VERDICT: `PASS_WITH_EXPLICIT_LIMITATIONS`.**
