# P0-R02 Local Runtime Patch Parity Audit

Status: **complete audit; runtime selection remains owned by P0-R03**  
Issue: [#57](https://github.com/Samsen879/ao-pilot/issues/57)  
Policy: `policy.ao_runtime_portability_recovery.v1`  
Recorded: `2026-08-02T02:45:26+08:00`

## Verdict

The old checkout contains 12—not 11—commits unique to its stale
`origin/main`. The commits are useful historical evidence, but they are not a
safe migration unit. Official Agent Orchestrator replaced the old TypeScript
runtime with a Go implementation, so all 12 exact patch IDs remain unique even
where their behavior was later adopted.

The semantic audit classifies the stack as:

**Do not bulk migrate this patch stack.** Each disposition below is bounded to
one observed capability and its current official replacement or gap.

| Classification | Count |
|---|---:|
| adopted | 8 |
| equivalent | 1 |
| obsolete | 2 |
| still-required | 1 |
| conflicting | 0 |

Five autonomy-related commits are adopted by stable `v0.11.2` through the
durable re-engagement implementation introduced by upstream commit
`79a70e82f`, but current main deliberately reverts that implementation in
`ef4d6c124`. That is a baseline conflict, not permission to copy the old stack.

Only `44d333b5000b75b5b5b89df5df6818a3fbe7f7ce` remains a necessary safety
delta. Its exact TypeScript patch must not be cherry-picked. P0-R03 must port
the narrowly defined behavior and tests to a clean public fork based on a
supported Go runtime baseline.

The complete machine-readable ledger is
[`p0-r02-local-patch-parity-ledger.json`](p0-r02-local-patch-parity-ledger.json).

## Live official baselines

The audit re-read public state instead of reusing the P0-R01 observation:

- canonical repository: `Untrivial-ai/agent-orchestrator`;
- live main: `20dbad5f68d3bf905c4a38df12aa42716c8d360f`, tree
  `ad025e3fd6e2085878fc6d2deb1fa1dc72f9ad9a`;
- latest stable release: `v0.11.2` at
  `c5523a6d0e51251b79555b95ddc7d2be59da0f50`, tree
  `6784a292cb54c4a2031ede6cfeaee9a4bb1cd104`;
- npm wrapper: `@aoagents/ao@0.10.3`, integrity
  `sha512-La3w8jv2AJV0GoekWzTEav7ZaQnw1xhnZmfwooXwLVGGuX1BV6vCT56P7xzUrfRPFJ+BuGMRuSqyftMVo6JzyQ==`;
- Linux x64 binary package: `@aoagents/ao-linux-x64@0.10.3`, integrity
  `sha512-B74xSc073V9hjIoZs860m7hbm/7rgjjuV7mkEdeVU8WaJKylBhkHit90qclaC6ol8UJw/AA1j5syLLF9RND+9A==`.

The release tag, repository source version, and npm package version do not use
one shared version coordinate. P0-R03 must therefore choose and lock a single
public immutable source/artifact rather than infer equivalence from the name
`ao` or from PATH.

## Audit method

The old checkout remained read-only. A clean `/tmp` clone of the canonical
public repository imported only Git objects needed for comparison. No branch,
working tree, state, session, lease, credential, or package link from the old
checkout was pushed or reused.

For each local commit the audit used both:

1. `git patch-id --stable` and `git cherry` against live main and `v0.11.2`;
2. semantic comparison of the changed contract and tests with the official Go
   runtime at both baselines.

Exact patch comparison alone reports all 12 as unique because the implementation
language and architecture changed. The semantic classification is therefore the
authoritative migration input.

## Commit-by-commit result

| # | Local commit | Classification | Result |
|---:|---|---|---|
| 1 | `44d333b` tmux liveness under sandboxing | still-required | Official stable and main still treat every `error connecting` message as a missing session, including permission denial. Port only a narrow Go fix. |
| 2 | `718da41` autonomous orchestrator continuation | adopted | Stable durable re-engagement is safer and durable; current main later reverted it. |
| 3 | `d9c64fa` repeated idle cadence | adopted | Stable uses bounded durable retry and backoff instead of an unbounded `repeatEvery`. |
| 4 | `26e1904` eight-minute cadence | obsolete | The literal timing is superseded by a ten-minute initial delay, exponential backoff, and three-attempt ceiling. |
| 5 | `d7eb1ae` stop idle nudges at completion | adopted | Stable provides durable explicit completion plus terminal exhaustion. |
| 6 | `9957b83` long Codex tmux sends | adopted | Official `e8674961f` adds literal chunking, pre-Enter delay, confirmation, and permission-dialog guards. |
| 7 | `a862a5d` preserve idle state | adopted | Idle is first-class durable domain and SQLite state. |
| 8 | `5ed0947` branch and CI reconciliation | adopted | Official runtime persists branches and observes GitHub status rollups and review threads. |
| 9 | `e5a6ff0` running lock permission errors | obsolete | The TypeScript `running.json` lock no longer exists in the Go daemon architecture. |
| 10 | `859da6d` local lifecycle hardening | equivalent | The Go daemon, CLI, session manager, tmux adapter, and GitHub adapter jointly cover the lifecycle contract; the monolithic TypeScript patch is not portable. |
| 11 | `1f3f32e` fail-closed worker startup/stuck detection | adopted | Official spawn uses a durable seed transaction, binary preflight, runtime facts, and guarded worktree materialization. |
| 12 | `00bea6e` resume after terminal worker epochs | adopted | Stable durable re-engagement wakes an idle coordinator to re-read state and continue or declare completion; current main reverts this facility. |

## Minimum verification experiment for the remaining delta

Official `sessionMissingOutput` lowercases tmux output and accepts any string
containing `error connecting`. Therefore this input:

```text
error connecting to /tmp/tmux-1000/default (Operation not permitted)
```

returns `true` from the predicate. `IsAlive` consequently returns `false, nil`,
which converts inability to inspect the socket into false proof that the
session is dead. The required behavior is `false, error`; only positive missing
session/server/socket evidence may return `false, nil`.

P0-R03 must implement and execute these Go tests in a new clean fork clone:

- missing session → `false, nil`;
- missing tmux server/socket → `false, nil`;
- permission denied / operation not permitted → `false, error`.

## P0-R03 input

Official stable is not sufficient unchanged. It contains the needed durable
orchestrator re-engagement capability, but it retains the tmux permission-denied
liveness defect. P0-R03 should:

1. create or reuse a public `Samsen879/agent-orchestrator` fork from the exact
   supported stable baseline;
2. port only the narrow Go liveness predicate/test correction;
3. build and test that exact fork commit in a clean clone;
4. expose an immutable commit-addressed source/artifact for the later runtime
   lock;
5. record the one-change upstream delta and convergence route.

No runtime is selected by this issue. No npm package or GitHub Release is
published, and no old local commit is pushed.

## Limitations

Go was not installed on this audit workstation, so R02 did not claim an
upstream Go test run. The source-level experiment establishes the precise defect;
R03 owns the clean-fork build and executable unit-test evidence before artifact
selection.
