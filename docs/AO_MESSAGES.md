# Native message outcomes and worker ACK (A4)

`ao-pilot send` and `ao-pilot ack` resolve the installed `current/native/ao` to its
verified immutable binary, preserve the selected installation's data/run-file
namespace, and proxy the native command's stdout, stderr and exit status. They do
not load a project config, add a project selector, restore a target, or retry.

```sh
ao-pilot send --session ORIGINAL_NATIVE_ID --message 'Review task instructions' \
  --message-id PERSISTENT_DISPATCH_ID --require-ack --ack-timeout 30s --json
ao-pilot ack PERSISTENT_DISPATCH_ID --json
```

The worker must explicitly ACK the ID after reading the task. Submission/activity
confirmation is not evidence that the task was read. An ACK is a receipt, not
proof that the requested work is complete.

| Outcome | HTTP | CLI exit | Meaning |
| --- | --- | --- | --- |
| `submitted_confirmed` | 200 | 0 | Native submission observed; task ACK still absent |
| `submitted_unconfirmed` | 202 | 3 | Submission cannot be confirmed; observe/escalate |
| `rejected` | 409 | 4 | No new submission accepted; inspect evidence |
| `acknowledged` | 200 | 0 | Target worker explicitly acknowledged this ID |
| `ack_timeout` | 504 | 5 | ACK deadline elapsed; delivery remains uncertain |

Infrastructure errors use exit 1 and usage errors exit 2. Results contain
`message_id`, `outcome`, and `evidence` (`code`, `signal`, `attempts`,
`recorded_at`, and native optional receipt fields). `submitted_confirmed` requires
`signal=activity_active`; `acknowledged` requires `signal=explicit_ack`.
Contradictory success evidence is an unknown/protocol failure. Dashboard and terminal reload
flows validate both the body and HTTP status. HTTP 202 / `res.ok`, old `ok:true`
or `success:true`, malformed bodies, and transport errors cannot count as
confirmation. The `/message` browser alias shares the `/send` result handler.

## Capability and single authority

Every root command first performs the read-only `ao message-contract --json`
handshake and validates `ao.message-contract.v1`, native authority, ACK support,
all five outcomes, and timeout limits. An old/missing/unknown contract refuses
before any submission. The pinned new native CLI repeats its handshake and uses
`POST /api/v1/sessions/{id}/messages`. This new route makes a daemon replacement
with an old version fail without reaching its permissive legacy `/send` route.
Node never substitutes terminal injection, a legacy send, a restored session,
or a fresh message ID after uncertainty. Native durable message records remain
the sole delivery authority; Node introduces no queue or ACK ledger.

Browser sessions are a separate legacy identity space. A browser record can use
the native path only with all five explicit metadata fields:
`nativeSessionId`, `nativeProjectId`, `nativeRuntimeBinarySHA256`,
`nativeDataDir`, and `nativeRunFile`. The latter three must match the complete
managed installation binding. A read-only native `session get` must also return
the exact native session/project. Prefixes, tmux names and browser IDs do not
establish this mapping. This change does not migrate existing browser records or
invent native identities. Missing mapping rejects `requireAck` with zero legacy
injection/restore; partial mapping rejects all sends. Legacy ordinary sends keep
their existing runtime/recovery ability and report `LEGACY_UNCONFIRMED`; they
cannot claim the native ACK contract. The pinned `ao-pilot session send` entry
also reports an explicit unconfirmed result and rejects `--require-ack` before
loading bindings or a manager.

## Task reactions and retries

Task reactions request `requireAck:true` with a deterministic ID derived from
project, session, reaction, message and persistent event facts. Review comment ID
fingerprints and CI run URL/timestamps identify supported episodes; an explicit
persisted `messageDispatchEpisode` operator token can identify other episodes.
Polling time and process-local counters never create new IDs. Without reliable
episode facts the reaction refuses worker dispatch and escalates for an explicit
operator decision. Editing an old comment without changing its identity is not
automatically a new review episode; an operator must establish a new task.

Within one controller process each ID is submitted at most once, including a
transport exception. Later polls can continue escalation without resubmission.
After controller restart the same persistent facts yield the same native ID;
native duplicate protection remains authoritative. A new legitimate episode gets
a new ID, while ACK timeout/unconfirmed/rejected/unknown outcomes never do.
Only `acknowledged` marks a task reaction delivered. Ordinary notifications keep
their separate non-ACK path; unconfirmed notification results can escalate to a
human. Failed human notifications remain eligible on later polls; only a
successful notifier or confirmed ordinary orchestrator notification marks that
escalation sent. A notification retry never resubmits the worker task. This is not
an automated retry/recovery queue.

## Worker helper lifetime and namespace

Default legacy browser launches never advertise native ACK, including browser
IDs that happen to equal a native ID. New browser spawns have no native mapping;
this change does not infer or automatically create one. The explicit public
`setupManagedAoLauncher(binding)` entry accepts a `NativeMessageBinding` with
native session/project ID and binary SHA/data/run tuple. It must match the managed
environment, pass the capability probe, and return the same native session/project
from read-only `session get`. The caller supplies that same explicit binding as
`AgentLaunchConfig.nativeMessageBinding`; only its session-private wrapper is
eligible for the worker PATH and `AO_MESSAGE_ACK_AVAILABLE`. Ordinary `ao` wrappers
remain available independently of ACK.

Native bytes are retained at `DataDir/message-cli/bin/<sha256>/ao`, independent of
release directories and release GC. Session wrappers are under
`DataDir/message-cli/wrappers/<run-file-hash>/<binary-sha>/<native-session-project-hash>/ao-pilot`.
They check retained bytes on every invocation, force the verified native session
ID and original data/run namespace, and execute native `ack`. An ambient browser
`AO_SESSION_ID` cannot change that target. Missing or tampered evidence refuses
without an ambient CLI fallback. Both namespaces and sessions have distinct
wrappers. A same-named browser ID alone proves no native ownership; no ACK helper
is advertised for it.

The wrapper remains ACK-only. Managed task prompts use the existing verified
`ao send ... --require-ack --message-id ... --json` entry, which reaches the same
native authority without colliding with the worker's `ao-pilot ack` spelling.

Go native workers install their corresponding retained helper directly. This
Node lane does not change those Go paths. No helper GC is introduced: only an
operator retiring a namespace with no live/HOLD references and an adequate
backup may clean its helpers. Other historical hooks' lifetime is outside A4.
The loopback API and worker environment use the existing trusted same-OS-user
boundary; this is not authentication against malicious local same-user clients.

## Validation boundary

Node fixtures use fake native commands or executable helpers in temporary
filesystems. Browser integration tests use a separate temporary `TMUX_TMPDIR`.
They do not touch real AO/systemd services or production data. Native/API races,
SQLite records, ACK-before-wait, timeout/late ACK, and restart behavior are verified
by the accompanying Go lane and integrated review. Real installed worker ACK,
staging upgrade/rollback and release promotion remain local validation work;
source checks do not prove deployment or promote the runtime lock. The current
historical lock does not supply A4 capability, so a real old daemon must refuse.
