# Read-only service inventory

Bound repository base: `28b4fc767880b6529f38efa87d72a99f4e2007a9`. Observed UTC: `2026-10-23T14:14:41.735362+00:00`.

Paths below are symbolic aliases; full hashes and mtimes are in `files.json`. All unit fragments, including overridden ExecStart directives, are retained as non-executable redacted records in `site-inputs.sanitized.json`. No unit is installed by this intake.

## Effective startup chains

| Service / entry | Actual chain and configuration | Repository comparison |
| --- | --- | --- |
| runtime | `$UPGRADE/runtime/bin/ao daemon`; local build source `092227ab425e8293ce8ce2e6f6b23409c751330b`; inherited package WorkingDirectory, process stabilizes cwd to configured DataDir. Proxy EnvironmentFile plus all runtime drop-ins below. No native YAML config: `internal/config/config.go` reads environment. | 有对应但版本不同; runtime lock remains p0.4, installed source differs from inventory base. Binary reproducibility NOT_RUN. |
| Dashboard | `$NODE $DASHBOARD_INSTALL/scripts/ao-dashboard.js --port <configured>` → `browser/packages/web/dist-server/start-all.js` → resolved Next CLI (`start`), `terminal-websocket.js`, `direct-terminal-ws.js`; shared `$PROJECT_CONFIG`, data/run-file env. Compiled helper source mappings listed below. | Launcher byte-identical; installed browser helpers checked through TS source. Generated output reproducibility NOT_RUN. |
| adapter | `$NODE` → standalone local `server.mjs`; listen/upstream ports from unit; private listen host from drop-in. No sibling files, package.json, node_modules or nonstandard imports. | 仓库中没有; imported by this PR. |
| PATH `ao-pilot` | `$HOME/.local/bin/ao-pilot` symlink → `$CLI_INSTALL/bin/ao-pilot.js`; env shebang resolves Node 22.22.1. Command routing reads `scripts/ao/lib/config.js`; session/lifecycle recovery routes to `scripts/ao-session.js` and `scripts/ao/lib/session-recovery.js`. | Entry differs from base; installed dispatch modules classified individually below. CLI target remains untouched. |
| PATH `ao` | No PATH wrapper found. Native daemon starts using the absolute service override. | 仓库中没有 (no file to import). |

`NeedDaemonReload=no` for all three services. Readback confirmed each MainPID command line matched its effective entrypoint; adapter process cwd is the user home. PIDs/start tokens and full Environment stay private. This does not prove already-loaded JavaScript equals current disk bytes. SQLite/session metadata and runtime-generated authority/discovery files are private mutable state, not source inputs to vendor.

## All inventoried files

Generated JS is mapped to installed TS and compared with the repository source; this is explicitly not a comparison of compiled JS to TS bytes. External interpreter and installed dependencies are separately identified.

