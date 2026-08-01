# P0-R01 Runtime Portability Incident Baseline

Status: **P0 / release blocker**  
Issue: [#56](https://github.com/Samsen879/ao-pilot/issues/56)  
Policy: `policy.ao_runtime_portability_recovery.v1`  
Recorded: `2026-08-02T01:23:18+08:00`

## Verdict

`ao-pilot@0.2.0` has package-level portability. It does **not** yet have
operational runtime portability or fresh-workstation self-hosting acceptance.

The valid package claim is narrow: the npm tarball can be installed in an
isolated consumer, its declared public exports can be imported, the
`ao-pilot` binary can run package-owned commands, and the bundled evaluation
pack can replay. That does not install or authenticate an Agent Orchestrator
runtime, start an OR, create a Worker, manage an independent worktree, or prove
GitHub delivery.

Issue #12 is therefore not admitted. The only admitted implementation issue is
#56. The P0 lane is #55 with strictly serial children #56 through #63.

## Frozen observation versus live observation

The accident report supplied a frozen `ao-pilot` main SHA
`e51bef40ccd124939b2781b14af3297e856c6f17` and tree
`67aa09d8b11a6532876353f500df7fb529e4d9b5`. A fresh GitHub read before any
issue write found the same live SHA and tree, zero open pull requests, and no
existing equivalent P0/bootstrap lane.

The frozen estimate of roughly eleven local Agent Orchestrator commits did not
survive live inspection: the old checkout has **12** commits unique to its
stale `origin/main`. This is an observation, not a verdict that all 12 are
needed. P0-R02 must classify each one separately.

The machine-readable source of this baseline is
[`p0-r01-incident-inventory.json`](p0-r01-incident-inventory.json).

## Dependency inventory

| Boundary | Required inputs | Current P0-R01 result |
|---|---|---|
| Package install | Node.js, npm lockfile, `ao-pilot` tarball and public exports | Established at package level |
| Control plane | `ao-pilot` CLI, durable state, runtime/source-control providers | Installable; operational runtime resolver absent |
| External runtime | Public immutable artifact/source, exact binary, daemon/session runtime, compatibility contract | Not established |
| GitHub delivery | Git, authenticated GitHub provider, issues, PRs, checks and reviews | Connector available; local `gh` authentication is invalid |
| Agent credentials | User-provided GitHub and Codex authentication | Explicit prerequisite; must not be copied or printed |
| Workstation | Fresh clone, isolated HOME/state, managed runtime store, independent worktrees | Not established; owned by P0-R05 through P0-R08 |

The current workstation does not have Go on `PATH`, which is relevant because
the official source build declares Go 1.25.7. This does not block the audit,
but it prevents treating an unexecuted source build as installation evidence.

## Old local runtime custody

The old command resolves as follows:

```text
command:          /home/samsen/.nvm/versions/node/v22.22.1/bin/ao
resolved target:  /home/samsen/.local/share/agent-orchestrator-src/packages/cli/dist/index.js
package:          @composio/ao-cli@0.1.0
checkout branch:  codex/unfinished-chain-resume
checkout HEAD:    00bea6e589b4696ea7c897ea45dd15e2de78b4e7
checkout tree:    9499d49334b3ba8b3da60ea653483a1a0d00377a
stale origin/main:a99aedf9a889f023477cfb1696b73f3c74fa0e79
unique commits:   12
```

The checkout was clean when inspected. It remains read-only evidence: it must
not be pushed, copied into the managed runtime store, or used as authority for
a fresh-machine proof. Commit subjects and exact SHAs are recorded in the JSON
inventory with `parity_disposition=pending_p0_r02`.

## Current official upstream observation

The canonical public repository is
[`Untrivial-ai/agent-orchestrator`](https://github.com/Untrivial-ai/agent-orchestrator).
At reconciliation time:

- main was `4a907abda23db81865e594f2e00b3c0cef4cc3ee`, tree
  `8b9f57b938a7f0e9f5ef29a7663e748f8c1ec47a`;
- the latest stable release was `v0.11.2`, commit
  `c5523a6d0e51251b79555b95ddc7d2be59da0f50`, tree
  `6784a292cb54c4a2031ede6cfeaee9a4bb1cd104`;
- the live npm wrapper was `@aoagents/ao@0.10.3`, with Linux binary package
  `@aoagents/ao-linux-x64@0.10.3`;
- the stable source declares Go 1.25.7, Node.js 20.19+ and npm 10 for a source
  build; `packages/build-binaries.sh` builds `backend/cmd/ao` with CGO disabled.

No artifact is selected here. The Git tag, source package metadata, npm
registry versions, desktop release assets, `ao start` behavior, and post-tag
upstream changes are not interchangeable. In particular, the stable tag
contains idle-orchestrator re-engagement behavior that current upstream later
removed. P0-R02 owns parity/safety classification; P0-R03 owns the official
release versus public-fork decision.

## Release-claim correction

| Prior or implied claim | P0-R01 disposition |
|---|---|
| The v0.2.0 tarball and declared public package boundary are independently installable | Remains valid at package level |
| Generic `ao-pilot` source is separated from the downstream product repository | Remains valid as a source/package boundary |
| `verify:package` proves Agent Orchestrator runtime portability | Withdrawn |
| The documented second-machine package recipe proves self-hosting | Narrowed to package-only verification |
| `scripts/ao/start-clean.sh` uses a pinned and authenticated runtime | Withdrawn; it resolves arbitrary PATH `ao` |
| A fresh clone can run `ao-pilot start` | Not established; the command does not exist |
| Canonical consolidation removed the embedded generic control-plane core | Remains valid in its historical source/package scope |
| `ao-pilot` is operationally migratable and #12 may start | Withdrawn until P0-R08 closes |

Historical reports are not deleted or rewritten as if their original scope was
different. The consolidation report now points to a superseding operational
portability erratum.

## Evidence and limitations

- The issue migration receipt is committed as
  [`p0-r01-issue-migration-receipt.json`](p0-r01-issue-migration-receipt.json)
  and was also published on #56.
- `gh auth status` failed for the local CLI. GitHub issue administration used
  the authenticated GitHub connector as `Samsen879`; no token was printed.
- No Agent Orchestrator source build or runtime start was executed in P0-R01.
- No old `.agent-orchestrator`/`.ao` state, session, lease, credential or
  worktree was copied.
- No npm package, GitHub Release, repository setting or secret was changed.

## Exit rule

P0-R01 can close only after this evidence, its focused verification, the full
relevant test suite, required CI, and a fresh GitHub Codex Review are bound to
the exact principal PR HEAD. A PASS review alone is not merge evidence. P0-R02
remains blocked until merge confirmation, exact-main replay, closeout receipt,
and governed worktree cleanup.
