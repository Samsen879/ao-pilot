# Phase 4/9 — Behavioral Parity Report

Final status: **passed with 85 fingerprint-bound approved differences and zero unapproved differences**.

## Harness and comparison contract

The canonical harness is implemented in:

- `scripts/consolidation/parity-harness.js`;
- `scripts/consolidation/fixtures/generic-v1/scenario.json` and its eval pack;
- `scripts/consolidation/fixtures/approved-differences.json`;
- `tests/consolidation/parity-harness.test.js`.

It compares observable semantic objects rather than source text or incidental console formatting. Recursive key ordering is canonicalized, and timestamps, PID values, temporary roots and platform path separators are normalized before SHA-256 fingerprinting.

The fixture exercises:

| Observable | Evidence in the fixture |
|---|---|
| input state / migrations | schema bootstrap through v10, collection set and idempotent replay |
| observation | AO worker/orchestrator and GitHub PR normalization |
| reconciliation | PR/task/ownership binding and finding set |
| diagnostics | doctor status, findings, source health and suggestions |
| lifecycle/policy/action | routing, release, policy decision, action model and durable effect receipt |
| review/freeze | exact target head, PASS verdict and freeze inspection |
| handoff/checkpoint/recovery | checkpoint validity, resume, request/claim lineage and replay |
| metrics/evaluation | bounded metrics, deterministic eval replay, scorecard and quality gate |

## Stable fingerprint

```text
fixture_id:                 generic-control-plane-parity-v1
standalone_expected:        6f81aed7a563f69bad533ebb4cb99c7c62fbf6d8cec5417806ed97e3afd9cca6
standalone_actual:          6f81aed7a563f69bad533ebb4cb99c7c62fbf6d8cec5417806ed97e3afd9cca6
standalone_expectations:    0 failures
cross-repository status:    passed
cross-repository diffs:     85
approved:                   85
unapproved:                 0
CIE expectation failures:   0
```

The CIE oracle was `/home/samsen/code/ciecopilot-home` at local initial HEAD `5bb8b495…`. Its only local-only change is `agent-orchestrator.yaml`; embedded AO source matches the inventoried line for the compared modules. The migration worktree itself no longer contains a duplicate implementation after deletion.

## Shared zero-difference behavior

The normalized shared subset had no semantic difference for:

- state contracts and schema-v10 migration;
- observation and reconciliation;
- doctor and lifecycle results for the shared fixture;
- policy decision;
- checkpoint/resume;
- independent review/freeze;
- handoff lineage.

This is consistent with the exact Git blobs identified in `01-inventory.md`, but the result comes from executed behavior rather than blob identity alone.

## Approved differences

| Group | Paths | Why approved |
|---|---:|---|
| modular evaluation / scorecard | 74 | AO has deterministic replay, scenario catalog, scope hash, richer failure/intervention distribution and quality gate absent from the embedded copy |
| bounded metrics | 7 | AO adds explicit time window, measurement/failure/intervention counts and rates |
| action effect contract | 4 | AO now exposes remote-effect absence, `durable_only`, effect kind and retryability instead of allowing `executed` to imply an unproven provider effect |

The registry uses two explicit binding schemes. The evaluation and metrics groups
are each bound to a `path_prefix` plus an aggregate `difference_fingerprint` over
the whole matching diff set. The four action approvals are each bound to one
exact `path` plus the expected standalone and CIE values. The test suite
mutates/removes approval metadata and proves that a stale, missing or new
difference fails. `unused_approvals` is empty.

## External-effect parity and safety

No production GitHub merge, webhook, deployment or other provider write was executed. Tests inject fake command runners/transports and assert program, ordered argv, cwd, exact PR/head and sanitized receipts.

The final behavior contract is:

