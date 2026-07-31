# Phase 7/8 — CIE Cutover and Duplicate Removal Report

Current status: **the local generic consumer cutover, source deletion and CIE-owned test disposition are complete; the release gate remains blocked on an immutable remote AO dependency**.

## Consumer ledger

| Consumer | Embedded baseline | Final boundary | Evidence |
|---|---|---|---|
| CIE npm `ao:*` scripts | `node scripts/ao-*.js` | installed `ao-pilot <command>` | `package.json`, `package-lock.json`, consumer test |
| `agent-orchestrator.yaml` C2/C4/C5 | direct local scripts | npm aliases / installed CLI; CIE no-merge policy retained | YAML scan and boundary guard |
| workflow task closeout | `node scripts/ao-manage.js retire` | `npm run --silent ao:manage -- retire` | `scripts/workflow/cli.js`, workflow tests |
| AO operations gate | embedded test/smoke/direct script help | sibling checkout from the AO remote default branch + public consumer/boundary/smoke/help | `.github/workflows/ao-operations-gate.yml`; checkout has no `ref` and is not bound to the verified local AO SHA |
| preflight required command | presence of `ao:doctor` | same npm name, package implementation | codex-preflight fixture |
| active operator runbooks | embedded node paths | public package/npm commands | setup runbooks and smoke guide |
| embedded generic tests | deep imports from `scripts/ao/lib/**` | AO-owned generic suite plus CIE package/boundary/adapter/security tests | deletion diff, no-deep-import scan and CIE `4a5f83f33` |
| 9709 validator/workflow | CIE Python implementation | retained unchanged | exact validator test and allowlist |

No production JavaScript under CIE `api/**` or `src/**` imported the embedded core at baseline. The meaningful cutover therefore occurred at CLI/process/config/workflow boundaries, not by fabricating an application-module adapter that had no caller.

## Declared package dependency

CIE now declares:

```json
"dependencies": {
  "ao-pilot": "file:../ao-pilot"
}
```

`ao.config.json` pins `project_id` to `ciecopilot-home` and declares the agent-runtime/source-control provider names. All consumption is through the binary or these public subpaths only:

```text
ao-pilot
ao-pilot/cli
ao-pilot/contracts
ao-pilot/repository
ao-pilot/engines
ao-pilot/protocols
ao-pilot/providers
ao-pilot/package.json
```

The nested governed CIE worktree required a temporary ignored symlink at its logical sibling location solely for local `file:../ao-pilot` resolution. It is not tracked, is not part of either commit, and is removed after final verification. Fresh verification uses real sibling directories and packed artifacts under `/tmp`, so success does not depend on that symlink.

## Boundary guard

`scripts/quality/ao-package-boundary-guard.mjs` fails on:

- any top-level embedded `scripts/ao-*.js` CLI;
- any unallowlisted file under `scripts/ao/**` or `tests/ao/**`;
- production references to embedded script/core paths;
- package imports outside the declared export allowlist;
- wrong dependency scope/value or wrong project id;
- SHA-256 duplicates of key canonical contracts copied back under another production name.

Directories containing historical evidence, docs, tests, build output or runtime state are excluded from the production duplicate scan by design; the guard is for executable-source reintroduction, not deletion of audit history.

Final source scan result: zero violations, zero forbidden embedded core paths and zero forbidden package deep imports.

## Deleted duplicate core

CIE commit `d68243fe1` touches 183 tracked files and deletes 182 of them / 43,012 lines after the package caller gates passed:

- 12 duplicate CLI entrypoints;
- 61 generic core modules plus the copied generic smoke runner;
- 108 Jest/fixture paths, of which 100 generic oracles are now present or behaviorally absorbed in AO and eight CIE-owned contracts were rewritten at the CIE package/adapter boundary;
- the embedded implementation-coupled test topology.

The broad CIE baseline failures are still present and are reported rather than suppressed. Independent post-deletion audit found that the deletion was initially too broad at the test boundary; the corrective disposition below makes that history and its replacement evidence explicit.

### Deleted-test disposition

- 96 deleted paths already had same-path canonical AO coverage at deletion time;
  the migrated state-contract oracle makes that 97 now.
- `controller-loop-{delivery-handoff,observation-routing}.test.js` and the
  controller-loop fixture helper are covered/inlined in AO's consolidated
  controller-loop suite.
- `state-contracts-characterization.test.js` was the only missing generic oracle;
  its four cases moved to AO in `fb6c04f546d049a257f52886d8bc22fe4b78073a`.
- Eight paths are CIE-owned runbook/configuration/security contracts:
  `control-plane-{assist,closeout,continuity,phase6}-contract.test.js`,
  `entry-topology-contract.test.js`, `orchestrator-decision-matrix-contract.test.js`,
  `orchestrator-secret-symlink-contract.test.js`, and
  `roadmap-completion-contract.test.js`.

