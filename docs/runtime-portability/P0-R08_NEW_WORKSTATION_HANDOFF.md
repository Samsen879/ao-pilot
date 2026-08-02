# P0-R08 new-workstation handoff

This handoff becomes executable only after P0-R07 is merged, exact-main replayed,
closed out, and cleaned. Obtain the exact admitted `main` SHA/tree from issue
#63; do not substitute a local branch or the old workstation checkout.

## Preconditions

- Use a new WSL/Linux workstation or equivalent isolated machine.
- Do not mount or read the old workstation HOME, hidden runtime checkout,
  `.agent-orchestrator`, sessions, leases, credentials, or managed store.
- GitHub CLI and Codex credentials must be entered by the user on this machine;
  never copy credential files and never include probe output in the receipt.
- Confirm there is no trusted PATH `ao`. A hostile same-name binary is allowed
  only as a fail-closed probe and must never execute.
- Runtime Ref: `runtime.agent_orchestrator.v0_11_2_p0_1`.

## Bootstrap the admitted exact main

```bash
git clone https://github.com/Samsen879/ao-pilot.git
cd ao-pilot
git checkout --detach be8ea9d408920e0728ac980097db758796144714
test "$(git rev-parse HEAD^{tree})" = '00f93b164a75af044e63532fc7ac64479a390ab9'
npm ci
npm run verify:runtime-lock
./scripts/bootstrap.sh --json
node ./bin/ao-pilot.js runtime-path --json
node ./bin/ao-pilot.js doctor --json
node ./bin/ao-pilot.js start --project ao-pilot
```

Record the bootstrap and doctor provenance without credentials. The source,
tag object, commit, tree, lock digest, binary digest, and absolute binary path
must match the committed locks. Record the actual runtime target as
`linux/x64` or `linux/arm64`; the receipt verifier binds the binary digest to
that exact tuple.

## AO-created delivery

The newly bootstrapped AO must ingest GitHub issue #63 and create the P0-R08
implementation Worker. The Worker must own a new task branch, a distinct
governed worktree, and one principal PR. A manually created Worker or PR is not
an acceptable substitute. Record the exact runtime command used to ingest #63
and the AO session identifier in the issue receipt.

Copy the absolute `runtime_binary_path` from the verified provenance output to
`<RUNTIME-BINARY>`, then use the pinned runtime itself (never PATH `ao`):

```bash
<RUNTIME-BINARY> project add \
  --id ao-pilot \
  --name ao-pilot \
  --path "$PWD" \
  --orchestrator-agent codex \
  --worker-agent codex

<RUNTIME-BINARY> spawn \
  --kind orchestrator \
  --project ao-pilot \
  --name p0-r08-or \
  --harness codex \
  --issue 63 \
  --prompt 'Coordinate issue #63. Use this pinned AO to spawn the implementation Worker from #63; require its distinct worktree/branch/principal PR; observe CI and at most two GitHub Codex Reviews; merge only under the issue policy; replay exact main; publish the receipt; clean all session/worktree ownership.'
```

The orchestrator must create the implementation session with
`<RUNTIME-BINARY> spawn --kind worker --issue 63 ...`; record both returned
session IDs. Use
`session get`, `session claim-pr`, `review trigger`, `review ls`, `pr merge`,
and `session cleanup` from the same exact binary as needed. The Worker may use
`gh` to commit, push, and open its principal PR, but it must remain owned and
observed by the AO session.

The AO must then observe the principal PR, required CI, and no more than two
GitHub Codex Reviews. Review repairs remain in the same Worker/worktree/PR. The
AO may merge only under the issue's review policy and green required CI. After
the final merge-candidate HEAD is known, but before merge or worktree cleanup, capture
the actual Git binding and publish the exact generated JSON to issue #63:

```bash
npm run capture:self-hosting-worktree -- \
  --source-root "$PWD" \
  --worker-root '<WORKER-WORKTREE-ABSOLUTE-PATH>' \
  --worker-session-id '<WORKER-SESSION-ID>' \
  --out /tmp/p0-r08-worktree-evidence.json
gh issue comment 63 --body-file /tmp/p0-r08-worktree-evidence.json
```

Record that comment's database ID in `delivery.worktree_evidence_comment_id`.
The capture command fails unless the source is the admitted R07 commit/tree and
the Worker is a distinct AO branch worktree sharing the source Git common
directory. The final verifier fetches this live pre-cleanup evidence and binds
its source path, Worker path/session/branch/HEAD, and Git relationship to the
receipt and principal PR.

The AO must then re-read the GitHub merge outcome, replay the merge SHA on exact
main, stop the session, remove the Worker worktree, and verify that no stale
ownership remains.

## Receipt and protected gate

After GitHub merge readback, exact-main replay, and cleanup, copy the template
to a workstation-local path and replace every placeholder with observed
evidence:

```bash
cp docs/runtime-portability/p0-r08-workstation-self-hosting-receipt.template.json \
  /tmp/p0-r08-workstation-self-hosting-receipt.json
npm run verify:self-hosting -- \
  --receipt /tmp/p0-r08-workstation-self-hosting-receipt.json
```

Post that exact JSON as the entire body of one issue #63 comment, record the
comment database ID, base64-encode the same bytes, and run the manual
`workstation-self-hosting-proof` workflow on exact post-merge `main`:

```bash
gh issue comment 63 --body-file /tmp/p0-r08-workstation-self-hosting-receipt.json
npm run verify:self-hosting -- \
  --receipt /tmp/p0-r08-workstation-self-hosting-receipt.json \
  --issue-comment-id <ISSUE-63-COMMENT-ID> \
  --repository-root "$PWD"
```
This ordering is required because the final receipt contains merge readback,
exact-main replay, and cleanup evidence that cannot truthfully exist inside the
pre-merge principal PR. A mock-only receipt, old-workstation execution, missing
exact-head review evidence, missing merge readback, or leaked
session/worktree/ownership must fail closed.

The verifier independently checks out repository default `main`, resolves the
declared R07 admission commit to its real Git tree, reads merged PR #69 and the
P0-R08 principal PR from GitHub, verifies required check runs, and validates
each counted Codex Review against either a submitted bot review or an exact-head
request comment with the bot's clean `+1` reaction. Receipt fields alone are
never sufficient evidence.

Normally `principal_pr.reviewed_head` must equal `principal_pr.head_sha`. If
Review 2 reports findings, the Owner's two-review policy permits a final repair
without Review 3 only when `post_review_2_repair` binds the final SHA, references
issue #55, lists every Review 2 finding comment ID, and every corresponding
thread is resolved. The verifier also requires all review completions to
predate the live GitHub merge timestamp and executes `npm run release:check`
itself on the checked-out exact merge SHA.

Only after #63 merges and exact-main replay passes may #12 be marked admitted.
