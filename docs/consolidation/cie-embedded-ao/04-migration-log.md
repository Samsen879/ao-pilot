# Phase 5 — Migration Log

All times are 2026-07-31 Asia/Shanghai unless otherwise stated. This is an append-oriented engineering record: failed attempts and review findings remain visible instead of being rewritten as success.

## M0 — Freeze and isolate

- Verified two independent repository roots, remotes, branches, HEADs, trees and clean status.
- Preserved CIE local `main` at `5bb8b495…`, including its local-only `agent-orchestrator.yaml` commit.
- Fetched remote refs read-only and based the CIE migration on exact `origin/main` `a670ecf526…` in governed worktree `.worktrees/task-local--ao-consumer-cutover`.
- Created AO branch `codex/cie-ao-consolidation` and CIE branch `task/local-ao-consumer-cutover`.
- Declared current live AO sessions, handoffs, state and adjacent AO worktrees out of scope. No AO start/stop/manage operation was run.

## M1 — Baseline verification

- Installed both locked npm dependency graphs using `npm ci` and isolated `/tmp` caches.
- Reclassified initial loopback/child-process `EPERM` results by identical narrow-permission reruns.
- Captured AO's green baseline and CIE's complete broad-suite/lint pre-existing failures in `00-baseline.md`.
- Removed only a command-generated baseline eval artifact after verifying its provenance; no user file or historical AO state was deleted.

## M2 — Product baseline hardening

- Inspected `origin/codex/release-hardening` commit `c61de55d4d69af3a46770c621b4bba79505fd5f8` as a direct child of the initial AO HEAD.
- Confirmed it contains packaging, Jest 30 and release verification work rather than a competing kernel implementation.
- Cherry-picked locally as `a1a3d5977bc9c30580ef14d0bdb07e32d6d9d745` (`chore: harden the 0.2.0 release`).

## M3 — Inventory, classification and target boundary

- Enumerated source, CLI, test, fixture, schema, config, workflow, documentation and artifact surfaces in both repositories.
- Calculated exact Git blob identity and drift: 41 exact production blobs, 21 drifted same-path production files, seven AO-only and two CIE-only production modules.
- Traced CIE callers through `package.json`, `agent-orchestrator.yaml`, workflow closeout/preflight and the AO operations workflow. Application code under `api/**` and `src/**` had no direct embedded-core module import.
- Classified external action effects as the highest-risk semantic difference and metrics/evaluation shape as an approved compatibility difference.
- Chose `notify_human_ready` as the conservative generic release default. CIE's own orchestration policy explicitly says lifecycle is decide-only/no-merge.

## M4 — Generic capability and package migration

| Commit | Migration | Source evidence | Target / behavior |
|---|---|---|---|
| `9570878e081b79097d19d5b1ad1a7351fc8c76fd` | guarded action effects | CIE `blocked-notification-transport.js`, real `gh` effect branches in `action-executor.js` | AO generic transport/runner seams; effects disabled unless injected; default release remains notification |
| `b248e92208fb8eac06660f0b0d5d4319c36e7193` | stable package boundary | baseline had only `package.json#bin` | `main`, allowlisted `exports`, aggregate and scoped library APIs, named CLI runners, packed-import checks |
| `43c72b1ab38e375f36d63666575c54bb56ad0a66` | project identity | PR-scoped commands could fall back to `my-project` | configured project id is carried through PR scope |
| `99106f097154e7d1d36110cf12dd058bec2ecaae` | parity harness | copied tests compared one implementation only | deterministic semantic replay, normalization, fingerprints and optional CIE comparison |
| `5823b8014b9a0893c17758503d067ae7d0dd3bb3` | provider public seam | CIE called internal transport/runner code | action executor, command runner and notification transport exposed through declared public subpaths |
| `34edb3a43510456795bb01ae54c1ffc134e00788` | difference registry | 85 legitimate AO/CIE differences | eval/metrics path-prefix groups are aggregate-fingerprint-bound; action differences are exact-path/value-bound; stale or new drift fails |

No state/domain contract, persistence, migration, reconciliation, handoff, review or checkpoint source was blindly copied: the principal implementations were already exact blobs or AO was more complete. The only missing generic capability moved from CIE was the effect mechanism; CIE endpoint/default policy was not imported.

