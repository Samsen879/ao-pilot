import * as fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  getDefaultRuntimeStore,
  verifyRuntimeBootstrapReceipt,
} from './runtime-bootstrap.js';
import { loadBootstrapToolchainLock } from './runtime-bootstrap-contract.js';
import { computeRuntimeLockDigest, loadRuntimeLock } from './runtime-lock.js';
import { resolveManagedRuntime } from './runtime-resolver.js';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
const DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS = 15_000;

function normalizeStoreRoot(value, env) {
  const configured = value ?? env.AO_PILOT_RUNTIME_STORE;
  if (configured == null || String(configured).trim() === '') {
    return getDefaultRuntimeStore({ env });
  }
  return path.resolve(String(configured).trim());
}

function sanitizeResolution(resolution) {
  return {
    runtime_ref: resolution.runtime_ref,
    lock_digest: resolution.lock_digest,
    runtime_directory: resolution.runtime_directory,
    provenance_path: resolution.provenance_path,
    bootstrap_receipt_path: resolution.bootstrap_receipt_path,
    binary_path: resolution.binary_path,
    binary_sha256: resolution.binary_sha256,
    source: resolution.source,
    compatibility: resolution.compatibility,
    path_candidate: resolution.path_candidate,
  };
}

export function resolveRuntimeControl({
  env = process.env,
  cwd = process.cwd(),
  storeRoot = null,
  platform = process.platform,
  arch = process.arch,
  aoPilotVersion = PACKAGE_VERSION,
  runtimeLock = loadRuntimeLock().lock,
  toolchainLock = loadBootstrapToolchainLock().lock,
} = {}) {
  const effectiveStore = normalizeStoreRoot(storeRoot, env);
  const resolution = resolveManagedRuntime({
    lock: runtimeLock,
    storeRoot: effectiveStore,
    aoPilotVersion,
    platform,
    arch,
    env,
    cwd,
  });
  const receipt = verifyRuntimeBootstrapReceipt({
    runtimeDirectory: resolution.runtime_directory,
    runtimeLock,
    toolchainLock,
    platform,
    arch,
  });
  return {
    ...resolution,
    store_root: effectiveStore,
    bootstrap_receipt_path: receipt.path,
  };
}

