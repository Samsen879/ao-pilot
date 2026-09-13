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