The eight CIE-owned files could not be restored unchanged because several old
assertions named the embedded CLI or default auto-merge behavior. Commit
`4a5f83f33b51063c7d60003dd4455c40e1b1f4ed` replaces them with eight updated
adapter cases for package commands, entry topology, decision matrix, no-merge
assist, closeout, continuity, phase-6 evidence and historical-roadmap status,
plus three dedicated secret-symlink security cases. The same commit adds one
installed-CLI state -> reconcile -> lifecycle smoke. `npm run ao:test:consumer`
then passed 4/4 suites and 21/21 tests. This closes the CIE test-preservation gate
without restoring a generic implementation.

## Retained CIE-specific components

| Path / surface | Reason retained |
|---|---|
| `ao.config.json` | CIE project/provider/evaluation configuration |
| `agent-orchestrator.yaml` | CIE orchestration adapter and no-merge operational policy |
| `scripts/ao/start-clean.sh` | repository-specific agent-orchestrator bootstrap |
| `scripts/ao/validate_9709_active_issue_manifest_v1.py` | 9709 campaign/parent manifest rule |
| `tests/ao/test_validate_9709_active_issue_manifest_v1.py` | domain validator contract |
| `tests/ao-consumer/cie-ao-adapter-contract.test.js` | CIE package/runbook/topology/roadmap adapter contract |
| `tests/ao-consumer/orchestrator-secret-symlink-contract.test.js` | CIE worktree secret-symlink security policy |
| workflow/VLM validators and Skills | 9709 data/evidence/custody domain, not generic AO |
| `.ao-control-plane/**`, artifacts and historical reports | durable/live or audit evidence; never source duplication |

## Deletion-gate evidence

| Gate | Result |
|---|---|
| production consumers cut over | passed by npm/YAML/workflow/docs scan |
| required parity | stable fingerprint, 85 approved and zero unapproved differences |
| AO isolated package install | passed public exports/CLI/runtime assets/deep-import rejection |
| CIE consumer integration | passed package consumer and boundary suites |
| capability only in embedded code | none; CIE effect mechanism migrated and hardened first |
| CIE domain code retained | validator/bootstrap/config/workflow allowlist intact; CIE-owned adapter/security oracles retained on the consumer boundary |
| CIE-specific test preservation | passed at `4a5f83f33`: 8 adapter + 3 secret-symlink cases, plus one installed-CLI workflow smoke; consumer total 4 suites / 21 tests |
| remote workflow exact AO binding | **blocked**; workflow checkout has no immutable `ref` and therefore does not select the verified local canonical SHA |
| rollback documented | below and in `04-migration-log.md` |

Final exact consumer proof used clean Git archives of AO `f9d56b3` (runtime parent `fb6c04f`) and CIE `4a5f83f33`. The real-sibling and tarball-isolated layouts each passed 4/4 consumer suites / 21/21 tests and zero boundary violations. The isolated install had no sibling AO directory, resolved `node_modules/ao-pilot` as a regular directory, loaded all seven public groups, rejected the deep import, printed version 0.2.0 and ran installed `state -> reconcile -> lifecycle`. The 140-entry tarball is 172,340 bytes with SHA-256 `780d710c65683672fafe78c47f3cd4f0a106a99ad70e4094614c1bb848663fb8`.

## Rollback

The rollback path is history-preserving:

1. Stop any newly started AO consumer process using the normal operator procedure; this consolidation did not start one.
2. Revert CIE `d68243fe1` to restore the embedded source/tests.
3. Revert CIE `7bf90defb` to restore embedded callers and dependency metadata.
4. Reinstall the selected lockfile with `npm ci`.
5. Leave `.ao-control-plane`, provider state and historical artifacts untouched.

If only a canonical AO regression is found, revert the relevant focused AO commit and rerun packed/CIE consumer gates before changing CIE. No rollback uses destructive history rewriting, `git clean`, or remote mutation.

## Publication limitation

The local source-of-truth boundary is complete, but `file:../ao-pilot` requires both repositories at the expected sibling paths. No push or npm publish was authorized. The current CIE workflow checks out `Samsen879/ao-pilot` without `ref`, so it follows the remote default branch and is **not** bound to the locally verified canonical SHA. The locally fetched remote default is `ba362622…`, package 0.1.0 without the required public `exports`; it therefore cannot reproduce the verified consumer boundary. This is a release blocker, not proof of an exact dependency. A separately authorized release must first make the canonical AO commit remotely resolvable and then pin the workflow to an immutable commit/tag or install an immutable packed/published package. No documentation should describe the current workflow as checking out the exact local revision.