function probeAuthentication(command, args, {
  env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(command, args, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  const available = result.error?.code !== 'ENOENT';
  return {
    command,
    available,
    authenticated: available && result.status === 0,
    probe_exit_code: Number.isInteger(result.status) ? result.status : null,
  };
}

export function inspectRuntimeControl({
  env = process.env,
  cwd = process.cwd(),
  storeRoot = null,
  platform = process.platform,
  arch = process.arch,
  aoPilotVersion = PACKAGE_VERSION,
  runtimeLock = null,
  toolchainLock = null,
  spawn = spawnSync,
} = {}) {
  const effectiveStore = normalizeStoreRoot(storeRoot, env);
  let runtime;
  let effectiveRuntimeLock = runtimeLock;
  let effectiveToolchainLock = toolchainLock;
  try {
    effectiveRuntimeLock ??= loadRuntimeLock().lock;
    effectiveToolchainLock ??= loadBootstrapToolchainLock().lock;
    const resolution = resolveRuntimeControl({
      env,
      cwd,
      storeRoot: effectiveStore,
      platform,
      arch,
      aoPilotVersion,
      runtimeLock: effectiveRuntimeLock,
      toolchainLock: effectiveToolchainLock,
    });
    runtime = {
      status: 'verified',
      code: null,
      message: null,
      store_root: effectiveStore,
      ...sanitizeResolution(resolution),
    };
  } catch (error) {
    runtime = {
      status: 'blocked',
      code: error.code ?? (effectiveRuntimeLock == null ? 'runtime_lock_invalid' : 'runtime_verification_failed'),
      message: error.message,
      store_root: effectiveStore,
      runtime_ref: effectiveRuntimeLock?.runtime_ref ?? null,
      lock_digest: effectiveRuntimeLock == null ? null : computeRuntimeLockDigest(effectiveRuntimeLock),
      runtime_directory: error.details?.runtime_directory ?? null,
      provenance_path: null,
      bootstrap_receipt_path: null,
      binary_path: error.details?.binary_path ?? null,
      binary_sha256: null,
      source: effectiveRuntimeLock == null ? null : {
        repository: effectiveRuntimeLock.artifact.repository,
        version: effectiveRuntimeLock.artifact.version,
        tag: effectiveRuntimeLock.artifact.ref.name,
        tag_object_sha: effectiveRuntimeLock.artifact.ref.tag_object_sha,
        commit_sha: effectiveRuntimeLock.artifact.ref.commit_sha,
        tree_sha: effectiveRuntimeLock.artifact.ref.tree_sha,
        integrity: effectiveRuntimeLock.artifact.integrity,
      },
      compatibility: effectiveRuntimeLock?.compatibility ?? null,
      path_candidate: error.details?.path_candidate ?? null,
    };
  }
  return {
    schema_version: 'ao.runtime-doctor.v1',
    status: runtime.status,
    runtime,
    authentication: {
      github: probeAuthentication('gh', ['auth', 'status'], { env, spawn }),
      codex: probeAuthentication('codex', ['login', 'status'], { env, spawn }),
    },
  };
}

export function runVerifiedRuntime(args, {
  env = process.env,
  cwd = process.cwd(),
  storeRoot = null,
  stdio = 'inherit',
  spawn = spawnSync,
  timeoutMs = DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
} = {}) {
  const runtime = resolveRuntimeControl({ env, cwd, storeRoot });
  return runResolvedRuntime(runtime, args, {
    env, cwd, stdio, spawn, timeoutMs,
  });
}

export function runResolvedRuntime(runtime, args, {
  env = process.env,
  cwd = process.cwd(),
  stdio = 'inherit',
  spawn = spawnSync,
  timeoutMs = DEFAULT_RUNTIME_COMMAND_TIMEOUT_MS,
} = {}) {
  const result = spawn(runtime.binary_path, args.map(String), {
    cwd,
    env,
    encoding: stdio === 'inherit' ? undefined : 'utf8',
    stdio,
    timeout: timeoutMs,
  });
  return {
    runtime,
    result: {
      status: Number.isInteger(result.status) ? result.status : null,
      signal: result.signal ?? null,
      stdout: result.stdout == null ? '' : String(result.stdout),
      stderr: result.stderr == null ? '' : String(result.stderr),
      error: result.error?.message ?? null,
      error_code: result.error?.code ?? null,
    },
  };
}

function daemonReady(result) {
  if (result?.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return parsed?.state === 'ready' || parsed?.ready === 'ready' || parsed?.health === 'ok';
  } catch {
    return false;
  }
}

function statusProbe(runtime, {
  cwd,
  env,
  syncSpawn,
  timeoutMs,
}) {
  return syncSpawn(runtime.binary_path, ['status', '--json'], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
  });
}

export async function startVerifiedRuntimeDaemon(runtime, {
  cwd = process.cwd(),
  env = process.env,
  childSpawn = spawn,
  syncSpawn = spawnSync,
  timeoutMs = 10_000,
  pollIntervalMs = 100,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  const probe = () => statusProbe(runtime, {
    cwd,
    env,
    syncSpawn,
    timeoutMs: Math.max(1, deadline - now()),
  });
  const before = probe();
  if (daemonReady(before)) {
    return {
      status: 'already_running',
      exit_code: 0,
      daemon_status: JSON.parse(before.stdout),
    };
  }
  if (now() >= deadline) {
    return {
      status: 'failed',
      exit_code: 2,
      error: 'verified runtime status probe exceeded the startup timeout',
      last_status_exit_code: Number.isInteger(before?.status) ? before.status : null,
    };
  }

  let spawnError = null;
  let childExited = false;
  let childExitCode = null;
  let childExitSignal = null;
  let child;
  try {
    child = childSpawn(runtime.binary_path, ['daemon'], {
      cwd,
      env,
      detached: true,
      stdio: 'ignore',
    });
  } catch (error) {
    return {
      status: 'failed',
      exit_code: 2,
      error: error.message,
    };
  }
  child.once?.('error', (error) => { spawnError = error; });
  child.once?.('exit', (code, signal) => {
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
  });
  child.unref?.();

  let lastProbe = before;
  while (now() < deadline) {
    await delay(pollIntervalMs);
    if (spawnError) {
      return {
        status: 'failed',
        exit_code: 2,
        error: spawnError.message,
      };
    }
    if (childExited) {
      return {
        status: 'failed',
        exit_code: 2,
        error: `verified runtime daemon exited before readiness (${childExitCode == null ? `signal ${childExitSignal ?? 'unknown'}` : `exit ${childExitCode}`})`,
      };
    }
    if (now() >= deadline) break;
    lastProbe = probe();
    if (daemonReady(lastProbe)) {
      return {
        status: 'started',
        exit_code: 0,
        daemon_status: JSON.parse(lastProbe.stdout),
      };
    }
  }

  child.kill?.('SIGTERM');
  return {
    status: 'failed',
    exit_code: 2,
    error: 'verified runtime daemon did not become ready before timeout',
    last_status_exit_code: Number.isInteger(lastProbe?.status) ? lastProbe.status : null,
  };
}