| Input | Repository source / comparison basis | Classification |
| --- | --- | --- |
| `$SITE_CONFIG/ao-runtime-proxy.env` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-dashboard-adapter.service` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-dashboard-adapter.service.d/20-wsl-browser-access.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-dashboard.service` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-dashboard.service.d/20-native-adapter-upstream.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-dashboard.service.d/90-fresh-instance.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/10-proxy.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/20-request-timeout.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/30-send-enter-hotfix.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/40-worktree-capacity.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/50-runtime-capacity-watch.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/60-sparse-worktree.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/70-codex-path.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/90-fresh-instance.conf` | `—` | 仓库中没有 |
| `$USER_UNITS/ao-pilot-runtime.service.d/91-reliability-main.conf` | `—` | 仓库中没有 |
| `$HOME/.local/bin/ao-pilot` | `bin/ao-pilot.js` | 有对应但版本不同 |
| `$FOREGROUND_INSTALL/package.json` | `package.json` | 有对应但版本不同 |
| `$FOREGROUND_INSTALL/runtime/agent-orchestrator.lock.json` | `runtime/agent-orchestrator.lock.json` | 仓库中有对应源码且一致 |
| `$FOREGROUND_INSTALL/scripts/ao-runtime-foreground.js` | `scripts/ao-runtime-foreground.js` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/package-lock.json` | `browser/package-lock.json` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/package.json` | `browser/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/agent-selection.js` | `browser/packages/core/src/agent-selection.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/atomic-write.js` | `browser/packages/core/src/atomic-write.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/config-generator.js` | `browser/packages/core/src/config-generator.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/config.js` | `browser/packages/core/src/config.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/decomposer.js` | `browser/packages/core/src/decomposer.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/feedback-tools.js` | `browser/packages/core/src/feedback-tools.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/global-pause.js` | `browser/packages/core/src/global-pause.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/index.js` | `browser/packages/core/src/index.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/key-value.js` | `browser/packages/core/src/key-value.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/lifecycle-manager.js` | `browser/packages/core/src/lifecycle-manager.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/metadata.js` | `browser/packages/core/src/metadata.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/observability.js` | `browser/packages/core/src/observability.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/opencode-session-id.js` | `browser/packages/core/src/opencode-session-id.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/orchestrator-prompt.js` | `browser/packages/core/src/orchestrator-prompt.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/orchestrator-session-strategy.js` | `browser/packages/core/src/orchestrator-session-strategy.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/paths.js` | `browser/packages/core/src/paths.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/plugin-registry.js` | `browser/packages/core/src/plugin-registry.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/prompt-builder.js` | `browser/packages/core/src/prompt-builder.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/scm-webhook-utils.js` | `browser/packages/core/src/scm-webhook-utils.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/session-manager.js` | `browser/packages/core/src/session-manager.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/tmux.js` | `browser/packages/core/src/tmux.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/types.js` | `browser/packages/core/src/types.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/utils.js` | `browser/packages/core/src/utils.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/utils/pr.js` | `browser/packages/core/src/utils/pr.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/utils/session-from-metadata.js` | `browser/packages/core/src/utils/session-from-metadata.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/dist/utils/validation.js` | `browser/packages/core/src/utils/validation.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/package.json` | `browser/packages/core/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/agent-selection.ts` | `browser/packages/core/src/agent-selection.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/atomic-write.ts` | `browser/packages/core/src/atomic-write.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/config-generator.ts` | `browser/packages/core/src/config-generator.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/config.ts` | `browser/packages/core/src/config.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/decomposer.ts` | `browser/packages/core/src/decomposer.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/feedback-tools.ts` | `browser/packages/core/src/feedback-tools.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/global-pause.ts` | `browser/packages/core/src/global-pause.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/index.ts` | `browser/packages/core/src/index.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/key-value.ts` | `browser/packages/core/src/key-value.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/lifecycle-manager.ts` | `browser/packages/core/src/lifecycle-manager.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/metadata.ts` | `browser/packages/core/src/metadata.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/observability.ts` | `browser/packages/core/src/observability.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/opencode-session-id.ts` | `browser/packages/core/src/opencode-session-id.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/orchestrator-prompt.ts` | `browser/packages/core/src/orchestrator-prompt.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/orchestrator-session-strategy.ts` | `browser/packages/core/src/orchestrator-session-strategy.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/paths.ts` | `browser/packages/core/src/paths.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/plugin-registry.ts` | `browser/packages/core/src/plugin-registry.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/prompt-builder.ts` | `browser/packages/core/src/prompt-builder.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/scm-webhook-utils.ts` | `browser/packages/core/src/scm-webhook-utils.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/session-manager.ts` | `browser/packages/core/src/session-manager.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/tmux.ts` | `browser/packages/core/src/tmux.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/types.ts` | `browser/packages/core/src/types.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/utils.ts` | `browser/packages/core/src/utils.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/utils/pr.ts` | `browser/packages/core/src/utils/pr.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/utils/session-from-metadata.ts` | `browser/packages/core/src/utils/session-from-metadata.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/core/src/utils/validation.ts` | `browser/packages/core/src/utils/validation.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-claude-code/package.json` | `browser/packages/plugins/agent-claude-code/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-codex/dist/app-server-client.js` | `browser/packages/plugins/agent-codex/src/app-server-client.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-codex/dist/index.js` | `browser/packages/plugins/agent-codex/src/index.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-codex/package.json` | `browser/packages/plugins/agent-codex/package.json` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-codex/src/app-server-client.ts` | `browser/packages/plugins/agent-codex/src/app-server-client.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-codex/src/index.ts` | `browser/packages/plugins/agent-codex/src/index.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/agent-opencode/package.json` | `browser/packages/plugins/agent-opencode/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/runtime-tmux/dist/index.js` | `browser/packages/plugins/runtime-tmux/src/index.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/runtime-tmux/package.json` | `browser/packages/plugins/runtime-tmux/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/runtime-tmux/src/index.ts` | `browser/packages/plugins/runtime-tmux/src/index.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/scm-github/dist/index.js` | `browser/packages/plugins/scm-github/src/index.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/scm-github/package.json` | `browser/packages/plugins/scm-github/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/scm-github/src/index.ts` | `browser/packages/plugins/scm-github/src/index.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/tracker-github/dist/index.js` | `browser/packages/plugins/tracker-github/src/index.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/tracker-github/package.json` | `browser/packages/plugins/tracker-github/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/tracker-github/src/index.ts` | `browser/packages/plugins/tracker-github/src/index.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/tracker-linear/package.json` | `browser/packages/plugins/tracker-linear/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/workspace-worktree/dist/index.js` | `browser/packages/plugins/workspace-worktree/src/index.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/workspace-worktree/package.json` | `browser/packages/plugins/workspace-worktree/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/plugins/workspace-worktree/src/index.ts` | `browser/packages/plugins/workspace-worktree/src/index.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/.next/BUILD_ID` | `browser/packages/web` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/web/dist-server/direct-terminal-ws.js` | `browser/packages/web/server/direct-terminal-ws.ts (generated JS; installed TS compared)` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/web/dist-server/start-all.js` | `browser/packages/web/server/start-all.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/dist-server/terminal-observability.js` | `browser/packages/web/server/terminal-observability.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/dist-server/terminal-websocket.js` | `browser/packages/web/server/terminal-websocket.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/dist-server/tmux-utils.js` | `browser/packages/web/server/tmux-utils.ts (generated JS; installed TS compared)` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/next.config.js` | `browser/packages/web/next.config.js` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/package.json` | `browser/packages/web/package.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/server/direct-terminal-ws.ts` | `browser/packages/web/server/direct-terminal-ws.ts` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/browser/packages/web/server/start-all.ts` | `browser/packages/web/server/start-all.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/server/terminal-observability.ts` | `browser/packages/web/server/terminal-observability.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/server/terminal-websocket.ts` | `browser/packages/web/server/terminal-websocket.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/browser/packages/web/server/tmux-utils.ts` | `browser/packages/web/server/tmux-utils.ts` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/package-lock.json` | `package-lock.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/package.json` | `package.json` | 有对应但版本不同 |
| `$DASHBOARD_INSTALL/runtime/agent-orchestrator.lock.json` | `runtime/agent-orchestrator.lock.json` | 仓库中有对应源码且一致 |
| `$DASHBOARD_INSTALL/scripts/ao-dashboard.js` | `scripts/ao-dashboard.js` | 仓库中有对应源码且一致 |
| `$CLI_INSTALL/bin/ao-pilot.js` | `bin/ao-pilot.js` | 有对应但版本不同 |
| `$CLI_INSTALL/package-lock.json` | `package-lock.json` | 仓库中有对应源码且一致 |
| `$CLI_INSTALL/package.json` | `package.json` | 有对应但版本不同 |
| `$CLI_INSTALL/runtime/agent-orchestrator.lock.json` | `runtime/agent-orchestrator.lock.json` | 仓库中有对应源码且一致 |
| `$CLI_INSTALL/scripts/ao-session.js` | `scripts/ao-session.js` | 仓库中有对应源码且一致 |
| `$CLI_INSTALL/scripts/ao/lib/config.js` | `scripts/ao/lib/config.js` | 仓库中有对应源码且一致 |
| `$CLI_INSTALL/scripts/ao/lib/session-recovery.js` | `scripts/ao/lib/session-recovery.js` | 有对应但版本不同 |
| `$HOME/.local/share/ao-pilot/cie-dashboard-adapter/server.mjs` | `—` | 仓库中没有 |
| `$HOTFIXES/recovery-20260924/bin/ao` | `runtime/headless/backend/cmd/ao` | 有对应但版本不同 |
| `$HOTFIXES/runtime-capacity-20260924/bin/ao` | `runtime/headless/backend/cmd/ao` | 有对应但版本不同 |
| `$HOTFIXES/sparse-worktree-20260926/bin/ao` | `runtime/headless/backend/cmd/ao` | 有对应但版本不同 |
| `$UPGRADE/installed-provenance.json` | `—` | 仓库中没有 |
| `$UPGRADE/runtime/bin/ao` | `runtime/headless/backend/cmd/ao` | 有对应但版本不同 |
| `$NODE` | `—` | 仓库中没有 |
| `$PROJECT_CONFIG` | `—` | 仓库中没有 |

