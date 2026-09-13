# ao-pilot independence closeout — 2026-09-13

Local independence and original-session recovery have passed real WSL cold-start
acceptance. Migration PR #104 and recovery repair PR #105 are merged. Remote
`Samsen879/agent-orchestrator` retirement is not performed by this closeout.
Windows whole-host/logon acceptance was explicitly excluded by the Owner; it is
not a PASS claim and is not a remaining acceptance gate.

## Source and installed authority

| Component | Exact source / authority |
| --- | --- |
| Verified merged main | `585e0c4173a8f15c5779bc02efd58da14bef882c` |
| Merged main tree | `63ba5e589c327fa104fb991801dcf5d31f8af185` |
| Installed recovery and owned CLI | `97d0ef20b41f172cbaeba50fd8f8a5db92d7b0a6`, identical tree to merged main |
| Accepted original Dashboard | `8a2dce40ce267260650789b762b06b8a6f5c9ed4`; `browser/` has no diff against verified main |
| Native runtime | `runtime.ao_pilot_headless.v0_11_2_p0_4`, source `43d37ef2a76e1949c8032c49c5e6197d98bf0b96` |
| Native runtime source tree | `91282c19b408935e94d732e8e10699d393f3c821` |
| Native linux-x64 binary SHA256 | `45d257d19810cb606917ce734ec281c16617b0ec0088591e3cea909c27868919` |

Actual immutable installation directories under
`/home/samsen/.local/share/ao-pilot/apps/` are:

- `session-recovery-97d0ef20b41f172cbaeba50fd8f8a5db92d7b0a6`:
  `DEPLOYMENT.json`, recovery supervisor and the target of
  `/home/samsen/.local/bin/ao-pilot`.
- `original-dashboard-8a2dce40ce267260650789b762b06b8a6f5c9ed4`:
  accepted full Dashboard and compiled support used by recovery.
- `dashboard-d01d076/node_modules/ao-pilot`: native daemon launcher only;
  despite its historical directory name, this is not the active Dashboard UI.

Keep all three installations: recovery symlinks compiled support from the
Dashboard installation. Source-tree equality means no redeployment or CIE
restart is necessary solely to replace the PR head SHA with the merge SHA.
Native runtime binding is `~/.config/ao-pilot/runtime-binding.json`; its isolated
data is `~/.local/share/ao-pilot/cie-runtime/data`. This native state plane has
not imported the original CIE sessions; their recovery is provided by ao-pilot's
migrated session manager and owned recovery supervisor.

## Exact-main replay and repair closeout

The following sequential command completed with exit 0 on the merged main above:

```sh
npm test &&
npm run ao:test:acceptance &&
npm run verify:package &&
npm run verify:runtime-lock &&
npm run verify:runtime-bootstrap &&
npm run verify:runtime-lifecycle &&
npm audit --omit=dev &&
npm run test --prefix browser --workspace ./packages/plugins/runtime-tmux &&
node scripts/verify-session-recovery.js &&
node scripts/verify-browser-source.js
```

Results: 113 root suites / 1082 tests, 7 acceptance tests, 30 tmux tests;
package and runtime contracts PASS; zero production dependency vulnerabilities;
private-socket recovery canary PASS with zero provider calls and no live CIE
mutation; 24 original visual source files unchanged. This does not claim an
all-packages browser test run. PR #105's Node 20, Node 22 and fresh-clone checks
also succeeded. Origin/main was fetched again after replay and remained the
same SHA. Local merged branch `task/cold-start-socket-recovery` was deleted;
unrelated branches/worktrees and untracked Owner `AGENTS.md` were preserved.

## Real WSL cold-start receipt

Boot `3698be36-d253-47f7-bae3-a8a3eaed9f65` began at
2026-09-13 21:42:57 CST. Enabled user services started automatically at 21:43:00;
both pinned original conversations were restored at 21:43:01 and subsequently
reported LIVE. No manual service start or session restore preceded acceptance.
Dashboard terminal WebSockets produced output for both sessions without input.
All Dashboard/terminal listeners were restricted to `127.0.0.1`.

