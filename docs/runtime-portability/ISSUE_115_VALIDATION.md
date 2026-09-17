# Issue 115 installed-runtime validation

This report keeps source-main evidence and installed-runtime evidence separate. The
read-only installed snapshot is
[`issue-115-installed-runtime-receipt.json`](./issue-115-installed-runtime-receipt.json).
The clean committed source-candidate replay is recorded separately in
[`issue-115-source-candidate-receipt.json`](./issue-115-source-candidate-receipt.json).

## Confirmed current gaps

- A managed Codex worker PATH contains `~/.ao/bin`, but the installed wrapper set
  has only `git`, `gh`, and `ao-metadata-helper.sh`; bare `ao` is unavailable.
- The installed managed runtime supports global `ao status --json` and project
  readback through `ao project get <id> --json`. It does not advertise a project
  flag for `status`; the repository's old `status --project` examples were wrong.
- The installed runtime predates current-main spawn-attempt custody: its
  `ao spawn --help` has no `--attempt-id`. This is an installed-runtime `HOLD`,
  not evidence that the current source implementation is absent.
- The AO runtime systemd unit is active, while the supported status command says
  the bound run-file points to a dead PID. Neither projection is promoted over
  the other; the conflict remains `HOLD` pending an authorized service replay.

## Source repair in this change

- Browser Codex setup and pinned-session recovery atomically install a fail-closed
  `~/.ao/bin/ao` wrapper before worker launch or restore.
  The wrapper accepts only the absolute, regular, executable, non-symlink runtime
  path injected by the installed AO service.
- Generated service units bind that exact verified managed binary and its daemon
  data/run-file namespace; the Codex adapter forwards all three dedicated bindings
  into workers and the wrapper restores them before execution.
- Codex-only worker instructions define `ao status --json` as global daemon
  health and `ao project get <project-id> --json` as project readback. Other agent
  prompts do not claim that the Codex launcher exists.
- Operator project readback uses `ao-pilot runtime-project-get <id> --json`, so it
  resolves and verifies the managed runtime without relying on ambient `PATH`.
- `ao-pilot status --project ...` and the other global lifecycle commands now
  reject the unsupported flag instead of silently discarding it.
- `ao-pilot runtime-contract --json` performs read-only version/help probes,
  verifies the worker launcher plus binary/data/run-file bindings, and converts
  probe exceptions into a normalized machine-readable `HOLD`.

## Acceptance matrix

| Surface | Source candidate | Installed runtime | Disposition / owner |
| --- | --- | --- | --- |
| Worker launcher and CLI contract | Implemented and covered by focused Jest/Vitest/typecheck | Missing launcher; old spawn capability | AO source owner; cutover requires separate Owner authorization |
| Registration and namespace identity | Existing #107 recovery tests retained | Config/binding fingerprints captured; cold start not run | `NOT_ESTABLISHED`; AO installed-runtime replay |
| Spawn timeout reconciliation | Current Go source exposes `--attempt-id`; existing bounded Go tests pass | Installed binary lacks `--attempt-id` | `HOLD`; AO runtime cutover/replay |
| Execution terminality | Existing #109 source tests retained | Reboot/kill replay not run | `NOT_ESTABLISHED`; AO installed-runtime replay |
| Owner supersession | Existing #110 focused tests pass | Effect enforcement not injected into a real worker | `NOT_ESTABLISHED`; AO installed-runtime replay |
| Recap versus raw terminal receipt | Source tests preserve raw terminal evidence | No safe current-main installed replay | `NOT_ESTABLISHED`; AO projection owner |
| Browser 120-second / 7.5-GiB materialization | No substitute native claim | Historical observation only | `NOT_ESTABLISHED`; browser adapter owner |
| Global quiescence across unrelated work | No current-main reproduction | Not injected | `NOT_ESTABLISHED`; scheduler/supervisor owner |
| Approval timeout classification | No current-main reproduction | Not injected | `NOT_ESTABLISHED`; approval-policy/UI owner |
| Duplicate wake/poll behavior | No current-main measurement | Not injected | `NOT_ESTABLISHED`; scheduler/supervisor owner |
| Baseline target selection | No CIE workflow mutation in this issue | Not replayed | `NOT_ESTABLISHED`; CIE workflow/AO adapter ownership must be established first |

## Safety boundary

No service was restarted, no host/WSL reboot was requested, no real worker was
restored, killed, cleaned, or failure-injected, and no 9231 product validation
was rerun. Those actions remain separate authorization gates. Source merge will
not be reported as installed-runtime PASS; a post-cutover receipt must re-run the
same CLI contract plus isolated native/browser recovery fixtures.
