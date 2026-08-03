# P0-R08 new-workstation handoff

> Historical principal-proof record: the retry procedure below produced sole
> principal PR #71 and its immutable v2 evidence. Do not rerun it. The
> Owner-authorized standing terminal-recovery addendum later in this document
> is the only active delivery procedure, and the v5 receipt retains this entire v2
> proof as its first layer.

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
- Runtime Ref: `runtime.agent_orchestrator.v0_11_2_p0_2`.

## Bootstrap the admitted exact main

```bash
RETRY_ROOT=/home/guoqy/p0-r08-retry-workstation
export AO_DATA_DIR="$RETRY_ROOT/ao-state/data"
export AO_RUN_FILE="$RETRY_ROOT/ao-state/running.json"
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
reaction on that exact-head request comment. Record the owner request comment's
database ID as `request_comment_id` for every receipt review entry, including a
submitted review. Review repairs remain in the same
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
principal PR. Its v2 payload also captures the active `AO_DATA_DIR`,
`AO_RUN_FILE`, runtime store, and cache so the final verifier does not rely on
receipt-only path claims.

The AO must then re-read the GitHub merge outcome and replay the merge SHA on
exact main. Before terminating the Orchestrator, invoke `orchestrator done`
through the committed capture command, which fails unless the exact pinned
binary confirms durable completion:

```bash
npm run capture:orchestrator-done -- \
  --runtime-binary '<RUNTIME-BINARY>' \
  --orchestrator-session-id '<ORCHESTRATOR-SESSION-ID>' \
  --out /tmp/p0-r08-orchestrator-done-evidence.json
gh issue comment 63 --body-file /tmp/p0-r08-orchestrator-done-evidence.json
```

Record that comment's database ID in
`cleanup.orchestrator_done_evidence_comment_id`. The final verifier fetches the
unedited owner-authored comment and binds its exact command, pinned runtime
path, session ID, successful exit, confirmation text, and post-merge timestamp
to the receipt. Only then stop both sessions, remove the Worker worktree and
retry task branches, clean the project/session state, stop the daemon, and
verify that no active re-engagement or other stale ownership remains.

## Owner-authorized ordered terminal-recovery addendum

The first terminal admission in issue #63 comment `5158225894` produced PR
#72. That PR merged as `59cdf7c0ddfedfe4438eaeeff485146534fae287` /
tree `044f49e5fe8cbfe2382001436d1e060b9bbb0e07`, but it is an immutable
failed terminal attempt: its strict collector missed Review 2 comment
`5158456834`, and no immutable pre-merge worktree evidence was published.
Owner comment `5158533683` records that fail-closed disposition. PR #72 must
never be rewritten as a successful proof.

Unedited Owner comment `5158510418`, created and last updated at
`2026-08-02T14:24:49Z`, is the standing terminal-recovery admission. Its exact
JSON body string is 3,712 UTF-8 bytes with SHA-256
`431e128a4ffe100b1a74a327778796480513f6fd06a5ab9a8df5c2e5c5df1284`.
It admits at most two additional sequential non-principal recovery attempts
from exact main `59cdf7c0ddfedfe4438eaeeff485146534fae287` / tree
`044f49e5fe8cbfe2382001436d1e060b9bbb0e07`.

PR #73 consumed the first additional slot and is immutable
`failed_merge_path_provenance`: its CI, two reviews, nine finding
dispositions, worktree evidence `5163418525`, and premerge evidence
`5163443629` passed, but guarded `gh pr merge` performed the provider
mutation rather than AO. Owner disposition `5163542954` is exactly 3,574
UTF-8 bytes with SHA-256
`d8ff4994fba918ed8ecfb954ba1352da21661a405c5331f5f8422bdb8ce7be5c`.
It binds HEAD `d504a154f946da57284bf05b9788b5aa7e87a0ce`, merge/current
main `fe9bcd9eeba08453aeb003036a5dce76926314ff`, and tree
`a619bcc0fc57a7312b36368501ba54714eb2373e` without relabeling that merge as
AO-executed.

Owner blocker `5163606282` (2,036 UTF-8 bytes, SHA-256
`0fb549f8ff0651a87fe83c1f1179605866a864b36adc7b62092655f3cf05f401`)
records the p0.1 architectural 501. Unedited Owner admission `5163994984`,
created and last updated at `2026-08-03T08:23:19Z`, is exactly 5,406 UTF-8
bytes with SHA-256
`2005f4deceae2f69a9e332a040fb72664dbd2d0618cfa119ef7c00894599e1ca`.
It authorizes ordered recovery-chain attempt 3 and PR #74 as the second and
final additional slot. PR #71 remains the sole principal delivery; PR #75 is
not admitted.

The recovery PR body must link issue #63, standing admission comment
`5158510418`, sole principal PR #71, failed chain attempts PR #72 and PR #73,
blocker `5163606282`, and final admission `5163994984`. It must
not contain `Closes #63`, `Fixes #63`, `Resolves #63`, or equivalent
auto-close wording. No unrelated or unordered issue-linked delivery is
allowed.

