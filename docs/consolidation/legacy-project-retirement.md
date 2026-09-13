# Legacy project retirement — live configuration gate

The original Dashboard implementation is owned by ao-pilot under `browser/`.
Its legacy package names and source-import receipts are provenance, not permission
to launch the retired repository. Preserve the accepted UI unchanged.

## Configuration cutover

Inspect the existing real configuration path, then run:

```sh
node scripts/retire-legacy-project.js /absolute/existing/config.yaml
node scripts/retire-legacy-project.js /absolute/existing/config.yaml --apply
```

The operation removes only the `agent-orchestrator` project and registers the
ao-pilot checkout. It preserves CIE and unrelated project configuration, rejects
conflicting identities, backs up the original file, and refuses concurrent drift.
It does not copy, delete, or launch sessions.

Do not rename or relocate a live config merely for branding: the migrated core
hashes its real parent directory and `.origin` binds its exact real path. Changing
either requires a separately verified identity migration. The compatibility names
`agent-orchestrator.yaml` and `~/.agent-orchestrator` are temporarily retained.

Restart only the Dashboard to reload its cached project list. Record session-file
hashes and tmux pane PIDs before and after; verify both original terminals output
over localhost WebSocket without sending input. Do not restart workers or OR.

## Local receipt — 2026-09-13

- Dashboard fixed deployment: `8aac9b3cd38e4289674c88ee52d6ee4f61ad5c47`.
- Config: `/home/samsen/agent-orchestrator.yaml` (same real path).
- Backup: `/home/samsen/agent-orchestrator.yaml.backup-1789298207219`.
- Config project inventory: `my-project`, `ciecopilot-home`, `ao-pilot`.
- Original CIE worker/OR metadata hashes and tmux pane PIDs unchanged.
- No legacy repository files or historical metadata deleted.

## Remaining gates — not completed by this operation

1. Inventory installed command wrappers and agent PATHs; provide an ao-pilot owned
   lifecycle/session command surface before removing old CLI access.
2. Move config/state naming only with an explicit same-conversation identity
   migration and rollback receipt. Native p0.4 state remains a separate plane.
3. Verify orchestrator/lifecycle and whole-WSL/host restart recovery; Dashboard
   automation remains held, not globally enabled by this configuration cutover.
4. Review and merge the migration PR, verify clean installation from the merged
   source, then archive the exact legacy checkout after proving no active consumer.

Do not label retirement, automatic recovery, or remote cutover complete yet.

## Owned session and recovery commands

```sh
ao-pilot session list --config /home/samsen/agent-orchestrator.yaml
ao-pilot session bind cie-111 --config /home/samsen/agent-orchestrator.yaml \
  --conversation ORIGINAL_UUID --transcript /absolute/original.jsonl \
  --binary /absolute/codex
ao-pilot session restore cie-111 --config /home/samsen/agent-orchestrator.yaml
ao-pilot session send cie-111 'Scoped instruction' --config /home/samsen/agent-orchestrator.yaml
ao-pilot lifecycle status --config /home/samsen/agent-orchestrator.yaml
ao-pilot lifecycle recover --config /home/samsen/agent-orchestrator.yaml
ao-pilot lifecycle serve --config /home/samsen/agent-orchestrator.yaml
```

These commands use only `browser/` core and plugins owned by ao-pilot. Explicit
config selection bypasses the unrelated `ao.config.json` evaluation lane.
Existing `start/status/stop` daemon and `lifecycle` evaluation semantics remain
unchanged. This recovery lifecycle does not enable reaction/backlog dispatch.

Pins reside in `~/.config/ao-pilot/session-recovery.json`; the original transcript
header ID, workspace, metadata birth time, project, and tmux name must agree.
Codex is resumed with the explicit original ID, workspace-write sandbox and
on-request approvals, without changing model or rewriting workspace hooks.
Live tmux sessions are untouched. Deliberately killed/merged sessions are skipped.
Failed launch is held without retry in the same running supervisor's outage.
Concurrent writers are locked; stale locks are reclaimed only when the recorded
boot differs or the owner PID is demonstrably absent.

`node scripts/deploy-session-recovery.js --deploy` installs a committed snapshot
and enables `ao-pilot-session-recovery.service`, independently of Dashboard and
the native daemon. It reuses compiled support only from an immutable ao-pilot
installation with identical support source/lockfile, recording the dependency.
Do not remove that support installation before rebuilding/redeploying recovery.

Verification: `node scripts/verify-session-recovery.js` exercises real tmux and
systemd using an offline Codex double. It proves live-session skip and startup
restoration of a missing canary with the same ID, with zero provider calls.
Generated canary evidence is retained under its exact temporary path; only the
test's own tmux/unit is stopped. This is not whole-host reboot or real-provider
post-reboot validation.
