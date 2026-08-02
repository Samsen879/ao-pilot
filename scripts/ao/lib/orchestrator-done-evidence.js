import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION = 'ao.orchestrator-done-evidence.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function captureOrchestratorDoneEvidence({
  runtimeBinary,
  orchestratorSessionId,
  completedAt = null,
  execute = execFileSync,
}) {
  assert(typeof runtimeBinary === 'string' && path.isAbsolute(runtimeBinary), 'Runtime binary path must be absolute');
  assert(typeof orchestratorSessionId === 'string' && orchestratorSessionId.trim() !== '', 'Orchestrator session ID is required');
  assert(completedAt == null || !Number.isNaN(Date.parse(completedAt)), 'Invalid completion timestamp');
  const resolvedBinary = fs.realpathSync(runtimeBinary);
  const sessionId = orchestratorSessionId.trim();
  const args = ['orchestrator', 'done', '--session', sessionId];
  const stdout = execute(resolvedBinary, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert(stdout === `Orchestrator ${sessionId} marked done.`, 'Pinned AO did not confirm durable Orchestrator completion');
  const confirmedAt = completedAt ?? new Date().toISOString();

  return {
    schema_version: ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION,
    issue_number: 63,
    completed_at: confirmedAt,
    orchestrator_session_id: sessionId,
    command: {
      runtime_binary_path: resolvedBinary,
      args,
      exit_code: 0,
      stdout,
    },
  };
}
