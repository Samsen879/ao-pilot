# Trajectory and outcome vocabulary audit

Status: the issue #12 audit baseline is preserved and its v1 inventory now
includes the issue #20 release-judgment migration. Completion Record storage
is unchanged.

## Reconciled baseline

The issue body records the pre-bootstrap baseline
`e51bef40ccd124939b2781b14af3297e856c6f17` / tree
`67aa09d8b11a6532876353f500df7fb529e4d9b5`. That commit is an ancestor of
the explicitly admitted and current live main
`d39a5bdac7be786c6c2d7ab7a6334c21e7432998` / tree
`5e897f99f3891adc0e8b271693b86e3eb64c8166`.

The intervening accepted inputs are not #12 scope drift: PRs #64 and #65
establish P0-R01/R02; issue #58 closes P0-R03 with the public immutable
`agent-orchestrator` artifact (its delivery is in that external repository);
PR #66 establishes the P0-R04 lock/provenance contract; #67–#69 establish
P0-R05–R07; and #70–#75 are the admitted P0-R08 self-hosting/recovery chain.
Issue #63's
immutable v8 receipt is comment `5173907118`; protected run `30872041709`,
job `91885181075`, completed successfully on `d39a5bd`. The #7 and #12
admission comments both bind that SHA/tree. Therefore #12 starts from the
live/admitted base, while the issue-body SHA remains historical baseline
context.

## Versioned inventory and producer/consumer matrix

[`trajectory-vocabulary.v1.json`](trajectory-vocabulary.v1.json) is the
normative audit ledger. Each `items[]` row is one producer/consumer matrix
row and declares:

- the exact trajectory field (or an explicitly enumerated field group);
- its complete current value vocabulary;
- one semantic owner and one evidence authority;
- its future Episode role;
- the defining source symbol, producer symbols, and consumer/caller symbols.

The inventory covers all current families requested by #12: lifecycle action
ids/classes and durable action status; action/effect/command/transport and P0
specialized receipts; lifecycle top/routing/release/gate/automation
dispositions; local and GitHub review states; normalized and raw CI classes;
provider PR/mergeability/legacy confirmation observations; and every leaf in
the checkpoint record through exhaustive field-group rows. Grouped checkpoint
rows are used only where all leaves have the same owner, authority, producer,
and consumer.

Run the source-symbol coverage gate with:

```sh
npm run verify:trajectory-vocabulary
```

The gate rejects missing families, duplicate ids/values, missing owners or
authorities, absent definitions, missing producer/consumer field or call
evidence inside the named function, unknown ambiguity references, and any
attempt to give AO judgment, OR effect, and provider outcome the same
normalized owner or authority. It also validates the four required fixtures:

- `tests/ao/fixtures/trajectory-vocabulary/success.json`
- `tests/ao/fixtures/trajectory-vocabulary/failure.json`
- `tests/ao/fixtures/trajectory-vocabulary/missing-evidence.json`
- `tests/ao/fixtures/trajectory-vocabulary/replay.json`

Replay validation resolves `replay_of` and compares canonicalized semantic
projections in the advertised CLI gate. The success fixture uses current
`release_ready` vocabulary while the replay fixture retains the legacy
`notify_human_ready` source value; the observation projection maps only that
versioned alias. A missing target, changed semantics, key ordering, or a fresh
read cannot silently change the replay result.

## Current implementation versus real OR production practice

