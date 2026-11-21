import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
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
function prepareNativeMessage(command, argv, { env = process.env, resolve = resolveMessageRuntime, run = spawnSync } = {}) {
  assertRelease(['send', 'ack', 'message'].includes(command), 'invalid_message_command');
  if (command === 'message') assertRelease(['show', 'watch', 'checkpoint'].includes(argv[0]), 'invalid_message_command');
  const runtime = resolve(env);
  const verify = () => assertRelease(fs.lstatSync(runtime.binary).isFile() && !fs.lstatSync(runtime.binary).isSymbolicLink()
    && fileSha256(runtime.binary) === runtime.sha256, 'message_binary_drift');
  verify();
  const options = { encoding: 'utf8', env: runtime.env, maxBuffer: 4 * 1024 * 1024 };
  // This read-only round trip occurs on every command. Never probe capability by
  // submitting a message to an older binary/daemon, and never cache across runs.
  const probe = run(runtime.binary, ['message-contract', '--json'], { ...options, timeout: 3000 });
  assertRelease(!probe.error && probe.status === 0, 'message_contract_unavailable');
  let contract;
  try { contract = validateMessageContract(JSON.parse(probe.stdout)); } catch { assertRelease(false, 'message_contract_unavailable'); }
  if (command === 'message') assertRelease(contract.read_status === true && contract.status_schema_version === 'ao.message-status.v1', 'message_status_unavailable');
  if (command === 'message' && argv[0] === 'checkpoint') assertRelease(contract.task_checkpoints === true, 'task_checkpoint_unavailable');
  verify();
  return { runtime, options };
}

export function runNativeMessage(command, argv, dependencies = {}) {
  const { runtime, options } = prepareNativeMessage(command, argv, dependencies);
  const run = dependencies.run ?? spawnSync;
  // Native watch is bounded to 15m; leave room for its capability probe and exit.
  const timeout = command === 'message' && argv[0] === 'watch' ? 920000 : command === 'send' ? 100000 : 20000;
  const result = run(runtime.binary, [command, ...argv], { ...options, timeout });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.error || result.status === null ? 1 : result.status,
    signal: result.signal ?? null };
}

// Watching must deliver each snapshot while the child is still running. The
// short send/ack/show commands retain their existing synchronous proxy path.
export async function runNativeMessageWatch(argv, io, dependencies = {}) {
  assertRelease(argv[0] === 'watch', 'invalid_message_command');
  const { runtime, options } = prepareNativeMessage('message', argv, dependencies);
  const launch = dependencies.spawnProcess ?? spawn;
  const child = launch(runtime.binary, ['message', ...argv], {
    env: options.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 920000,
  });
  return new Promise((resolve) => {
    let failed = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => io.writeStdout(text));
    child.stderr.on('data', (text) => io.writeStderr(text));
    child.once('error', (error) => { failed = true; io.writeStderr(`${error.code ?? 'native_message_watch_failed'}\n`); });
    child.once('close', (code, signal) => resolve({ exitCode: failed || code === null || signal ? 1 : code }));
  });
}
