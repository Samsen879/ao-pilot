# Managed-task command transactions

`runManageCommand` commits enroll, adopt, resume, unmanage and retire as one
state transaction. Bootstrap/migration and pending-journal recovery finish
before command admission. The command then acquires the existing state write
lock, rereads durable state, validates review/checkpoint/handoff conditions,
and computes all changes against an in-memory repository view.

The transaction includes the task, TaskSpec, ownership leases, PR bindings,
execution-attempt metrics, and the handoff transfer/request completion made by
resume. The command's final continuity/review result is computed before commit.
Only these collections for the selected task can be changed. Other tasks and
collections are preserved; controller leases retain their separate authority.

The synchronous callback cannot use the durable repository's writers, nest a
transaction, return a Promise, or retain its staging capabilities after it
returns. Staging reads reflect prior writes in the same transaction. Input
timestamps supplied by callers retain their existing semantics; otherwise the
command timestamp is resolved after acquiring the lock.

## Publication and recovery

The core state is published by one atomic `state.json` replacement. A single
`managed_task_command` audit entry records the command, task ID, and changed
entity IDs, instead of separate audits for each staged upsert. Readers cannot
observe an intermediate task/owner/PR combination from this command.

The existing journal binds prior state, complete next state, and that audit.
State and audit are separate files; the journal provides roll-forward recovery,
not a claim of a physically atomic multi-file write or power-loss durability.

- Business validation failures discard staging. For an admitted, already
  bootstrapped state without pending recovery, state and audit bytes are unchanged.
- Failure before a durable journal leaves the prior business state.
- Failure after journal preparation returns
  `MANAGED_TASK_COMMIT_RECOVERY_REQUIRED`. This is an incomplete publication,
  not a validation rejection. The next repository read/write recovers the entire
  transaction and its audit, with audit ID deduplication. Pending recovery runs
  before bootstrap parses audit evidence, including a partially appended final
  audit line. Its state lock is released before migration lock acquisition.
- Conflicting state/audit evidence remains an error; callers must not erase the
  journal or retry a previously computed snapshot to bypass recovery.

## Scope of the guarantee

Serialization covers management commands using this entrypoint and the shared
state lock. It does not redesign stale-lock recovery on unsupported identity
platforms, create a general mutation service, or change installed runtime code.
Standalone handoff request/accept/reject/expire commands still use their existing
write protocols; this change does not claim those commands are linearizable
with resume. That external-writer boundary remains a separately tracked review
candidate under #125. Resume's own transfer and request completion are atomic
with its task and owner changes.

Regression coverage uses temporary state directories, independent Node writers,
explicit barriers at lock/publication boundaries, and bounded file-operation
faults. It checks rejection atomicity, exclusive final owner/PR, preservation of
unrelated state, journal/state/audit/cleanup failures and recovery after a killed
writer. No live controller, provider effect or runtime deployment is involved.

## Opt-in duration for a genuine first acquire

Omitting all ownership-duration options keeps the existing 20-minute default
and existing command/result semantics. An existing owner is not renewed by
repeating enrollment. The optional public `manage enroll` request is:

```text
--ownership-duration-ms <integer milliseconds>
--ownership-admission-file <absolute private JSON path>
--ownership-admission-sha256 <raw SHA256>
```

All three options are required together. The source policy permits canonical
positive decimal integers from 1 through 3,600,000 milliseconds (60 minutes).
This is a source-policy ceiling, independent of any particular runtime window
or claimed minimum execution time. Fractions, exponents, unsafe integers,
overlong durations, invalid/overflowing expiry dates, duplicate options and
other management operations are rejected. There is no `expiresAt` override.

The caller must explicitly provide both owner session name and ID, a canonical
worktree, branch, and valid TaskSpec. The private, owned, non-symlink JSON file
uses the exact `ao.ownership-first-acquire-admission.v1` schema:

```json
{
  "schema_version": "ao.ownership-first-acquire-admission.v1",
  "operation_id": "a_unique_operation_id",
  "project_id": "project",
  "task_id": "new-task",
  "actor": { "session_name": "known-owner", "session_id": "known-id" },
  "branch_name": "task/new-task",
  "worktree_path": "/absolute/canonical/new-task",
  "task_spec_raw_sha256": "<SHA256 of the exact TaskSpec bytes>",
  "expected_task_state_sha256": "<selected task footprint SHA256>",
  "issued_at": "<canonical UTC timestamp>",
  "valid_until": "<canonical UTC timestamp, at most five minutes after issue>",
  "stop_path": "/same/private/directory/a_unique_operation_id.STOP",
  "policy_source_sha256": "<actual candidate policy module SHA256>"
}
```

The public contracts exports `fingerprintOwnershipTaskState(state, taskId)` and
`ownershipDurationPolicyIdentity()` provide the footprint and policy identity.
Obtain state with the public repository's nonmutating `readControlPlaneState`;
`getSnapshot()` may bootstrap/recover and is not a read-only precondition check.
The descriptor is a cooperative local precondition, not authentication or an
operator authority grant. It does not authorize a runtime window. The CLI's
explicit numeric request is recorded alongside its descriptor raw hash.

Under the existing lock, the command requires no task, TaskSpec, lease history
or PR binding for this task ID. Any active, expired, released, foreign or stale
record rejects the custom route; use of a new duration cannot renew, revive or
replace one. The request/actor/spec/source/raw hash, freshness, scoped STOP and
selected footprint are checked again immediately before journal preparation,
with a full raw-state compare-and-swap check after staging. STOP after durable
journal preparation is not rollback, nor is this a global user-stop mechanism.

Lease metadata, CLI JSON and the single transaction audit bind requested and
granted duration, source-policy version/hash/ceiling, actor, operation, request
hash and full persisted TaskSpec fingerprint. Confirm the actual persisted
`acquired_at`/`expires_at` interval and official state/schema/audit readback;
never infer a granted duration from a requested flag alone. A custom JSON CLI
failure after durable intent emits `HOLD_COMMIT_RECOVERY_REQUIRED` with
`no_replay: true`. Preserve that evidence and use existing controlled recovery
and readback; do not repeat first enrollment as a retry.