This run uses the fresh clone and isolated AO state below:

- clone: `/home/guoqy/p0-r08-terminal-remediation/ao-pilot`
- `AO_DATA_DIR`: `/home/guoqy/p0-r08-terminal-remediation/ao-state/data`
- `AO_RUN_FILE`: `/home/guoqy/p0-r08-terminal-remediation/ao-state/running.json`

It uses only the Owner-admitted p0.2 runtime artifact at
`/home/guoqy/p0-r08-retry-workstation/runtime-store/runtime.agent_orchestrator.v0_11_2_p0_2/linux-x64/aae8a684357271acc7ad2fa1d4116c7c65c8fa9d/bin/ao`,
whose SHA-256 is
`ad7fd23c6a3f495e2d10b130cf23227c14e30573db5c2c01b68d8214c5965b4d`.
Its annotated tag object is `450ae009e2c1eb48cdf9c19be676b4a4ff01e611`,
commit `aae8a684357271acc7ad2fa1d4116c7c65c8fa9d`, tree/integrity
`e8adb9a31068810becfb5d31b46688b04202cf81`, and linux/arm64 binary
SHA-256 `972181d92085fb6772fd9a8edf688f68c290976eda67a282ba1ac83d985d2dc6`.
No prior AO database, sessions, project, daemon, worktree, or re-engagement
state may be read. Do not claim a remediation-specific runtime store or cache:
neither was created or used.

Before merge, run `publish:self-hosting-worktree` from the active Orchestrator
session. The command fails unless `AO_SESSION_ID` equals
`ao-pilot-remediation-1`, the pinned AO reports that exact active session as
the issue #63 Orchestrator, the process carries matching AO project, issue,
session, and runtime-launch bindings, and the runtime path and digest match the
admitted binary. In addition, the publisher must be a live process descendant
of the pinned AO `agent-process supervise` process for that exact Orchestrator
session and launch. The evidence records the supervisor PID plus its
PID-reuse-resistant `/proc` start token, executable digest, and command-line
digest. Exporting matching variables from a Worker or ordinary Owner shell is
insufficient. It captures, publishes, and reads back the exact comment in one
Orchestrator-bound operation. The canonical comment body is the formatted JSON with no
trailing newline; exact readback, byte count, and SHA-256 all cover those same
bytes. Record the comment and generated publication receipt in
`terminal_remediation.delivery.worktree_evidence_comment_id` and
`terminal_remediation.delivery.worktree_evidence_publication`.

The v5 capture derives both source and Worker commit/tree IDs from Git. It
requires the source HEAD/tree to equal the standing baseline, proves that
source HEAD is an ancestor of Worker HEAD, and requires the merge base to equal
the admitted source commit. Independently, it reads the oldest branch-creation
reflog entry, requires that entry's commit to equal the admitted baseline, and
binds its timestamp to the pinned AO Worker session creation timestamp. A stale
Worker that later merges the admitted source therefore remains inadmissible.
Sharing a Git common directory alone is insufficient.

```bash
SOURCE_ROOT=/home/guoqy/p0-r08-terminal-remediation/ao-pilot
WORKER_ROOT=/home/guoqy/p0-r08-terminal-remediation/ao-state/data/worktrees/ao-pilot-remediation/ao-pilot-remediation-4
RUNTIME_BINARY=/home/guoqy/p0-r08-retry-workstation/runtime-store/runtime.agent_orchestrator.v0_11_2_p0_2/linux-x64/aae8a684357271acc7ad2fa1d4116c7c65c8fa9d/bin/ao
AO_DATA_DIR=/home/guoqy/p0-r08-terminal-remediation/ao-state/data \
AO_RUN_FILE=/home/guoqy/p0-r08-terminal-remediation/ao-state/running.json \
npm --prefix "$WORKER_ROOT" run publish:self-hosting-worktree -- \
  --source-root "$SOURCE_ROOT" \
  --worker-root "$WORKER_ROOT" \
  --worker-session-id ao-pilot-remediation-4 \
  --orchestrator-session-id ao-pilot-remediation-1 \
  --runtime-binary "$RUNTIME_BINARY" \
  --out /tmp/p0-r08-standing-recovery-2-worktree-evidence.json \
  --publication-receipt-out /tmp/p0-r08-standing-recovery-2-worktree-publication.json
```

After CI is green, both formal reviews are complete, every finding disposition
is recorded and resolved, and the worktree publication receipt is copied into
the pending v6 receipt, the Orchestrator must run this executable staged gate
from the exact Worker HEAD. The output path is created exclusively and contains
canonical JSON with no trailing newline:

```bash
npm --prefix "$WORKER_ROOT" run verify:self-hosting -- \
  --receipt /tmp/p0-r08-workstation-self-hosting-receipt.json \
  --pre-merge \
  --preflight-evidence-out /tmp/p0-r08-standing-recovery-2-preflight-evidence.json \
  --repository-root "$WORKER_ROOT"
```

