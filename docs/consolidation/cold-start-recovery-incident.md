# Cold-start recovery incident — 2026-09-13

The first real restart acceptance failed. Boot ID:
`b29a3f7a-5b9f-489a-876f-b8049f6d5dda`; startup: 19:47:27 CST.
Runtime, original Dashboard and recovery services started automatically at
19:47:31. Dashboard remained localhost-only, but both original CIE sessions
stayed HOLD without a restore attempt. Transcript pins and metadata survived.

Actual tmux error: `error connecting to /tmp/tmux-1000/default (No such file or directory)`.
The missing-session matcher covered an absent server but not an absent socket.
The previous canary used the workstation's existing tmux socket, so its PASS
did not establish cold-boot behavior. No manual restore was used during initial
acceptance inspection.

Fix: classify only the missing-socket connection error as a dead runtime.
Permissions and refused connections remain failures/HOLD. Strict original
conversation pins, sandbox/approval flags and fresh-conversation prohibition
are unchanged.

Regression validation now assigns a new private `TMUX_TMPDIR` to the offline
canary and its systemd process. The first restore therefore starts without any
socket, without touching the user's tmux server. Its fake Codex uses no API.
The suite also preserves live-session skip and service-start restore checks.

Deployment and same-boot recovery after this repair must not retroactively turn
the failed first restart into PASS. A subsequent actual cold restart remains
required; Windows whole-host/logon-task acceptance is separately unexecuted.