1. `state_only`/`durable_only` explicitly means no provider effect was intended or confirmed.
2. A notification without an injected transport remains proposed/blocked; it is not counted as externally executed.
3. A merge needs an allow policy, clean runtime preflight, TaskSpec review compliance, current-head PASS review, durable explicit authorization bound to the same head and an injected runner.
4. The merge command includes `--match-head-commit`; success and already-merged paths re-read live state and require the exact head.
5. CheckRun and StatusContext rollups fail closed on failure, pending, error, missing/unknown or `UNSTABLE` results.
6. Effect `status` is limited to `durable_only`, `attempted`, `succeeded`, and `failed`; an unknown provider result is `execution.outcome=effect_attempted`, not a fifth status.
7. A merge command's nonzero exit, signal or throw is treated as ambiguous after dispatch. AO immediately re-reads the PR and accepts success only when the exact reviewed head is confirmed merged; otherwise the `attempted` claim suppresses automatic replay.
8. There is no claim-resolution CLI/API. Recovery requires a live provider-state check followed by deliberate audited manual repair of durable state.

The public-controller integration deliberately executes two stages: the first pass proposes but blocks auto merge because authorization is missing; the test then writes an explicit exact-head authorization into the durable action and calls the exported executor with a fake provider. Only that second stage records `executed/effect=succeeded`.

## Required test levels

| Level | Test/command | Final evidence |
|---|---|---|
| unit parity | `tests/consolidation/parity-harness.test.js` | six harness contract tests, including normalization and approval fail-closed cases |
| fixture replay parity | `node scripts/consolidation/parity-harness.js --cie-root /home/samsen/code/ciecopilot-home` | fingerprint matched; 85/85 approved; zero expectation failures |
| state migration/contract parity | generic-v1 migration observable plus `tests/ao/state-contracts-characterization.test.js` | schema v10/idempotent replay plus exported vocabulary, normalized metric maps, exact checkpoint task identity and object-shaped review baseline |
| CLI contract parity | AO CLI suites + CIE consumer suite | 13-command dispatch/aliases, cwd/config identity, help/version/JSON semantics and installed-CLI state -> reconcile -> lifecycle smoke |
| package installation | `npm run verify:package` + fresh packed consumer | public imports load from isolated install and unexported deep import is rejected |
| CIE consumer integration | `npm run ao:test:consumer` | 4/4 suites and 21/21 tests: package imports, boundary, CIE adapters/runbooks/topology, secret-symlink policy and process-level CLI smoke |
| recovery/idempotency | action, controller, checkpoint, handoff and review focused suites | event dedupe, checkpoint resume, effect-attempt replay suppression and current-head review enforced |

Commit `d7a18a9c8a5a1d616c75ce5219e0d48b892b0174` adds the
ambiguous-command/live-confirmation and replay-suppression tests. Commit
`fb6c04f546d049a257f52886d8bc22fe4b78073a` restores the four state-contract
characterization cases identified by the deleted-test audit. At `fb6c04f`, the
full narrowly permitted AO run passed 73/73 suites and 371/371 tests.
The CIE-side deleted-test disposition landed in
`4a5f83f33b51063c7d60003dd4455c40e1b1f4ed`; its 4-suite/21-test consumer run
passed with the installed package boundary and no restored embedded kernel.

Exact final command counts/durations are recorded in `FINAL_CONSOLIDATION_REPORT.md` and `consolidation-manifest.json`.

## Intentional behavior changes

- Generic release-ready default is `notify_human_ready`; embedded auto merge is not the CIE default after cutover.
- Provider-effect `executed` now requires confirmation; prior ambiguous state-only completion is rejected.
- Auto merge is an `irreversible_remote_effect`, not a class-A/audit-only action, and requires durable exact-head authorization.
- AO's richer metrics/evaluation output is canonical and retained rather than truncated to the CIE shape.
- All library CLI runners honor the supplied cwd, preventing effects or state discovery in the process's unrelated cwd.

## Explicit limitation

The provider-effect protocol is a non-atomic claim/receipt protocol with fail-closed replay suppression; it is neither atomic exactly-once nor guaranteed at-least-once across filesystem state and an external provider. A crash after the remote effect and before receipt persistence requires live provider-state reconciliation and then an audited manual durable-state repair because no claim-resolution CLI/API exists. Automatic retry in that condition is intentionally forbidden.