Persistent receipt:
`/home/samsen/.local/share/ao-pilot/restart-acceptance/after-cold-restart-3698be36-d253-47f7-bae3-a8a3eaed9f65.json`.
Schema: `ao.real-cold-restart-acceptance.v1`; recorded
`2026-09-13T13:44:15.600Z`; status PASS; SHA256:
`46c482106b9a4bffe5b361d35cf2be636337c2979c3c79013f7a7e56d5066793`.
Preboot identity snapshot:
`/home/samsen/.local/share/ao-pilot/restart-acceptance/before-cold-restart-97d0ef2.json`.
The earlier failed boot remains a failure in the
[incident record](cold-start-recovery-incident.md); this later PASS does not
rewrite it. Local receipts are workstation evidence, not portable artifacts
automatically available to another machine.

## Operational entry and identity protection

Use `/home/samsen/.local/bin/ao-pilot`, never a PATH-selected legacy `ao` wrapper.
Read-only diagnosis first:

```sh
ao-pilot session list --config /home/samsen/agent-orchestrator.yaml
ao-pilot lifecycle status --config /home/samsen/agent-orchestrator.yaml
systemctl --user status ao-pilot-runtime.service ao-pilot-dashboard.service ao-pilot-session-recovery.service
```

Only when recovery is actually needed and authorized:

```sh
ao-pilot session restore cie-111 --config /home/samsen/agent-orchestrator.yaml
ao-pilot session restore cie-orchestrator --config /home/samsen/agent-orchestrator.yaml
ao-pilot lifecycle recover --config /home/samsen/agent-orchestrator.yaml
```

Do not run a second `lifecycle serve` while the enabled recovery unit owns the
supervisor. A missing or conflicting original identity is HOLD, never permission
to create a new conversation. Live sessions are skipped. Pinned identities are:

| Session | Original conversation | Original workspace |
| --- | --- | --- |
| `cie-111` | `01a08b6a-6520-7c23-956b-67e5e48ca320` | `/home/samsen/.worktrees/ciecopilot-home/cie-111` |
| `cie-orchestrator` | `01a086a5-2450-7931-9ca2-c1ba5625efdd` | `/home/samsen/code/ciecopilot-home` |

Bindings: `/home/samsen/.config/ao-pilot/session-recovery.json`.
Original metadata namespace:
`/home/samsen/.agent-orchestrator/1138d27ac12f-ciecopilot-home/sessions/`.
Preserve transcript IDs, workspace, tmux names and metadata birth times. Keep
`/home/samsen/agent-orchestrator.yaml` at its original real path: path hashing
and `.origin` are identity dependencies, not retired-source dependencies.
Config backup: `/home/samsen/agent-orchestrator.yaml.backup-1789298207219`.
Do not rename compatibility paths or rebind to the newest transcript by cwd.

The three user units are enabled/active and user linger is enabled. Dashboard
flags remain `AO_DASHBOARD_READ_ONLY=1`, `AO_DASHBOARD_AUTOMATION=0`,
`AO_DASHBOARD_TERMINAL_ACCESS=1`: API mutations are blocked, automated dispatch
is held, and terminal access is available. Ports 3000, 14800 and 14801 are
localhost-only. Recovery PASS grants no CIE successor, merge or duplicate-worker
authority; ongoing issue 9231 work must follow its own latest governed handoff.

## Rollback and remaining boundary

Preserve the tested recovery `97d0ef2` and Dashboard support `8a2dce4`
installations and their deployment receipts as the known-good recovery baseline.
Before any future upgrade, record unit definitions, CLI symlink and binding
files; rollback requires restoring that compatible set together and verifying
the original IDs again. Do not roll recovery back to the pre-fix missing-socket
behavior merely because an older installation still exists.

The old local checkout and source-wrapper backup were moved, not deleted, to:
`/home/samsen/.local/share/ao-pilot/retired/agent-orchestrator-60156a815038-2026-09-13T11-45-02-968Z`.
`RETIREMENT.json` records source commit
`60156a81503849ac33fc4c227d6bcf0d083c6e71`, no active consumers at retirement,
unchanged CIE panes, recoverability and no remote deletion. The checkout is in
`checkout/`. Restoring retired source or its wrapper is not a routine recovery
step and requires separate Owner authority and an empty validated target.

The remaining retirement step is remote `Samsen879/agent-orchestrator`
disposition (archive/notice/reference cleanup), under separate authorization.
Automatic backlog/reaction/merge dispatch and cosmetic state-path migration
remain disabled or deferred intentionally, not failed cold-start gates.
