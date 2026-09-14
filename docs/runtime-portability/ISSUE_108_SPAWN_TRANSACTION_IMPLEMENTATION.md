# Native spawn custody — #108

Owner admitted source implementation on 2026-09-13 against main `9209e7414cf9666eaa3071559205527f5b2e6591`. Proposed/final source risk: R3. Independent Revision 1 design review PASS preceded implementation. Installed p0.4 runtime/tag/binary digests remain unchanged; this is an unpublished source candidate, not a runtime cutover or incident permanent-fix receipt.

Native requests now reserve immutable attempt UUIDs before resource effects. The daemon stores phase/outcome/resource custody in private `DataDir/spawn-attempts/<uuid>/record.json`, using exclusive attempt directories and fsynced atomic journal replacement. SQLite migration 0039 stores attempt/session binding in the same transaction as seed creation and retains that binding after rollback. A reserved attempt never automatically reruns, even after a crash or unreadable journal.

Native CLI accepts `--attempt-id`, generates an ID otherwise, and includes it in POST failure diagnostics. Read-only `ao spawn-attempt <uuid>` and GET `/api/v1/spawn-attempts/{attemptId}` expose phase/custody/HOLD. Old HTTP clients that omit IDs cannot safely resubmit an unknown timed-out request by inventing a fresh UUID; they must recover attempt identity from daemon evidence first.

Completed attempt replay checks project/config, session birth/cleanup generation, launch/handle identity, root/child workspace custody and runtime liveness. It never launches a replacement. Incomplete attempts are excluded from explicit restore, boot reconcile and shutdown save/relaunch paths. Ambiguous runtime creation and failed runtime destruction preserve workspace; failed/dirty workspace destruction retains child bookkeeping. Cancellation rollback uses a bounded independent context.

Caller fingerprint is made before tracker enrichment; resolved project/config fingerprint is separately retained. Journal omits raw prompts, env, credentials and error text. Full source fingerprints are one-way custody, not a substitute for source authentication.

The browser spawn plane is unchanged and outside the new native guarantee. CLI `--claim-pr` is an effect after spawn commit: it is not part of this transaction. A failed claim may invoke existing rollback; replay then HOLDs if the session was terminated or its generation changed.

Verification uses real isolated SQLite and fake agent/runtime/workspace collaborators, with no provider calls. Cases cover committed replay, request substitution, missing/replaced runtime, config drift, canceled request, partial runtime creation, failed runtime termination, dirty worktree preservation, incomplete restore suppression, prelaunch journal failure, concurrent reservation, truncated/symlink custody and read-only missing-store diagnosis, and nine persisted phase checkpoints reopened through production SQLite with spawn/restore/reconcile/shutdown effects suppressed. Checkpoint injection is not a real daemon kill experiment. Symlink ancestors are rejected before any directory creation; insecure journal permissions hold. Historical 7.5 GiB materialization and live 120-second timeout are NOT_ESTABLISHED by these bounded fixtures.

Commands (backend directory; existing cached Go 1.26.5, not pinned release-binary Go 1.25.7):

```sh
GOCACHE=/tmp/ao-issue-108-go-cache GOPROXY=off /home/samsen/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.5.linux-amd64/bin/go test -race ./internal/session_manager ./internal/spawnattempt -count=1
```

Root source-sink guard and `git diff --check` passed. Candidate validation/independent review and release attestation must finish before any merge/publication. Rollback keeps p0.4 installations and all attempt custody; do not erase new records or run a schema downgrade against live data.
