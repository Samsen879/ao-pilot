# Session field ownership

After session creation, display name, preview URL/revision and terminate-on-PR-merge
belong to their dedicated user setters. Lifecycle `UpdateSession` and the atomic
manual-submit/draft-clear operation never assign these columns. Preview revision
continues to increment in SQL on every setter call, including an unchanged URL,
so CDC still requests a refresh.

Lifecycle owns activity, first-signal and termination facts. Its launch updates
also persist workspace/runtime/agent metadata under the existing lifecycle lock.
The existing launch-generation and ExpectedUpdatedAt checks are retained; the
shared updated_at timestamp is not a new CAS version or ownership fence.

Spawn rollback has two narrow operations:

- Preserve workspace: writes branch and workspace/repository paths. Runtime
  handle and launch ID are cleared only when destruction was confirmed; otherwise
  SQL leaves their current values untouched. Agent identity is preserved.
- Clear destroyed workspace: clears branch, workspace path, runtime handle and
  agent identity, retaining the pre-existing policy for other metadata columns.

Neither rollback operation writes lifecycle facts, user preferences, pane draft
or pane generation. This fixes field ownership, not arbitrary competing launch
operations or daemon admission. Manual submit still commits activity and clearing
pending draft in one SQLite transaction.

The regression tests use real temporary SQLite stores and channel barriers on
test-only interface wrappers. They cover both writer orders, repeated preview
CDC, manual submit, generation rejection and each rollback mode. No production
pause hooks or live daemon are used.

SQL bindings for the three affected queries were regenerated with sqlc v1.31.1.
The repository's existing normalized read/model bindings are retained: a full
regeneration currently also changes unrelated model/return shapes. Only the
changed query blocks are taken from that generated output; their SQL, parameters
and argument order match it exactly.