## 仓库中没有：本轮收录清单

The following missing first-party source/site inputs are accounted for by this PR. Raw private files are represented by sanitized records, never copied as active templates. B2 retains the sole authority to generate/install units.

- `$SITE_CONFIG/ao-runtime-proxy.env` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-dashboard-adapter.service` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-dashboard-adapter.service.d/20-wsl-browser-access.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-dashboard.service` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-dashboard.service.d/20-native-adapter-upstream.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-dashboard.service.d/90-fresh-instance.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/10-proxy.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/20-request-timeout.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/30-send-enter-hotfix.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/40-worktree-capacity.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/50-runtime-capacity-watch.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/60-sparse-worktree.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/70-codex-path.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/90-fresh-instance.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$USER_UNITS/ao-pilot-runtime.service.d/91-reliability-main.conf` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$HOME/.local/share/ao-pilot/cie-dashboard-adapter/server.mjs` → `server.mjs`, `config.mjs`, package metadata and mock tests.
- `$UPGRADE/installed-provenance.json` → `inventory/site-inputs.sanitized.json` (redacted site input).
- `$PROJECT_CONFIG` → `inventory/site-inputs.sanitized.json` (redacted site input).

External tools absent from first-party source: `$NODE` and the third-party packages below. Their installed binaries/node_modules are not source-intake items; hashes/versions and the existing lockfile identify these dependencies.

