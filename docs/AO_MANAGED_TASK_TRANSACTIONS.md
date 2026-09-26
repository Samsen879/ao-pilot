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
  transaction and its audit, with audit ID deduplication.
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
