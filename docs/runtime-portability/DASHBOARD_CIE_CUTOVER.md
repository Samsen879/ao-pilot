# Original browser Dashboard and CIE cutover

## Scope

The simplified native UI was rejected by the Owner. The complete original
Next.js Dashboard is now transplanted into `browser/`, outside the immutable
headless runtime subtree. It includes original pages, components, CSS, API
routes, terminal servers and supporting core/plugins. No retired checkout or
its node_modules is required at runtime. This preserves the compatible
flat-file session backend; it does NOT establish native database migration.

All original visual source bytes are verified by
`node scripts/verify-browser-source.js`. Backend changes bind Next.js and
14800/14801 to 127.0.0.1, hold writes/terminal actions during validation and
disable automatic lifecycle/backlog dispatch by default. Terminal permanent
close codes are aligned with the unchanged original frontend to avoid retrying
missing sessions indefinitely. Opening a page never restores a worker.

## Run and deploy

```sh
cd browser
npm ci
npm run build:deps
NODE_ENV=production npm run build
cd ..
AO_CONFIG_PATH=/home/samsen/agent-orchestrator.yaml AO_DASHBOARD_READ_ONLY=1 ao-pilot dashboard --port 3000
node scripts/install-dashboard-service.js           # inspect generated units
node scripts/install-dashboard-service.js --install # refuses existing units
systemctl --user daemon-reload
systemctl --user enable --now ao-pilot-runtime.service ao-pilot-dashboard.service
loginctl enable-linger "$USER"
```

The foreground runtime launcher verifies the managed runtime before execution.
Deployment uses `~/.local/share/ao-pilot/cie-runtime/{data,running.json}` and leaves
the old `~/.ao/data` intact. A typed `~/.config/ao-pilot/runtime-binding.json`
aligns default runtime CLI/observation calls with this deployment. Explicit
AO_DATA_DIR/AO_RUN_FILE overrides take precedence for private/isolated runs.

For this workstation, `scripts/install-dashboard-wsl-task.ps1` registers the
current Windows user's AO-Pilot-WSL logon task for Ubuntu/user samsen/UID 1000.
It refuses replacement, uses limited privileges, and starts the user service.
Other workstation users/distributions must adapt the installer before use.
User services start when WSL starts; the Windows task supplies owner-sign-in
activation. This is not a claim of pre-login Windows boot activation.

The original config path preserves the existing hashed session namespace.
Do not move it or change checkout branches while services point to this source checkout.
A reviewed immutable package installation is the final durable deployment gate.
The initial local deployment is a candidate, not a merged release.

## CIE configuration and legacy sessions

`node scripts/cie-cutover-plan.js <legacy-config.yaml> <sessions-dir>` reads
source bytes, fingerprints config and selected legacy sessions, maps CIE fields,
reports unsupported fields, and leaves every legacy file unchanged. Native
project registration uses projectId/path/name/config, not a session import.
Codex role overrides are explicit; stale legacy command guidance is amended in
the new config only. Missing fields are not silently invented as session facts.

The old worker cie-111 belongs to open PR #1930 and has a dirty existing worktree.
It must not be replaced by a new worker, reset, or cleaned during cutover.
p0.4's legacy importer registers projects, not existing session/runtime/workspace
or native transcript identity. Session registration/recovery remains HOLD until
its importer and exact transcript/worktree/PR binding are verified. A new
conversation is not native transcript recovery.

## Verification and rollback

### Codex restore entry repair (source candidate)

Owner-authorized recovery resumed cie-111 on 2026-09-13 in that exact original
conversation, existing worktree and PR #1930. No replacement worker/worktree
was created and workspace hooks were not rewritten. The worker acknowledged
the handoff and began live rebinding before serial final validation; this is
not issue completion or validation PASS. Its interrupted prior run remains
non-PASS. Global automation remains off. `--terminal-access` on the committed
deployer explicitly opens local direct terminal access while retaining the
API write hold; it does not relax approval/sandbox settings for the worker.

Codex restore now resolves a non-empty native resume command before archive
metadata writes, workspace restoration/hooks or destruction of the prior
runtime. Missing discovery support, null/blank commands or discovery errors
cannot silently trigger a fresh Codex launch. Other agents' legacy behavior is
unchanged. The rollout parser supports session_meta.payload.id/session_id,
rejects conflicting metadata identities, and preserves that authoritative ID
instead of replacing it with later event/message identifiers.

Verification: 26 restore-specific core tests passed; 155 Codex parser/plugin
tests passed; 419 original Dashboard/API/terminal tests passed; both supporting
libraries compiled and the original visual-source hash check passed. A full
core session-manager run was not PASS: it also encountered an unrelated
OpenCode orchestrator-title discovery timeout. Focused restore results do not
substitute for that full suite.

Read-only discovery against the retained cie-111 workspace produced native
resume for 01a08b6a-6520-7c23-956b-67e5e48ca320, the transcript bound to its
latest handoff. Legacy metadata hashes were unchanged. This verification did
not execute the command, start an agent, migrate state or deploy the source
candidate; the current pinned Dashboard remains read-only.

- Unit tests: host/origin/API boundaries, unavailable daemon, service generation,
  explicit runtime binding precedence, and read-only CIE receipt planning.
- Historical simplified-UI smoke (not accepted original-UI evidence): a temporary Scratch shell, mocked session REST identity,
  **real** native mux/PTY input/output; this is transport evidence, not CIE
  session migration acceptance. Desktop and 390px screenshots were inspected.
- Original browser workspace: final production build PASS, 18 suites / 419
  tests PASS; original visual-source SHA256 verification PASS (24 files).
- AO Pilot regression: 111 suites / 1072 tests PASS. Source package dry-run:
  951 entries, 200 browser entries; no browser dependencies or build caches.
- CIE API recognizes cie-111 and cie-orchestrator under the original namespace.
  Host tmux is absent: metadata visibility is not live-session recovery.
- The deployed original browser candidate listens on 127.0.0.1:14800/14801 in addition
  to 3000 and the separately managed native daemon on 3001.
- Windows logon task manual trigger returned LastTaskResult 0.
- Service restart retained the CIE project; actual full PC reboot remains
  unexecuted, so do not call end-to-end reboot acceptance PASS.
- Dashboard service is active/enabled and its prior unit is backed up. Only
  that unit was replaced; the native runtime service and CIE state were left
  untouched. Browser screenshots show original homepage and session detail;
  validation HOLD is explicit and no longer retries indefinitely.
- Independent npm package installation/public API verification PASS (951
  entries). Browser production build and tests were run in its separate
  workspace; installing the root package alone does not install browser deps.

Rollback: stop/disable the two new user units and unregister AO-Pilot-WSL after
explicit Owner approval. Remove or rename only the new runtime-binding file to
return default CLI reads to the old namespace; never delete either data store or
old worker worktree. Restoring legacy services is a separate explicit action.
