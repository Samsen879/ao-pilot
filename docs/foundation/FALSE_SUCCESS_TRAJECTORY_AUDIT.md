# False-success trajectory audit

Status: deterministic negative-fixture gate for issue #13. This layer audits
the F01 inventory without renaming production vocabulary, remediating state,
or classifying outcomes with a model.

## Contract

The versioned fixture pack is
[`tests/ao/fixtures/false-success-trajectories/pack.v1.json`](../../tests/ao/fixtures/false-success-trajectories/pack.v1.json).
It reproduces false-success and unknown-outcome claims across every one of the
50 rows in the F01 vocabulary inventory. The cases keep these facts separate:

- local PASS, lifecycle readiness, an executed action, or a valid checkpoint
  is not provider merge evidence;
- dispatch or an adapter receipt is not an external effect outcome;
- queued/not-run CI is not execution, aggregate passing is not exact-head
  required-check success, and runner/startup failure is not code failure;
- aggregate approval or a review on another commit is not a submitted
  exact-head review; success requires the connector identity, a submitted
  `COMMENTED`/`APPROVED` review, protocol `PASS`, independent-role evidence,
  and exact commit binding;
- specialized operational receipts prove only their declared scope; and
- missing or unknown external evidence remains blocking during replay.

The evaluator emits one durable blocking finding per negative fixture. A
finding fingerprint is SHA-256 over canonical semantic fields and excludes
wall-clock time, filesystem paths, and object insertion order. The committed
[`false-success-trajectory-audit.v1.json`](false-success-trajectory-audit.v1.json)
maps every F01 `item_id` and field to its fixture ids, policies, concrete
observed values, and durable finding fingerprints. Every fixture must provide
an inventory-valid observed value for each credited row, and the canonical
evidence digest is bound into its finding fingerprint. Its
`unresolved_producer_count` records the distinct
fixture producers that remain deliberately unresolved; none can be promoted
to success by this audit.

Cross-field checks reject impossible checkpoint and lifecycle combinations:
valid checkpoints cannot carry invalidity reasons, reason codes require an
invalid/stale state, and ready-notification and human-gate actions must match
their release disposition, basis, class, top status, and automation posture.
The full canonical fixture-pack digest and each observation digest are also
bound into the committed report, so an input-only semantic change cannot reuse
an old report fingerprint.

## Deterministic runner

Regenerate the durable report only when intentionally changing the pack or
inventory:

```sh
npm run audit:false-success
```

The release/CI gate is read-only:

```sh
npm run verify:false-success
```

Both modes run the audit twice from cloned inputs and reject any fingerprint
or report drift. Check mode additionally requires byte equality with the
committed report.

## Regression and mutation gates

`tests/ao/false-success-trajectory-audit.test.js` covers all negative paths,
all unknown-outcome paths, stable double replay, positive evidence controls,
and mutations for missing coverage, unsupported producer values, false
expected success, and a negative fixture silently becoming allowed. The
existing F01 regression suite continues to cover its success, failure,
missing-evidence, and replay scenarios.

## Non-goals

This audit does not define the Completion Record, migrate production
vocabulary, perform provider actions, repair findings automatically, or add a
model-based classifier. Later Foundation issues retain those responsibilities.
