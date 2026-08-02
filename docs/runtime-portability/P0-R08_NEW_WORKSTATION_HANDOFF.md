# P0-R08 new-workstation handoff

This handoff is the owner-authorized P0-R08 retry admitted by issue #63 comment
`5157524210`. It starts only from historical failed-attempt PR #70's immutable
merge `d7bef70d16a881cbceb785b1541db67a1876de04` and tree
`e3553f50aba65c413d4a5063bfd4ceb4510e0166`. Do not substitute a local branch,
the failed-attempt checkout, or any earlier admission.

## Preconditions

- Use the new retry workstation and a brand-new clone at
  `/home/guoqy/p0-r08-retry-workstation/ao-pilot`.
- Do not mount or read the failed attempt's HOME, `.ao` database, hidden runtime
  checkout, sessions, reviews, re-engagement state, leases, or managed store.
- GitHub CLI and Codex credentials must be entered by the user on this machine;
  reuse only those normal user-provided logins, never copy credential files,
  and never include probe output in the receipt.
- Set retry-specific absolute `AO_DATA_DIR` and `AO_RUN_FILE` values. Bootstrap
  the runtime into retry-specific managed store and cache directories.
- Confirm there is no trusted PATH `ao`. A hostile same-name binary is allowed
  only as a fail-closed probe and must never execute.
- Runtime Ref: `runtime.agent_orchestrator.v0_11_2_p0_1`.

## Bootstrap the admitted exact main

```bash
RETRY_ROOT=/home/guoqy/p0-r08-retry-workstation
export AO_DATA_DIR="$RETRY_ROOT/ao-state/data"
export AO_RUN_FILE="$RETRY_ROOT/ao-state/ao.run"
export AO_PILOT_RUNTIME_STORE="$RETRY_ROOT/runtime-store"
export AO_PILOT_RUNTIME_CACHE="$RETRY_ROOT/runtime-cache"
mkdir -p "$AO_DATA_DIR" "$AO_PILOT_RUNTIME_STORE" "$AO_PILOT_RUNTIME_CACHE"
git clone https://github.com/Samsen879/ao-pilot.git "$RETRY_ROOT/ao-pilot"
cd "$RETRY_ROOT/ao-pilot"
git checkout --detach d7bef70d16a881cbceb785b1541db67a1876de04
test "$(git rev-parse HEAD^{tree})" = 'e3553f50aba65c413d4a5063bfd4ceb4510e0166'
npm ci
npm run verify:runtime-lock
./scripts/bootstrap.sh \
  --store "$AO_PILOT_RUNTIME_STORE" \
  --cache "$AO_PILOT_RUNTIME_CACHE" \
  --json
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
retry implementation Worker. The Worker must own a new task branch, a distinct
governed worktree, and exactly one new retry principal PR. Historical PR #70 is
immutable failure evidence and cannot serve as that retry PR. A manually
created Worker or PR is not an acceptable substitute. Record the exact runtime
command used to ingest #63 and the AO session identifier in the issue receipt.

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
  --name p0-r08-retry-or \
  --harness codex \
  --issue 63 \
  --prompt 'Coordinate the owner-authorized issue #63 retry admitted by comment 5157524210. Use this pinned AO to spawn the sole retry implementation Worker from #63; require its distinct worktree/branch and exactly one new principal PR; observe CI and at most two GitHub Codex connector reviews requested only by owner-authored @codex review PR comments; never use ao review trigger; merge only under the issue policy; replay exact main; publish the receipt; mark the Orchestrator done before termination; clean all session/worktree ownership.'
```

The orchestrator must create the implementation session with
`<RUNTIME-BINARY> spawn --kind worker --issue 63 ...`; record both returned
session IDs. Use
`session get`, `session claim-pr`, `pr merge`, `orchestrator done`, and
`session cleanup` from the same exact binary as needed. The Worker may use `gh`
to commit, push, and open its principal PR, but it must remain owned and
observed by the AO session. Do not use `ao review trigger`: it launches a local
reviewer through the owner's GitHub credential and cannot produce connector
review evidence.

The AO must then observe the retry principal PR, required CI, and no more than
two completed GitHub Codex connector reviews. Each review must be requested by
an owner-authored PR comment whose body begins `@codex review` and contains the
exact 40-character HEAD SHA being reviewed. Evidence must be either a submitted
`chatgpt-codex-connector[bot]` review for that commit or the bot's clean `+1`
reaction on that exact-head request comment. Review repairs remain in the same
Worker/worktree/PR, and a fresh request is required after every new HEAD except
the already-authorized post-Review-2 repair case. The AO may merge only under
the issue's review policy and green required CI. After
the final merge-candidate HEAD is known, but before merge or worktree cleanup, capture
the actual Git binding and publish the exact generated JSON to issue #63:

```bash
BOOTSTRAP_CLONE_ROOT="$(pwd -P)"
WORKER_WORKTREE_ROOT='<WORKER-WORKTREE-ABSOLUTE-PATH>'
npm --prefix "$WORKER_WORKTREE_ROOT" run capture:self-hosting-worktree -- \
  --source-root "$BOOTSTRAP_CLONE_ROOT" \
  --worker-root "$WORKER_WORKTREE_ROOT" \
  --worker-session-id '<WORKER-SESSION-ID>' \
  --out /tmp/p0-r08-worktree-evidence.json
gh issue comment 63 --body-file /tmp/p0-r08-worktree-evidence.json
```

Record that comment's database ID in `delivery.worktree_evidence_comment_id`.
The capture command fails unless the source is the retry-admitted PR #70 merge/tree and
the Worker is a distinct AO branch worktree sharing the source Git common
directory. `npm --prefix` is required because the capture package exists in the
unmerged Worker HEAD, not in the detached admitted bootstrap clone. The final
verifier fetches this live pre-cleanup evidence and binds its source path,
Worker path/session/branch/HEAD, and Git relationship to the receipt and
principal PR.

The AO must then re-read the GitHub merge outcome and replay the merge SHA on
exact main. Before terminating the Orchestrator, run
`<RUNTIME-BINARY> orchestrator done --session <ORCHESTRATOR-SESSION-ID>`.
Then stop both sessions, remove the Worker worktree and retry task branches,
clean the project/session state, stop the daemon, and verify that no active
re-engagement or other stale ownership remains.

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
declared PR #70 retry-admission merge to its real Git tree, hashes and validates
the live unedited owner comment `5157524210`, reads historical PR #70 and the
new P0-R08 retry principal PR from GitHub, verifies required check runs, and
validates
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
