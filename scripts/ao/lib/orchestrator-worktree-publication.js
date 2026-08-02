import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  P0_R08_TERMINAL_RUNTIME_BINARY,
  P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
} from './self-hosting-receipt.js';
import { captureWorktreeEvidence } from './worktree-evidence.js';

export const ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION = 'ao.workstation-orchestrator-worktree-provenance.v1';
export const ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION = 'ao.workstation-orchestrator-worktree-publication.v1';

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

  const evidence = capture({
    sourceRoot,
    workerRoot,
    workerSessionId,
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
      session_get: {
        args: sessionArgs,
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
  readBackAt = new Date().toISOString(),
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
  };
  fs.writeFileSync(path.resolve(publicationReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}