The `--pre-merge` mode validates the complete immutable v2 principal proof,
standing/final admissions, failed PR #72 and PR #73 chain entries and
dispositions, p0.2 runtime transition, ordered live PR
topology, all completed reviews and findings, final-head CI, Git ancestry/fork
relationship, reviewed-head ancestry, and Orchestrator-bound worktree
publication/readback. It requires `release:check` to execute from a checkout
whose current HEAD/tree exactly equal the proposed PR final HEAD/tree. It also
requires
the active delivery, replay, cleanup, and final claims to remain explicitly
pending. It does not require or accept a merge outcome, merged-main replay,
Orchestrator done, cleanup, terminal receipt publication, or protected workflow
result. A missing comment ID, incomplete readback, or premature post-merge
claim blocks the command. Success writes a timestamped artifact containing the
exact final HEAD/tree, release-check checkout identity, completed review IDs,
resolved finding comment IDs, independently derived branch creation evidence,
and exact worktree publication identity.

The same active Orchestrator must then publish and read back that preflight
artifact before merge. This command repeats the supervisor-process and current
Worker head/tree bindings and writes a durable publication receipt:

```bash
AO_DATA_DIR=/home/guoqy/p0-r08-terminal-remediation/ao-state/data \
AO_RUN_FILE=/home/guoqy/p0-r08-terminal-remediation/ao-state/running.json \
npm --prefix "$WORKER_ROOT" run publish:self-hosting-preflight -- \
  --evidence /tmp/p0-r08-standing-recovery-2-preflight-evidence.json \
  --source-root "$SOURCE_ROOT" \
  --worker-root "$WORKER_ROOT" \
  --worker-session-id ao-pilot-remediation-4 \
  --orchestrator-session-id ao-pilot-remediation-1 \
  --runtime-binary "$RUNTIME_BINARY" \
  --publication-receipt-out /tmp/p0-r08-standing-recovery-2-preflight-publication.json
```

Before final verification, replace `terminal_remediation.premerge_verification`
in the local receipt with the observed evidence comment ID and the complete
preflight publication receipt. The final verifier reads the unedited Owner
comment and rejects a missing, post-merge, edited, digest-drifted, head/tree-
drifted, finding-drifted, worktree-identity-drifted, or differently supervised
preflight artifact.

After the recovery PR merges, replay `npm run release:check` on its
exact merge SHA/tree, invoke `orchestrator done` through the literal pinned
binary, publish that command evidence, and clean only the remediation AO
sessions/worktrees/branches/project/daemon state. Record those facts under
`terminal_remediation.exact_main_replay` and `terminal_remediation.cleanup`.
The final v6 verifier preserves and revalidates the original v2 admission,
principal PR #71, comments `5157857462` and `5157899599`, and cleanup proof;
then it independently validates the exact three-entry ordered recovery chain:
failed PR #72, `failed_merge_path_provenance` PR #73, and final PR #74. It
binds both Owner admissions, the PR #72 failure disposition/reviews, every
immutable PR #73 review/finding/publication/outcome, the architectural
blocker, the p0.2 runtime transition, and PR #74 reviews/CI/merge SHA/tree, and
requires the verifier checkout to equal resulting exact current main. Any
additional, omitted, duplicated, or reordered delivery fails closed.

For any authorized no-Review-3 repair on PR #74, the final verifier additionally
derives from Git that Review 2's exact reviewed head is an ancestor of the
repaired final head and that their merge base is exactly that reviewed head.
An unrelated or force-pushed sibling cannot use the post-Review-2 repair
exception.

A connector clean completion may also be an unedited issue comment authored
through the `chatgpt-codex-connector` GitHub App whose body begins exactly
either `Codex Review: Didn't find any major issues. :+1:` or
`Codex Review: Didn't find any major issues. You're on a roll.` and contains one reviewed
commit abbreviation of at least 10 hexadecimal characters. The verifier calls
this `clean_comment` evidence and accepts it only when the abbreviation maps
uniquely to one earlier unedited Owner exact-head request. Generic connector
comments, setup/errors, edited comments, non-App impersonations, ambiguous
abbreviations, and unrelated heads remain non-evidence and cannot suppress the
request-comment reaction lookup.

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
new P0-R08 retry principal PR from GitHub, enumerates all issue #63 linked PRs
and requires exactly one post-admission retry PR, verifies required check runs,
and validates each counted Codex Review against an unedited owner-authored
exact-head request plus either a submitted bot review or the bot's clean `+1`
reaction. It also requires the source clone, AO state/run paths, runtime
store/cache, managed binary, and Worker worktree to remain under their exact
retry-specific roots. Receipt fields alone are never sufficient evidence.

Normally `principal_pr.reviewed_head` must equal `principal_pr.head_sha`. If
Review 2 reports findings, the Owner's two-review policy permits a final repair
without Review 3 only when `post_review_2_repair` binds the final SHA, references
issue #55, lists every Review 2 finding comment ID, and every corresponding
thread is resolved. The verifier also requires all review completions to
predate the live GitHub merge timestamp and executes `npm run release:check`
itself on the checked-out exact merge SHA.

Only after #63 merges and exact-main replay passes may #12 be marked admitted.