| Installed dependency | Version | Classification / source input |
| --- | --- | --- |
| `next` | `15.5.12` | 仓库中没有 (external package); existing browser lockfile |
| `node-pty` | `1.1.0` | 仓库中没有 (external package); existing browser lockfile |
| `ws` | `8.19.0` | 仓库中没有 (external package); existing browser lockfile |
| `yaml` | `2.8.2` | 仓库中没有 (external package); existing browser lockfile |
| `zod` | `3.25.76` | 仓库中没有 (external package); existing browser lockfile |
| `@anthropic-ai/sdk` | `0.52.0` | 仓库中没有 (external package); existing browser lockfile |

Workspace imports `@composio/ao-core` and its webhook utility resolve to first-party browser core source, included in the file mapping above. Next.js reads its generated `.next` manifests/chunks and installed package dependencies; those generated trees are bound by the existing deployment receipt/lock/build ID, not individually claimed byte-reproducible here. Static import closure is not a trace of every lazy-loaded module or every file ever read by a live process. Browser rebuild and exact generated-tree attestation: NOT_RUN.

## Path aliases

| Alias | Meaning |
| --- | --- |
| `$USER_UNITS` | user systemd configuration directory |
| `$SITE_CONFIG` | owner-only ao-pilot configuration directory |
| `$PROJECT_CONFIG` | existing project YAML (namespace-sensitive) |
| `$DASHBOARD_INSTALL` | original Dashboard deployment 8a2dce40ce267260650789b762b06b8a6f5c9ed4 |
| `$CLI_INSTALL` | session-recovery deployment 97d0ef20b41f172cbaeba50fd8f8a5db92d7b0a6 |
| `$FOREGROUND_INSTALL` | historical Dashboard package installation d01d076 (shadowed launcher) |
| `$UPGRADE` | local runtime build 092227ab425e8293ce8ce2e6f6b23409c751330b |
| `$HOTFIXES` | retained historical hotfix installations |
| `$NODE` | external Node.js 22.22.1 interpreter |
| `$HOME` | portable home-directory placeholder, not the machine account path |
