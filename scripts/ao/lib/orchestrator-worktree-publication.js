import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  P0_R08_TERMINAL_RUNTIME_BINARY,
  P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
} from './self-hosting-receipt.js';
import { captureWorktreeEvidence } from './worktree-evidence.js';

export const ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION = 'ao.workstation-orchestrator-worktree-provenance.v2';
export const ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION = 'ao.workstation-orchestrator-worktree-publication.v2';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultSessionGet(runtimeBinary, args) {
  return JSON.parse(execFileSync(runtimeBinary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function processRecord(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const commandEnd = stat.lastIndexOf(')');
  assert(commandEnd > 0, `Unable to parse process identity for PID ${pid}`);
  const fields = stat.slice(commandEnd + 2).split(' ');
  const rawCommandLine = fs.readFileSync(`/proc/${pid}/cmdline`);
  return {
    pid,
    parentPid: Number(fields[1]),
    startToken: fields[19],
    executablePath: fs.realpathSync.native(`/proc/${pid}/exe`),
    rawCommandLine,
    args: rawCommandLine.toString('utf8').split('\0').filter(Boolean),
  };
}

export function inspectAoSupervisorProcess({
  runtimeBinary,
  orchestratorSessionId,
  runtimeLaunchId,
  currentPid = process.pid,
  readProcess = processRecord,
  executableDigest = (candidate) => sha256(fs.readFileSync(candidate)),
}) {
  let pid = currentPid;
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    const candidate = readProcess(pid);
    const sessionIndex = candidate.args.indexOf('--session');
    const launchIndex = candidate.args.indexOf('--launch');
    if (candidate.executablePath === runtimeBinary
      && candidate.args[1] === 'agent-process'
      && candidate.args[2] === 'supervise'
      && sessionIndex > 2
      && launchIndex > sessionIndex
      && candidate.args[sessionIndex + 1] === orchestratorSessionId
      && candidate.args[launchIndex + 1] === runtimeLaunchId) {
      return {
        supervisor_pid: candidate.pid,
        supervisor_process_start_token: candidate.startToken,
        supervisor_executable_path: candidate.executablePath,
        supervisor_executable_sha256: executableDigest(candidate.executablePath),
        supervisor_command_sha256: sha256(candidate.rawCommandLine),
        session_id: orchestratorSessionId,
        runtime_launch_id: runtimeLaunchId,
        current_process_is_descendant: true,
      };
    }
    pid = candidate.parentPid;
  }
  throw new Error('Publication process is not a descendant of the declared AO Orchestrator supervisor');
}

export function captureOrchestratorBoundWorktreeEvidence({
  sourceRoot,
  workerRoot,
  workerSessionId,
  orchestratorSessionId,
  runtimeBinary,
  env = process.env,
  capturedAt = new Date().toISOString(),
  sessionGet = defaultSessionGet,
  probes = {},
}) {
  const resolveRuntimeBinary = probes.resolveRuntimeBinary ?? fs.realpathSync.native;
  const runtimeDigest = probes.runtimeDigest ?? ((candidate) => sha256(fs.readFileSync(candidate)));
  const capture = probes.captureWorktreeEvidence ?? captureWorktreeEvidence;
  const inspectProcess = probes.inspectAoSupervisorProcess ?? inspectAoSupervisorProcess;
  const resolvedRuntimeBinary = resolveRuntimeBinary(runtimeBinary);
  assert(resolvedRuntimeBinary === P0_R08_TERMINAL_RUNTIME_BINARY, 'Worktree publication did not use the exact pinned runtime binary');
  assert(runtimeDigest(resolvedRuntimeBinary) === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Pinned runtime binary digest mismatch');
  assert(env.AO_SESSION_ID === orchestratorSessionId, 'Worktree publication command is not bound to the declared AO Orchestrator session');
  assert(env.AO_PROJECT_ID === 'ao-pilot-remediation' && env.AO_ISSUE_ID === '63', 'Worktree publication process lacks the admitted AO project/issue binding');
  assert(typeof env.AO_RUNTIME_LAUNCH_ID === 'string' && env.AO_RUNTIME_LAUNCH_ID.trim() !== '', 'Worktree publication process lacks an AO runtime launch binding');
  assert(orchestratorSessionId !== workerSessionId, 'Orchestrator and Worker session IDs must be distinct');

  const sessionArgs = ['session', 'get', orchestratorSessionId, '--json'];
  const sessionPayload = sessionGet(resolvedRuntimeBinary, sessionArgs);
  const session = sessionPayload?.session;
  assert(session?.id === orchestratorSessionId, 'Pinned AO returned the wrong Orchestrator session');
  assert(session?.kind === 'orchestrator', 'Worktree publication session is not an Orchestrator');
  assert(session?.projectId === 'ao-pilot-remediation', 'Worktree publication Orchestrator belongs to the wrong project');
  assert(String(session?.issueId) === '63', 'Worktree publication Orchestrator is not bound to issue #63');
  assert(session?.activity?.state === 'active' && session?.isTerminated === false, 'Worktree publication Orchestrator is not active');
  const workerSessionArgs = ['session', 'get', workerSessionId, '--json'];
  const workerSession = sessionGet(resolvedRuntimeBinary, workerSessionArgs)?.session;
  assert(workerSession?.id === workerSessionId && workerSession?.kind === 'worker', 'Pinned AO returned the wrong Worker session');
  assert(workerSession?.projectId === session.projectId && String(workerSession?.issueId) === '63', 'Worktree publication Worker belongs to the wrong project/issue');
  const processBinding = inspectProcess({
    runtimeBinary: resolvedRuntimeBinary,
    orchestratorSessionId,
    runtimeLaunchId: env.AO_RUNTIME_LAUNCH_ID,
  });
  assert(processBinding.current_process_is_descendant === true, 'Worktree publisher lacks AO supervisor ancestry');
  assert(processBinding.supervisor_executable_path === resolvedRuntimeBinary && processBinding.supervisor_executable_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Worktree publisher supervisor runtime mismatch');

  const evidence = capture({
    sourceRoot,
    workerRoot,
    workerSessionId,
    workerSession,
    capturedAt,
    env,
  });
  return {
    ...evidence,
    orchestrator_provenance: {
      schema_version: ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION,
      session_id: orchestratorSessionId,
      worker_session_id: workerSessionId,
      project_id: session.projectId,
      issue_number: Number(session.issueId),
      kind: session.kind,
      activity_state: session.activity.state,
      is_terminated: session.isTerminated,
      runtime_launch_id: env.AO_RUNTIME_LAUNCH_ID,
      runtime_binary_path: resolvedRuntimeBinary,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
      process_binding: processBinding,
      session_get: {
        args: sessionArgs,
        worker_args: workerSessionArgs,
      },
      operation: {
        capture: true,
        publish_issue_comment: true,
        read_back_exact_body: true,
      },
    },
  };
}

function defaultPublish(payloadPath) {
  return JSON.parse(execFileSync('gh', [
    'api', '--method', 'POST', 'repos/Samsen879/ao-pilot/issues/63/comments',
    '-F', `body=@${payloadPath}`,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function defaultReadBack(commentId) {
  return JSON.parse(execFileSync('gh', [
    'api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

export function publishOrchestratorBoundWorktreeEvidence({
  payload,
  payloadPath,
  publicationReceiptPath,
  publish = defaultPublish,
  readBack = defaultReadBack,
  now = () => new Date().toISOString(),
}) {
  const raw = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.resolve(payloadPath), raw, { flag: 'wx' });
  const published = publish(path.resolve(payloadPath));
  assert(Number.isSafeInteger(published?.id) && published.id > 0, 'GitHub did not return a worktree-evidence comment ID');
  const observed = readBack(published.id);
  assert(observed?.id === published.id, 'Worktree-evidence readback returned the wrong comment');
  assert(observed?.user?.login === 'Samsen879' && observed?.author_association === 'OWNER', 'Worktree evidence was not published by the Owner credential');
  assert(observed?.created_at === observed?.updated_at, 'Published worktree evidence was edited');
  assert(observed?.body === raw, 'Worktree-evidence readback body differs from the published payload');
  const readBackAt = now();

  const receipt = {
    schema_version: ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION,
    issue_number: 63,
    comment_id: observed.id,
    published_at: observed.created_at,
    read_back_at: readBackAt,
    payload_bytes: Buffer.byteLength(raw, 'utf8'),
    payload_sha256: sha256(raw),
    exact_body_read_back: true,
    orchestrator_session_id: payload.orchestrator_provenance.session_id,
    runtime_binary_path: payload.orchestrator_provenance.runtime_binary_path,
    runtime_binary_sha256: payload.orchestrator_provenance.runtime_binary_sha256,
    process_binding: payload.orchestrator_provenance.process_binding,
  };
  assert(Date.parse(receipt.read_back_at) >= Date.parse(receipt.published_at), 'Worktree-evidence readback timestamp predates publication');
  fs.writeFileSync(path.resolve(publicationReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}
