# Issue #97 governed headless runtime: R3 design and admission record

Status: **DESIGN ONLY — NOT ADMITTED FOR IMPLEMENTATION**

Observed at: 2026-09-04 (Asia/Shanghai)

Repository: `Samsen879/ao-pilot`

Issue: [#97](https://github.com/Samsen879/ao-pilot/issues/97)

This record is a bounded design review and admission assessment. It does not
change the runtime lock, runtime lifecycle, daemon, project registration,
Agent Orchestrator, Electron, desktop behavior, or any other project. No
upstream desktop acquisition/open command was invoked while producing it.

## Admission verdict

**HOLD.** The live Issue remains an "Unadmitted critical hardening backlog"
and expressly says it does not authorize runtime, runtime-lock, Electron,
desktop, project-registration, or daemon changes. It has no admission comment
or other grant. The unmet gate is a fresh, explicit Owner decision at
`r3_assist_or_release_cutover` that authorizes the bounded implementation
surfaces and effects described below. Independent acceptance of this design
must precede that decision.

Exact-final-head release attestation and post-effect observation/replay are
later R3 gates. They cannot exist for a design-only branch and must not be
used to manufacture admission. Release cutover and merge remain separately
Owner-gated even after an implementation is admitted and reviewed.

## Current authority and admission evidence

The following facts were re-fetched or observed from the governed worktree;
none is an implementation authorization.

| Gate or observation | Evidence | Result |
| --- | --- | --- |
| Live provider base | `origin/main` `ba3a94099c2052bec7388c6b7c76bfa2162fa7d8`; tree `0cbec4d423b12eb7b6569b2af3c98803e52b021c` | PASS |
| Issue authority | Issue #97 open, updated `2026-08-31T14:02:53Z`, status "Unadmitted critical hardening backlog", no comments | **BLOCKED** |
| Runtime lock identity | `runtime.agent_orchestrator.v0_11_2_p0_2`; normalized lock digest `sha256:7f2a295c6a68a36fcd05ac65ed1d8cf5bc24856168dafc0f2d878e3a94b30aae` | PASS |
| Immutable source | tag object `450ae009e2c1eb48cdf9c19be676b4a4ff01e611`; commit `aae8a684357271acc7ad2fa1d4116c7c65c8fa9d`; tree/integrity `e8adb9a31068810becfb5d31b46688b04202cf81` | PASS |
| Managed Linux x64 binary | exact managed path ending in `.../aae8a684357271acc7ad2fa1d4116c7c65c8fa9d/bin/ao`; SHA-256 `ad7fd23c6a3f495e2d10b130cf23227c14e30573db5c2c01b68d8214c5965b4d` | PASS |
| Static lifecycle routing | `start -> daemon`; `status -> status --json`; `stop -> stop --json`; PATH `ao` and desktop mutable start disallowed | PASS |
| Current daemon observation | exact managed binary reported `state=ready`, `health=ok`, port `3001`; runtime PID is intentionally not frozen as durable evidence | PASS (observation only) |
| Current runtime doctor | exact managed binary reported zero failures and identified itself as PATH `ao` | PASS (observation only) |
| Current project observation | project id `ao-pilot` exists for `Samsen879/ao-pilot`, rooted at `/home/samsen/code/ao-pilot` | PASS (observation only) |
| Design review | this proposal exists but has no independent acceptance | **NOT ESTABLISHED** |
| Rollback replay | plan exists below; no state-changing replay was authorized | **NOT ESTABLISHED** |
| Candidate exact-head review | no implementation candidate exists | **NOT ESTABLISHED** |
| Exact-final-head release attestation | no final implementation head exists | **NOT ESTABLISHED** |
| Post-effect observation/replay | no implementation, merge, or cutover effect occurred | **NOT ESTABLISHED** |

The project observation does not prove that an arbitrary path is authorized.
The future preparation request must bind the project id, repository identity,
and path supplied by the admission authority. It must not discover or select a
project merely because it is present in the runtime database.

## Current enforcement review

The existing layers establish valuable prerequisites but do not compose the
Issue #97 preparation boundary:

1. `runtime-resolver.js` validates lock/provenance/platform/binary identity,
   rejects symlinks, and rejects a different executable named `ao` on PATH.
2. `ao-runtime.js` maps ao-pilot `start` to the managed binary's direct
   `daemon` entrypoint. It never maps to upstream `ao start`.
3. `startVerifiedRuntimeDaemon()` observes status, starts only the resolved
   binary, and polls bounded readiness.
4. `verify:runtime-lifecycle` statically checks those exact-binary mappings.

The missing composition points are security-relevant:

- `--project` is parsed and configuration supplies it, but runtime
  start/status/stop do not use it to verify or register the authorized project.
- daemon readiness is accepted from `status --json`; a successful managed
  runtime `doctor --json` is not part of the startup gate.
- `runVerifiedRuntime()` and `runResolvedRuntime()` accept arbitrary argument
  arrays. Exact binary provenance alone therefore does not prevent a caller
  from requesting the managed binary's desktop-oriented `start` subcommand.
- there is no single idempotent transaction that snapshots daemon/project
  state, prepares them, emits a receipt, and restores only effects it created.
- there is no receipt-consumption rule at the governed Worker-spawn boundary.
  A preparation command that is merely optional would preserve the prompt-only
  weakness identified by the Issue.
- `scripts/ao/start-clean.sh` deliberately stops and restarts the daemon and
  treats stop failure as ignorable. It is an operator reset helper, not the
  idempotent R3 preparation or rollback contract.

## Enforcement-point threat analysis

| Threat | Required enforcement point | Required disposition |
| --- | --- | --- |
| Ambient, hostile, or dirty source-checkout `ao` wins PATH lookup | managed resolver before every child creation | fail before execution; receipt records the conflicting candidate without executing it |
| Runtime binary/provenance changes after initial resolution | guarded child-process adapter immediately before every spawn | re-stat, reject symlinks, re-hash the binary, and compare lock/provenance identity; no cached authorization across a spawn |
| Caller supplies upstream desktop `start`, desktop flags, or an unclassified subcommand | closed command grammar inside the guarded adapter | reject before `child_process.spawn`/`spawnSync`; do not pass through free-form runtime argv |
| Another module bypasses the guarded adapter | repository-wide static verifier plus code review | fail verification on production `spawn*` calls targeting a runtime path outside the adapter |
| Stopped daemon | preparation transaction | record `stopped`, start exact binary with `daemon`, then prove bounded status and doctor readiness |
| Readiness race or daemon exits during preparation | bounded status/doctor loop tied to the observed process/run identity | emit failure, admit no Worker, and execute owned-effect rollback |
| Missing project | admission-bound project policy, then exact managed `project get/add` grammar | add only when the authorization explicitly permits registration of the exact id/path/repository tuple |
| Existing project points at a wrong path/repository or has ambiguous identity | project verification before any Worker spawn | fail closed; never rewrite, remove, or auto-discover a replacement |
| Repeated preparation | transaction compares the exact before-state | return `already_ready` with no mutation when daemon and project already satisfy the contract |
| Partial project add or post-add mismatch | postcondition verification and owned-effect ledger | admit no Worker; remove only the exact record created by this invocation after proving no sessions depend on it |
| Direct external invocation outside ao-pilot | governed Worker admission boundary | it cannot produce/consume a valid readiness receipt and is therefore ineligible as governed execution |
| Desktop process appears despite pre-spawn rejection | pre-admission containment check and stop condition | admit no Worker; record detection, use only an independently authorized containment action, and escalate |
| Receipt replay, substitution, or secret leakage | closed schema plus consumer verification | bind request id, repository/project, base, runtime digests, before/after observations, expiry, and nonce; reject unknown fields and redact command output |

The same-user local attacker can replace files and race process creation. The
proposed re-verification narrows accidental and non-concurrent tampering but is
not a sandbox against a malicious process with the same OS authority. That
stronger security boundary would require separately admitted OS isolation and
is not claimed here.

## Proposed bounded implementation

### Canonical API and command

Add one package-owned operation, tentatively:

```text
ao-pilot prepare-runtime --project ao-pilot --project-path <authorized-path> --json
```

The command must load the repository configuration and a closed admission
input. CLI values may narrow or exactly repeat that input; they may not expand
it. The implementation should be confined to:

- a preparation CLI module and one orchestration library;
- a closed, exported readiness-receipt schema/contract;
- a guarded runtime-command adapter with an enumerated argv grammar;
- integration at the repository's governed Worker-spawn entrypoint;
- focused negative/idempotency/rollback tests and static bypass verification;
- documentation and a release-gate hook.

It must not change `runtime/agent-orchestrator.lock.json`, the runtime tag or
version, managed runtime source, Agent Orchestrator, Electron, desktop code,
browser preview, or another repository.

### Transaction and receipt

The preparation transaction should use these ordered phases:

1. Normalize the exact authorized repository id/slug, project id/path, allowed
   registration effect, timeout, request id, and runtime lock digest.
2. Resolve and verify the committed runtime and bootstrap receipt. Capture the
   daemon and exact project before-state without mutation.
3. Reject PATH/source ambiguity, project conflicts, unsupported platform,
   absent provenance, or any desktop-oriented command before process creation.
4. If needed, start only `<verified-binary> daemon`; poll both
   `<verified-binary> status --json` and `<verified-binary> doctor --json`
   within one monotonic deadline.
5. Verify the exact project. Register it only when it was absent and the closed
   admission input explicitly permits that exact tuple. Re-read and compare
   the full tuple after registration.
6. Re-observe daemon health and project identity, then atomically write a
   secret-free receipt. Only a fresh matching receipt may cross the governed
   Worker-spawn boundary.

The receipt should bind schema version, request/nonce, issue/admission ref,
repository numeric id and case-sensitive slug, base SHA/tree, project id/path
and repository, runtime ref/lock/source/binary digests, bootstrap receipt
digest, daemon before/after state and stable run identity, doctor result,
effects owned by this invocation, timestamps/deadline, final disposition, and
rollback result. Raw environment values, credentials, auth command output, and
unbounded stdout/stderr must be excluded.

The guarded adapter should accept only typed operations needed by this flow:
`status`, `doctor`, `daemon`, exact `project get`, exact `project add`, exact
`project rm` for owned rollback, and `stop` for owned rollback. There must be
no generic string-array escape hatch in the governed preparation path.

### Worker admission

The durable receipt is evidence, not authority by itself. The spawn boundary
must verify that the receipt:

- was created by the admitted preparation implementation;
- is fresh and matches the current repository/base/project/runtime tuple;
- reports a ready daemon and exact project with no pending rollback;
- has not already been consumed for a different spawn request; and
- contains no desktop detection or unresolved stop condition.

AO processes started manually or through an upstream desktop path cannot
produce this chain and must not be labelled governed. This repository-local
rule does not claim to prevent a user from launching unrelated software.

## Rollback plan

Rollback is an owned-effect compensation transaction, not "stop everything":

1. Persist the before-state and each completed mutation before attempting the
   next mutation.
2. On failure, first block Worker admission.
3. If this invocation registered the project, re-read it and confirm the exact
   id/path/repository tuple and absence of dependent sessions. Only then remove
   that record. Any mismatch or dependency stops rollback and escalates.
4. If this invocation started a previously stopped daemon, re-observe its run
   identity and stop it through the same verified binary. Never stop a daemon
   that was ready before the invocation or whose identity has changed.
5. Re-observe the resulting daemon/project state and write the rollback result
   to the receipt. Ambiguity leaves the system fail-closed; it does not justify
   destructive cleanup.

Code rollback after deployment is a normal revert only if no incompatible
receipt or external-state transition was introduced. Otherwise retain the
receipts, keep Worker admission closed, restore a compatible ao-pilot build,
and replay observation before resuming. Do not delete runtime stores, AO data,
sessions, worktrees, or project records as source-code rollback.

## Required implementation verification after admission

An admitted implementation candidate must add and pass, at minimum:

- hostile PATH and dirty-source fixtures proving zero candidate execution;
- upstream `start`/desktop argv fixtures proving rejection before spawn;
- a static bypass scan for production runtime process creation;
- stopped-daemon and status/doctor readiness-race fixtures;
- missing, wrong-path, wrong-repository, and unauthorized-registration project
  fixtures;
- repeated ready-state preparation proving zero mutation;
- partial-failure rollback and changed-identity non-rollback fixtures;
- closed-schema, replay, expiry, substitution, and secret-redaction tests;
- receipt-required Worker-admission tests;
- existing runtime resolver/control/bootstrap/fresh-clone/hostile-PATH tests;
- `npm run lint`, `npm test`, package verification, applicable runtime gates,
  and the full release check where the environment supports it.

Before merge or release, a fresh independent reviewer must bind the exact
candidate head/tree and negative-test results. A separate exact-final-head
attestation must then bind the immutable runtime identity and release gates.
After any authorized effect, a provider/runtime observation and rollback
replay must be captured. None of those later results is established by this
design record.

## Admission request for Owner review

To advance beyond this document, the Owner must explicitly decide whether to
authorize the repository-local design above under
`r3_assist_or_release_cutover`, including these effects:

- modify ao-pilot runtime-control and governed-spawn integration code;
- add the receipt contract, negative tests, and release verification;
- start/stop only an invocation-owned managed daemon in isolated fixtures;
- add/remove only an explicitly authorized, invocation-owned project record in
  isolated fixtures.

That authorization must continue to exclude runtime lock/tag/version changes,
Agent Orchestrator source changes, Electron/desktop work, upstream desktop
acquisition/open, other projects, merge, and release cutover.