| Concern | Current implementation | Real OR production practice | Episode implication |
| --- | --- | --- | --- |
| AO judgment | Reconciliation and lifecycle reports emit gate, routing, release, and automation dispositions. | AO may judge readiness and observe evidence but does not own the external provider effect. | Store as `judgment.*`, never as outcome. |
| Action state | `actions[].status=executed` and `payload.execution.outcome=executed` describe the assist executor's durable handling. | OR owns authorized Git/GitHub effects outside the AO state-writer queue. | Preserve AO action state and OR effect receipt as separate facts. |
| Effect evidence | The legacy assist executor can attempt notifications and guarded auto-merge, recording adapter receipts and immediate PR readback. | The upgrade program has OR execute bounded effects from exact-scope authorization. | Treat legacy effect fields as implementation history; normalize OR execution separately. |
| Provider result | GitHub observations normalize PR state, reviewDecision, checks, and mergeability. | Live GitHub/provider readback is the external outcome authority. | Only provider `MERGED` (with required identity/evidence in later schema work) can establish merge outcome. |
| Review | AO has a local review protocol; GitHub aggregate reviewDecision and every submitted review's id/state/actor/time/commit are separately observed. | Program gates use submitted GitHub Codex connector reviews, exact-head binding, finding dispositions, and a two-review cap. | Do not infer connector review from local `passed` or aggregate `approved`; retain per-review evidence. |
| CI | The collector compresses check rollups to passing/failing/pending/unknown while the inventory preserves distinct raw failure, error, startup, timeout, cancellation, queued/waiting, skipped/neutral, and not-run classes. | Required CI is evaluated from named provider checks on the exact HEAD. | Retain raw named checks and policy binding; aggregate status alone is insufficient for release or failure attribution. |
| Checkpoint | A checkpoint freezes task/spec/runtime/controller/action references and validates them against live repository state. | OR closeout additionally requires provider outcome, exact-main replay, resource cleanup, and admission receipts. | `checkpoint.valid` means replay-safe local continuity only, never terminal delivery. |
| P0 receipts | Specialized bootstrap/worktree/premerge/merge/done/self-hosting schemas provide strong immutable evidence. | They were produced for the P0 operational lane and are not the ordinary task trajectory schema. | Carry by artifact reference/digest; do not flatten their internal `status` fields into one task success flag. |

## Ambiguous, overloaded, or unverifiable vocabulary

The normative ambiguity ledger is `ambiguities[]` in the JSON inventory. The
highest-risk terms are:

1. `success`, `succeeded`, `executed`, `passed`, and `ready` span action state,
   effect adapter receipt, local review, CI, lifecycle judgment, and provider
   outcome. They are not interchangeable.
2. `review passed` can mean AO local review, GitHub aggregate approval, or an
   exact-head GitHub Codex connector review. Only the cited evidence authority
   can decide which meaning applies.
3. CI `passing` currently includes neutral/skipped conclusions; `failing`
   collapses code failure, runner/startup error, timeout, and cancellation; and
   required-check/not-run membership is absent. Preserve the distinct raw
   named checks and required-check policy.
4. `mergeable` and `auto_merge_ready_pr` are eligibility judgments;
   `effect_attempted` is execution evidence; only provider `MERGED` is the
   outcome.
5. `unknown`, `missing`, and `ambiguous` currently conflate absent evidence,
   unmapped source values, and genuine indeterminacy. Later normalization must
   retain source health/raw evidence and fail closed.
6. `checkpoint.valid` proves only that its captured local references still
   match. It does not prove review, CI, merge, replay, or cleanup completion.
7. `human_gate` requires its `basis`: source failure maps to retry, missing
   assessment to refresh, and authority ambiguity to escalation. The shared
   disposition alone cannot select the later Episode disposition.
8. `created_by`, `reason`, and checkpoint `metadata` are assertions without an
   independent authority. They may be useful context but cannot satisfy a gate.

## Audit conclusions

- Every inventoried item now has exactly one declared semantic owner and one
  evidence authority.
- AO judgment, OR effect, and GitHub/provider outcome are explicitly separated
  and mechanically prevented from sharing ownership/authority.
- The existing implementation contains enough source facts for a later Episode
  adapter, but does not yet provide the future Episode/Completion storage or a
  canonical terminal-delivery record. That work remains outside #12.
- No implementation symbol or lifecycle behavior is changed by this audit.
- #13 remains gated; these fixtures establish vocabulary coverage only and are
  not the false-success audit gate requested by #13.
