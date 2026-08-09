# Controller lease recovery and safety verification

Status: Foundation #18 verification and operator procedure. This document
evaluates the canonical-authority repair merged by #17. It does not grant a
recovery actor new authority and does not implement automatic repair.

## Deterministic verification result

The fixture pack is
[`pack.v1.json`](../../tests/ao/fixtures/controller-lease-safety/pack.v1.json).
`npm run verify:controller-lease-safety` materializes every case in a temporary
state root, normalizes runtime-specific parse diagnostics into audited error
codes, removes all path and wall-clock variability from its observations,
and executes the complete pack twice. The committed receipt is
[`controller-lease-safety-verification.v1.json`](controller-lease-safety-verification.v1.json).

The 12 cases (24 executions per verifier invocation) prove:

- missing or invalid canonical bytes never select a stale `state.json` lease;
- a valid canonical authority wins over a stale shadow and regenerates the
  compatible projection after restart/cold read;
- partial evidence either preserves the canonical read-only projection or
  fails closed, according to whether schema and state evidence are both absent
  or contradictory;
- the admitted v10 legacy array migrates once, emits its integrity-bound
  receipt, strips the shadow, and remains byte-stable on replay; a v11
  unversioned array is rejected;
- serialized concurrent heartbeats retain the later accepted heartbeat;
- recovery evidence covers success, missing intent, result mismatch, and
  deterministic replay.

## Audited explicit recovery procedure

This procedure is for canonical file loss or corruption after v11. It is an
operator-run, stop-the-world procedure. The evaluator validates evidence but
never writes runtime state.

1. Stop every controller that can access the project state root. Preserve the
   entire state root and the suspect `controller-leases.json` bytes read-only.
   Record the incident id, operator id/role, stop evidence, and a count of zero
   active controllers. If quiescence cannot be proved, stop here.
2. Diagnose without consulting `state.json.controller_leases`. That field is
   a non-authoritative shadow regardless of timestamps, apparent freshness, or
   record count. File absence, malformed JSON, unsupported envelopes, and
   integrity disagreement remain failed closed.
3. Locate a separately retained canonical backup whose bytes can be validated
   as `ao.controller-lease-authority.v1`. Hash the complete normalized envelope.
   Do not salvage individual records, synthesize an empty authority, or select
   between candidates by lease timestamps. If no uniquely verified canonical
   backup exists, preserve the failure and escalate through the applicable
   human gate.
4. The authorized operator records
   `schema_version=ao.controller-lease-recovery-evidence.v1`, project and
   incident ids, operator id/role, the exact intent
   `restore_verified_canonical_backup`, reason and approval time, backup digest,
   observed zero-controller evidence, and the proposed resulting records.
   Every proposed lease must be non-active. Validate this evidence with
   `verifyControllerLeaseRecoveryEvidence` before any replacement.
5. Only after separate operational authorization, replace the canonical file
   atomically using the verified envelope. This repository intentionally
   provides no automatic replacement command. Never delete or repopulate the
   state shadow as a recovery mechanism.
6. Cold-read with the compatible runtime while controllers remain stopped.
   Re-hash the normalized authority, verify it equals both the approved source
   and resulting digest, verify zero active leases, and retain the recovery
   evidence beside the incident record. A mismatch means recovery failed;
   stop and preserve both byte sets.
7. Resume controllers only under ordinary lease acquisition rules. The
   recovery receipt is audit evidence, not lease authority.

## Migration and rollback verification report

| Path | Verified outcome | Operational rule |
| --- | --- | --- |
| Fresh v11 read/restart | Canonical envelope alone supplies the projection; persistent bytes do not change. | Compatible runtime may continue. |
| v10 canonical array with expired legacy lease | One migration produces the v11 envelope, removes the shadow, records source/destination digests and quiescence, then replays byte-identically. | Migrate forward only after legacy-writer quiescence. |
| v11 plus an unversioned/malformed canonical file | Read fails closed; stale shadow is ignored. | Diagnose or use the explicit recovery procedure. |
| Concurrent heartbeat writers | Canonical lock serialization preserves the later accepted heartbeat. | Do not bypass the repository lease lock. |
| Code rollback to a pre-v11 reader | Not migration-compatible and not an admitted recovery technique. | Keep controllers stopped and restore a compatible reader; never recreate a shadow for old code. |
| Data rollback or downgrade rewrite | Not performed or authorized by this pack. | Preserve evidence and escalate; no destructive rollback. |

The pack makes no standby/failover claim, does not change shared Workstream
state, does not add credentials, and does not expand controller authority.

## Commands

```text
npm run verify:controller-lease-safety
node --experimental-vm-modules node_modules/.bin/jest --runInBand --runTestsByPath tests/ao/controller-lease-safety-evaluation.test.js --no-color
npm run release:check
```