## M5 — Safety review and hardening

An independent code review rejected the first effect cutover. It found exact-head TOCTOU, already-merged false success, missing TaskSpec review enforcement, mixed CheckRun/StatusContext false-green behavior, missing cwd propagation, runner-shape mismatch, ambiguous durable-only execution and weak idempotency/risk metadata. The cutover was not declared complete at that point.

The following focused commits closed those blockers:

| Commit | Evidence-backed correction |
|---|---|
| `cb0676335216c04aeb465096f6cdff104ecfad4c` | enforce TaskSpec `independent_review`, require a current-head PASS, propagate repository cwd and notification transport, export `runControllerLoop` |
| `219d060f5804468c06663e8edc9d74671347cdb6` | use `--match-head-commit`; confirm live exact head after merge/already-merged; handle CheckRun and StatusContext fail-closed; reject `UNSTABLE`; support callable and `{run}` runners; persist the exact effect statuses `durable_only`/`attempted`/`succeeded`/`failed`, with unconfirmed represented as `execution.outcome=effect_attempted`; require durable exact-head authorization for merge; mark merge irreversible |
| `07537fc094fe5738fda5ac664ff5c2830913ec58` | honor caller-supplied cwd in every library CLI runner |
| `03b3951e489bba8c46fca27cf05c0ac1778c2034` | pin hardened effect behavior into parity expectations |
| `72b3b81` | repair the final public-controller fixture so a reviewed/head-matched PR is still blocked until a durable authorization record is attached; then verify the authorized fake-provider flow |
| `d7a18a9c8a5a1d616c75ce5219e0d48b892b0174` | treat every post-dispatch merge-command failure as ambiguous; immediately re-read live PR state, accept success only for the exact merged head, otherwise retain `effect_attempted` with automatic replay blocked |
| `fb6c04f546d049a257f52886d8bc22fe4b78073a` | migrate the deleted CIE state-contract characterization oracle into AO: public vocabulary, metric count-map normalization, checkpoint task identity and review baseline shape |

The final full-suite run initially caught the stale controller expectation at `03b3951`: 71/72 suites and 365/366 tests passed, while the fixture expected merge despite the new authorization gate. The fix changed the fixture, not the safety gate. After the ambiguous-effect and state-oracle commits, the narrowly permitted full AO run at `fb6c04f` passed 73/73 suites and 371/371 tests (Jest 8.208 s); the sandbox-only first attempt differed solely because the localhost relay could not bind `127.0.0.1` (`EPERM`).

## M6 — CIE consumer boundary and cutover

| CIE commit | Result |
|---|---|
| `4de96ce29` | added package-boundary guard and CIE public-consumer tests |
| `7bf90defb` | declared runtime dependency `ao-pilot: file:../ao-pilot`; added `ao.config.json`; rewired npm, YAML, workflow closeout, CI and active runbooks to public CLI/package entrypoints |
| `d68243fe1` | after caller/parity/package gates, deleted embedded generic CLI/core/tests/fixtures and updated the preflight fixture |
| `4a5f83f33b51063c7d60003dd4455c40e1b1f4ed` | closed the deleted-test audit: restored CIE adapter/runbook/topology/roadmap contracts on the package boundary, restored the secret-symlink security oracle and added an installed-CLI state -> reconcile -> lifecycle smoke |

CIE npm command names remain stable, so workflow callers keep `ao:doctor`, `ao:lifecycle`, `ao:manage`, and related contracts while the implementation resolves through installed `ao-pilot`.

## M7 — Duplicate removal

The deletion commit touches 183 tracked files and deletes 182 of them, with 43,012 deleted lines (the remaining preflight fixture changes two expectation lines):

- 12 top-level `scripts/ao-*.js` generic CLI facades;
- 61 generic files under `scripts/ao/**`, plus the copied operator smoke runner;
- 108 Jest/fixture paths under `tests/ao/**`, subject to the disposition audit below;
- no CIE domain validator, live state, generated evidence, prompt, Skill or historical report.

The only remaining code under CIE's AO-named source/test paths is allowlisted and CIE-owned:

- `scripts/ao/start-clean.sh` — agent-orchestrator bootstrap adapter;
- `scripts/ao/validate_9709_active_issue_manifest_v1.py` — 9709 manifest validator;
- `tests/ao/test_validate_9709_active_issue_manifest_v1.py` — validator contract test.

