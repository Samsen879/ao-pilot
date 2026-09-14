# #108 R3 design — durable native spawn attempts

Baseline 9209e7414cf9666eaa3071559205527f5b2e6591. Scope: source-only native Go/SQLite plane; current immutable p0.4 release pins/installations remain untouched. Admission from Owner on 2026-09-13. Historical F03 current recurrence is not established. Design must be independently reviewed before code.

## Invariant and integration

Current Spawn writes seed before workspace, passes canceled request context into rollback, and can erase worktree bookkeeping even if Destroy failed. Preserve phase ownership and attempt idempotency at the native manager, not just HTTP. Extend SpawnConfig and SpawnSessionRequest with optional attemptId; native CLI supplies a UUID before POST and prints/carries it on errors. Existing clients without ID receive an internally generated attempt, but their network-lost request is not safely retryable unless they first recover its ID from daemon evidence. Document this limit, do not claim unconditional legacy-client idempotence.

Introduce an internal durable spawn-attempt journal under daemon DataDir/spawn-attempts. Record schema/version, attempt UUID, request fingerprint (never raw prompt/env/secrets), project, phase, session ID and known owned workspace/branch/runtime handles, outcome and timestamps. No runtime secrets or raw error strings in journal. Attempt records are authoritative only for deduplication and attempt custody; SQLite/runtime remain authoritative for current session state.

Reserve attempt via exclusive create and durable fsync, then journal updates by exclusive temp+fsync+rename+directory fsync. Symlinks, malformed/truncated records and changed request fingerprints HOLD. Only the reservation owner may perform spawn. A duplicate running/interrupted/unknown attempt never launches again; a prior committed attempt may return its exact current record only if identity/resources remain valid. A prior failed attempt reports its previous failure, not a retry. New retry is a new explicit attempt after reconciliation; no implicit retry.

Manager Spawn carries named result/err so a defer writes durable failed/committed disposition; journal errors must fail before the next effect, or return non-success and retain discoverable previous state after effects. Record phase before each effect; record known resource handles immediately after successful creation. Client timeout cancels materialization/launch rather than silently adopting continued work. Rollback runs on bounded context.WithoutCancel, and exact residual facts remain discoverable. Do not delete session_worktrees until workspace destroy is confirmed; retain dirty/unowned resources and missing/failed destroy facts. Unknown partial adapter creation must remain unknown/HOLD; do not infer no resources from a returned error.

Expose read-only GET /spawn-attempts/{attemptId} and native CLI attempt diagnosis, with request/phase/state/resources/residual inventory and action HOLD as needed. No reconcile endpoint that deletes dirty data. Reconciliation means inspect durable attempt plus current session/worktree/runtime and derive known completed/failed/interrupted/unknown status, idempotently without launching; explicit human cleanup/retry remains separate. Daemon restart converts owner-lost in-flight records to interrupted/unknown using process/boot identity, or leaves HOLD if observer uncertainty. Session Reconcile must not fresh-launch an incomplete attempt automatically.

## Validation and rollback

Use real isolated SQLite with fake agent/runtime/workspace adapters. Cancellation before/after each phase; commit response lost; simultaneous same UUID calls; same UUID changed request; crash/truncated journal; cleanup failure/dirty worktree; successful commit replay; absent runtime on replay; repeat diagnosis. Tests verify no duplicate runtime create, residual custody, context-independent rollback and no false success. Record non-reproduction scope rather than claim exact 7.5 GiB historical trigger reproduced.

Source-only change requires backend tests/build/vet, root/runtime source contracts and affected API checks. Immutable new binary/tag publication and installed-runtime cutover are separate R3 release gates; not performed here. Rollback of unpublished source = retain old p0.4 installation; never downgrade journal custody or erase old attempts. Migration must be additive and reject unsupported records.

## Open design risks for review

Cross-process reservation durability; boot/start identity for attempt owner; adapter partial-create contract; committed replay liveness; unsafe raw-error or fingerprint payload retention; old clients without attemptId; API generated contract consistency; transaction journal vs SQLite orphan crash window. Reviewer should reject if this boundary cannot be proven with bounded source scope.

## Revision 1 — reviewer requirements are binding

Workspace teardown is prohibited until runtime termination is confirmed. Runtime Create error is ambiguous unless adapter proves no creation; preserve workspace and launch identity and report unknown runtime/HOLD. Keep every child worktree marker on teardown failure.

Add additive spawn_attempt_sessions mapping persisted atomically with seed session insertion in SQLite, before any external resource effect. This closes the journal/session seed crash window: session ID maps to an attempt even if journal phase update fails. Persist prospective session/project/branch/launch ID before workspace/runtime Create; adapter-specific paths not knowable before Create are explicitly unknown, never erased/inferred absent. Any journal update failure stops before next effect. Preserve unknown external residuals without deletion. Resource plans identify exact session/project/branch rather than pretending an unknown path is available.

Original caller request fingerprint is made at service ingress before tracker enrichment/defaults; manager also records resolved project/cfg fingerprint. Direct manager calls fingerprint their original cfg, while HTTP forwards the ingress fingerprint. Fingerprints stored without raw payload and schema closed; mutable enrichment cannot change a repeated request's actual execution because reservation is checked before effects.

Restore, RestoreAll, Reconcile and SaveAndTeardownAll consult the atomic session-attempt mapping. Noncommitted or unreadable attempts are HOLD and never launched/destroyed automatically. Existing old sessions lacking mapping keep legacy policy and are explicitly out of new transaction custody. Read-only diagnosis derives actual session/launch/workspace/current runtime facts without new launch/cleanup. A committed response replay validates generation, handle, terminated state, known root/child worktree identities and liveness; any drift HOLD, never claim new success.

Browser plane remains unchanged and outside new native attempt guarantee, documented as such. CLI --claim-pr is explicitly after native spawn commit; failed PR claim invokes existing rollback but committed replay then detects killed/replaced session and HOLD. It must not claim the PR operation is part of spawn atomicity.

Add crash/write-failure at each boundary, live-owner/PID reuse, failed Destroy while writer lives, worktree bookkeeping failure, retained markers and restore suppression. Owner lock model uses exclusive journal reservation with no automatic stale reclamation; in-flight duplicate is HOLD even after crash, so PID ambiguity cannot admit a new effect. Diagnosis can label known previous boot interrupted; uncertainty remains unknown. Durable reservations never auto-retry.
