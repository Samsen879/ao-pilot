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
git checkout --detach <P0-R07-EXACT-MAIN-SHA>
test "$(git rev-parse HEAD^{tree})" = '<P0-R07-EXACT-MAIN-TREE>'
npm ci
npm run verify:runtime-lock
./scripts/bootstrap.sh --json
node ./bin/ao-pilot.js runtime-path --json
node ./bin/ao-pilot.js doctor --json
node ./bin/ao-pilot.js start --project ao-pilot
```

Record the bootstrap and doctor provenance without credentials. The source,
tag object, commit, tree, lock digest, binary digest, and absolute binary path
must match the committed locks.

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
AO may merge only under the issue's review policy and green required CI, must
re-read the GitHub merge outcome, replay the merge SHA on exact main, stop the
session, remove the Worker worktree, and verify that no stale ownership remains.

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

Post that exact JSON to issue #63, base64-encode the same bytes, and run the
manual `workstation-self-hosting-proof` workflow on exact post-merge `main`.
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

Only after #63 merges and exact-main replay passes may #12 be marked admitted.