### Deleted-test disposition audit

Path comparison against canonical AO found that 96 of the 108 deleted
`tests/ao/**` paths already had the same path in AO. Three more generic paths are
covered in a different shape: the delivery/handoff and observation-routing cases
are present in `tests/ao/controller-loop.test.js`, and
`tests/ao/helpers/controller-loop-fixtures.js` is inlined there. The one missing
generic oracle, `tests/ao/state-contracts-characterization.test.js`, was migrated
by `fb6c04f` with all four characterization cases.

Eight deleted paths were CIE-owned configuration/runbook/security contracts, not
generic AO duplicates:

- `tests/ao/control-plane-{assist,closeout,continuity,phase6}-contract.test.js`;
- `tests/ao/entry-topology-contract.test.js`;
- `tests/ao/orchestrator-decision-matrix-contract.test.js`;
- `tests/ao/orchestrator-secret-symlink-contract.test.js`;
- `tests/ao/roadmap-completion-contract.test.js`.

Their old assertions included superseded embedded-script and default-auto-merge
wording, so restoring them byte-for-byte would have been wrong. CIE commit
`4a5f83f33b51063c7d60003dd4455c40e1b1f4ed` instead adds eight updated adapter
contract cases covering the seven runbook/topology files plus the historical
roadmap contract, and three dedicated secret-symlink security cases. It also adds
one process-level installed-CLI state -> reconcile -> lifecycle smoke. The final
CIE consumer command passed 4/4 suites and 21/21 tests; boundary guard, two
workflow suites (18/18 tests), and the 9709 validator contract also passed. The
test-removal disposition is therefore closed without reintroducing embedded
generic code.

## M8 — Final exact verification

- AO runtime `fb6c04f` passed 73/73 suites and 371/371 tests; its public-documentation descendant `f9d56b3` was exported with `git archive`, packed as 140 entries / 172,340 bytes and fingerprinted SHA-256 `780d710c65683672fafe78c47f3cd4f0a106a99ad70e4094614c1bb848663fb8`.
- A fresh real-sibling export of AO `f9d56b3` and CIE `4a5f83f33` passed 4/4 consumer suites / 21/21 tests, the boundary guard, binary smoke and workflow fixture smoke.
- The same CIE commit installed the tarball without any sibling AO directory. The installed AO was a regular directory; 4/4 consumer suites / 21/21 tests, boundary, workflow, all seven public imports and installed-CLI `state -> reconcile -> lifecycle` passed, while the deep import failed as required.
- CIE's final broad run was 552 suites (531 passed / 21 failed) and 3,892 tests (3,843 passed / 49 failed). The 21 failing suite identities match the post-deletion snapshot and no new failure was introduced. Lint remains the exact baseline 47 errors / 11 warnings; build passed 2,502 modules.
- Fresh CIE installation reported 24 dependency vulnerabilities (1 low / 5 moderate / 18 high). This is retained as an important dependency warning, not relabeled as an AO assertion failure or claimed pre-existing without evidence.
- Final distribution review found the committed CIE workflow checkout has no AO `ref`; remote default `ba362622…` is package 0.1.0 without public exports. Local consolidation is complete, but remote release remains blocked until an authorized immutable AO revision/artifact is available and pinned.

## M9 — Rollback boundary

- AO changes are reviewable local commits rooted at initial `ba36262…`; use normal `git revert` in reverse order if a behavior regression is proven.
- CIE commit `7bf90defb` is the package cutover and `d68243fe1` is the duplicate deletion. Reverting the latter restores embedded source/tests; reverting both restores the pre-cutover caller graph.
- Reinstall from the selected lockfile after a dependency rollback.
- Do not rewrite history, delete `.ao-control-plane`, mutate a live provider, or use `reset --hard`/`clean` as rollback.

## Remaining deliberate limitation

If a process dies after a provider performs an external effect but before its success receipt becomes durable, the action remains `execution.outcome=effect_attempted` with `effect.status=attempted` and is not automatically replayed. There is no claim-resolution CLI/API. An operator must inspect live provider state first and then perform a deliberate, audited manual durable-state repair. This is fail-closed and avoids a duplicate irreversible effect; it is not falsely reported as exactly-once delivery.
