import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveUnifiedRuntime } from './release-runtime.js';
import { resolveDeploymentEnvironment } from './runtime-deployment.js';
import { fileSha256, assertRelease } from './release-manifest.js';

export const MESSAGE_OUTCOMES = ['submitted_confirmed', 'submitted_unconfirmed', 'rejected', 'acknowledged', 'ack_timeout'];
export function validateMessageContract(value) {
  assertRelease(value?.schema_version === 'ao.message-contract.v1' && value.authority === 'native' && value.require_ack === true
    && value.default_ack_timeout_ms === 30000 && value.max_ack_timeout_ms === 60000 && value.send_timeout_ms === 90000
    && Array.isArray(value.outcomes) && value.outcomes.length === MESSAGE_OUTCOMES.length
    && MESSAGE_OUTCOMES.every((outcome) => value.outcomes.includes(outcome)), 'message_contract_unavailable');
  return value;
}
export function resolveMessageRuntime(env = process.env) {
  const bound = resolveDeploymentEnvironment(env);
  const runtime = resolveUnifiedRuntime({ env: bound });
  assertRelease(path.isAbsolute(bound.AO_DATA_DIR ?? '') && path.isAbsolute(bound.AO_RUN_FILE ?? ''), 'message_namespace_unavailable');
  return { binary: runtime.binary_path, sha256: runtime.binary_sha256, env: { ...bound,
    AO_MANAGED_RUNTIME_BINARY: runtime.binary_path, AO_MANAGED_RUNTIME_BINARY_SHA256: runtime.binary_sha256,
    AO_MANAGED_RUNTIME_DATA_DIR: bound.AO_DATA_DIR, AO_MANAGED_RUNTIME_RUN_FILE: bound.AO_RUN_FILE } };
}
export function runNativeMessage(command, argv, { env = process.env, resolve = resolveMessageRuntime, run = spawnSync } = {}) {
  assertRelease(['send', 'ack'].includes(command), 'invalid_message_command');
  const runtime = resolve(env);
  const verify = () => assertRelease(fs.lstatSync(runtime.binary).isFile() && !fs.lstatSync(runtime.binary).isSymbolicLink()
    && fileSha256(runtime.binary) === runtime.sha256, 'message_binary_drift');
  verify();
  const options = { encoding: 'utf8', env: runtime.env, maxBuffer: 4 * 1024 * 1024 };
  // This read-only round trip occurs on every command. Never probe capability by
  // submitting a message to an older binary/daemon, and never cache across runs.
  const probe = run(runtime.binary, ['message-contract', '--json'], { ...options, timeout: 3000 });
  assertRelease(!probe.error && probe.status === 0, 'message_contract_unavailable');
  try { validateMessageContract(JSON.parse(probe.stdout)); } catch { assertRelease(false, 'message_contract_unavailable'); }
  verify();
  const result = run(runtime.binary, [command, ...argv], { ...options, timeout: command === 'send' ? 100000 : 20000 });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.error || result.status === null ? 1 : result.status,
    signal: result.signal ?? null };
}
