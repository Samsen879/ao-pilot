# Worktree preservation during recovery

A live tmux session is adopted without workspace mutation. `gitworktree.Restore`
already reuses an existing registered directory; the old cold-start path
previously removed that directory before calling it. Cold-start capture now
retains every directory, including ignored local files. Existing cones are not
narrowed during restoration. Changed project cones can therefore leave explicit
physical cone drift; preservation takes precedence over removing those files.

The currently present WIP version is authoritative during reuse. A retained
older preserve commit is a second version, not permission to overwrite newer
modified/untracked bytes. If old content is still missing and cannot be applied
without overwriting current WIP, restoration fails closed.

When a missing registration requires reconstruction of an existing directory,
the entire directory is renamed into an adjacent recovery backup. The durable
private receipt binds the original manifest and backup locations. The replacement
is created separately, and original physical files (including ignored files)
are overlaid without transplanting an invalid `.git` pointer. In-place replay
that actually mutates bytes first snapshots the working directory and linked
Git metadata. Merely reusing already present WIP does not copy the directory.

Replay failure restores the original directory and Git metadata before returning
an error. The session remains terminated with the existing `stray_moved`
quarantine state. Automatic recovery, batch retry, messaging and cleanup cannot
consume this HOLD; no agent is launched on a partially replayed workspace.
Unknown or corrupt recovery receipts/backups remain quarantined rather than
being deleted based on their age. Explicit recovery of unresolved ownership
collisions requires operator inspection.

All participating repositories are verified before backup cleanup. Nested child
paths come only from the session repository inventory; every child has its own
verified physical manifest. Parent verification accounts only for those exact,
validated child paths and receipt-owned recovery artifacts. Unowned backups,
including backups next to an existing reuse receipt, remain HOLD. Receipts
record the physical manifest, phase and cleanup timestamp. The owned backup is
removed only after successful replay and file verification. All backup inventory
errors retain the backup. A durable cleanup-start checkpoint is written before
removal; only that checkpoint admits an already-absent backup during cleanup
resumption; a verified leftover
can be cleaned idempotently. Failed-attempt directories and metadata remain as
separate evidence. Capture uses new commit-addressed refs and does not overwrite
legacy refs. Successful replay does not delete a preserve ref. Ref cleanup is
an explicit operator action **after verified cutover**, not automatic GC.

## Ordered first installation

Default batch scope remains the frozen preflight live set. An operator may
explicitly enumerate additional historical IDs through `firstRestoreSessionIDs`;
unknown/duplicate IDs and projects are rejected. This is equivalent to the
native CLI's explicit `--include-terminated --session-id` opt-in, not a change to
the default scope. `restoreLastSessionIDs` is a subset of selected worker IDs,
restored one at a time after all other selected sessions and all Orchestrators.
Each requires a private digest-bound `restoreLastFileManifests` JSONL input
(`kind`, relative `path`, `sha256`). Preflight and every protected restoration
read back all listed files; any mismatch halts before restoring the next session.
No glob expansion or wildcard admission is used.

The generated environment temporarily defers automatic boot restoration of
these protected IDs. Explicit restoration remains available. After durable
commit, the installer atomically removes that temporary input from the generated
EnvironmentFile. A failure to clear it is a private warning requiring readback;
it never rolls back a committed installation. Subsequent cold boots retain the
normal four-launch limit and Orchestrator priority.

Only the explicitly named upper/lowercase HTTP/HTTPS/ALL/NO proxy keys are
accepted in the unique environment override alongside the existing allowlist.
Executable overrides, loader variables and arbitrary environment names remain
rejected. Empty proxy settings can be omitted. Connectivity must be established
with an actual authenticated minimal model call in the rendered unit environment;
a TLS handshake alone is insufficient.
