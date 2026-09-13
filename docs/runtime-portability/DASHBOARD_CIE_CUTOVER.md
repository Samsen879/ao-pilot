# Native Dashboard and CIE cutover

## Scope

The browser UI is now source-owned by `ao-pilot` outside the immutable headless
runtime subtree. It uses the native p0.4 `/api/v1` and `/mux` surfaces. No legacy
checkout, Next.js, Electron, CDN, or 14800/14801 service is required.

Preserve the old project/session/detail/terminal workflow; improve explicit
connection failure/timeout/exit status and keyboard/screen-reader accessibility.
The terminal uses locally installed xterm assets. Dashboard binds 127.0.0.1 only,
checks localhost Host and same-origin requests/upgrades, and proxies a closed
set of API routes. Opening a page never spawns a successor or restores a worker.

## Run and deploy

```sh
ao-pilot dashboard --port 3000 --runtime-port 3001
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

Do not change checkout branches while services point to this source checkout.
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

- Unit tests: host/origin/API boundaries, unavailable daemon, service generation,
  explicit runtime binding precedence, and read-only CIE receipt planning.
- Real-browser smoke: a temporary Scratch shell, mocked session REST identity,
  **real** native mux/PTY input/output; this is transport evidence, not CIE
  session migration acceptance. Desktop and 390px screenshots were inspected.
- Both user services are enabled/active; only 127.0.0.1:3000/3001 listen.
- Windows logon task manual trigger returned LastTaskResult 0.
- Service restart retained the CIE project; actual full PC reboot remains
  unexecuted, so do not call end-to-end reboot acceptance PASS.
- Full tests and package installation must be repeated on the final candidate.

Rollback: stop/disable the two new user units and unregister AO-Pilot-WSL after
explicit Owner approval. Remove or rename only the new runtime-binding file to
return default CLI reads to the old namespace; never delete either data store or
old worker worktree. Restoring legacy services is a separate explicit action.
