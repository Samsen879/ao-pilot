# ao send / ao ack

Send once to an existing native session and inspect `{message_id,outcome,evidence}`. For task assignment/redirection require a reading ACK; ordinary status or blocker notices do not require it.

```sh
ao send --session mer-3 --message "Implement the agreed backend task" --require-ack --ack-timeout 30s --json
# The receiving worker reads the appended line, then runs it in its original environment:
ao-pilot ack <message-id>
```

Flags: `--session`, `--message` required; optional `--message-id` (1..128 letters/digits/_/-), `--require-ack`, `--ack-timeout` (default30s, maximum60s, requires ACK), `--json`. `ao ack <id> [--session <id>] [--json]` defaults to AO_SESSION_ID and refuses a conflicting explicit session.

Exit0 means submitted_confirmed or acknowledged; 3 submitted_unconfirmed; 4 rejected; 5 ack_timeout; 1 infrastructure/protocol failure; 2 usage. Only acknowledged proves the receiving worker explicitly read it. A fresh native activity signal confirms submission, not reading. JSON is still emitted for business nonzero results. Never treat all2xx/202 as confirmed.

Do not automatically retry the message. Every ID has durable custody before injection; reuse is rejected, including already acknowledged IDs. Rejection may preserve a partial/full unsubmitted draft: do not paste again or press Enter into permission prompts. ACK timeout/cancellation never schedules replay.

`ao message-contract --json` reads native capabilities. Unsupported/legacy authorities cannot require ACK. The CLI uses the protocol-specific messages resource and never falls back to an old daemon's send route. Root ao-pilot send/ack uses the verified native runtime; do not bypass AO through tmux/PTY internals.
