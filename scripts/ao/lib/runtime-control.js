import * as fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  getDefaultRuntimeStore,
  verifyRuntimeBootstrapReceipt,
} from './runtime-bootstrap.js';
import { loadBootstrapToolchainLock } from './runtime-bootstrap-contract.js';
import { computeRuntimeLockDigest, loadRuntimeLock } from './runtime-lock.js';
import { resolveDeploymentEnvironment } from './runtime-deployment.js';
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
  env = resolveDeploymentEnvironment(env);
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
    return parsed?.state === 'ready' || parsed?.ready === 'ready' || parsed?.ready === true;
  } catch {
    return false;
  }
}

function daemonStarting(result) {
  if (result?.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return parsed?.state === 'not_ready' && parsed?.health === 'ok' && Number.isInteger(parsed?.pid);
  } catch {
    return false;
  }
}

function daemonConfirmedGone(result) {
  if (result?.status !== 0) return false;
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return parsed?.state === 'stopped'
      || (parsed?.state === 'stale' && parsed?.error === 'run-file points to a dead process');
  } catch {
    return false;
  }
}

function daemonPid(result) {
  if (result?.status !== 0) return null;
  try {
    const pid = JSON.parse(result.stdout || '{}')?.pid;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM also means a process still occupies this PID.
    return error?.code !== 'ESRCH';
  }
}

// PID reuse makes a live PID in running.json insufficient evidence of AO
// ownership. Return null when the operating system cannot establish identity.
function daemonPidMatchesBinary(pid, binaryPath) {
  try {
    let executable;
    if (process.platform === 'win32') {
      const result = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).Path`,
      ], { encoding: 'utf8', timeout: 2_000, windowsHide: true });
      if (result.status !== 0) return null;
      executable = String(result.stdout || '').trim();
    } else if (process.platform === 'linux') {
      executable = fs.readlinkSync(`/proc/${pid}/exe`);
    } else {
      return null;
    }
    if (!executable) return null;
    return path.normalize(executable).toLowerCase() === path.normalize(fs.realpathSync(binaryPath)).toLowerCase();
  } catch {
    return null;
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
  timeoutMs = 5 * 60_000,
  pollIntervalMs = 250,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  isProcessAlive = processAlive,
  isDaemonPid = daemonPidMatchesBinary,
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

  let existingPid = daemonPid(before);
  const initialIdentity = daemonStarting(before) ? true
    : existingPid !== null && isProcessAlive(existingPid)
      ? isDaemonPid(existingPid, runtime.binary_path) : false;
  // A healthy probe or matching executable proves ownership. For an
  // inconclusive identity, wait briefly for an owned health response; do not
  // let a recycled foreign PID block startup for the full recovery deadline.
  let existingDaemon = daemonStarting(before)
    || initialIdentity !== false;
  let unverifiedPidUntil = existingDaemon && !daemonStarting(before)
    ? now() + Math.min(10_000, Math.max(0, deadline - now())) : null;
  let spawned = false;
  let spawnedObserved = false;

  let spawnError = null;
  let childExited = false;
  let childExitCode = null;
  let childExitSignal = null;
  let child;
  const spawnDaemon = () => {
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
    spawned = true;
    spawnedObserved = false;
    childExited = false;
    spawnError = null;
    child.once?.('error', (error) => { spawnError = error; });
    child.once?.('exit', (code, signal) => {
      childExited = true;
      childExitCode = code;
      childExitSignal = signal;
    });
    child.unref?.();
    return null;
  };
  if (!existingDaemon) {
    const failure = spawnDaemon();
    if (failure) return failure;
  }

  let lastProbe = before;
  let pollDelayMs = pollIntervalMs;
  while (now() < deadline) {
    await delay(Math.min(pollDelayMs, Math.max(0, deadline - now())));
    if (spawnError) {
      return {
        status: 'failed',
        exit_code: 2,
        error: spawnError.message,
      };
    }
    // One final bounded probe is still useful at the deadline: recovery may
    // have completed during the last backoff interval.
    lastProbe = probe();
    if (spawned && daemonStarting(lastProbe)
      && (child?.pid == null || daemonPid(lastProbe) === child.pid)) {
      spawnedObserved = true;
    }
    if (daemonReady(lastProbe)) {
      return {
        status: spawned ? 'started' : 'already_running',
        exit_code: 0,
        daemon_status: JSON.parse(lastProbe.stdout),
      };
    }
    if (existingDaemon && daemonStarting(lastProbe)) {
      unverifiedPidUntil = null;
      existingPid = daemonPid(lastProbe);
    }
    if (unverifiedPidUntil !== null && existingPid !== null && isProcessAlive(existingPid)) {
      const identity = isDaemonPid(existingPid, runtime.binary_path);
      if (identity === false) {
        existingDaemon = false;
        unverifiedPidUntil = null;
        const failure = spawnDaemon();
        if (failure) return failure;
      }
    }
    if (existingDaemon && daemonConfirmedGone(lastProbe)
      && (existingPid === null || !isProcessAlive(existingPid))) {
      existingDaemon = false;
      unverifiedPidUntil = null;
      const failure = spawnDaemon();
      if (failure) return failure;
    } else if (spawned && childExited) {
      if (daemonStarting(lastProbe)) {
        // Another owner won the restart race; wait for that daemon.
        existingDaemon = true;
        existingPid = daemonPid(lastProbe);
        spawned = false;
      } else {
        return {
          status: 'failed', exit_code: 2,
          error: `verified runtime daemon exited before readiness (${childExitCode == null ? `signal ${childExitSignal ?? 'unknown'}` : `exit ${childExitCode}`})`,
        };
      }
    }
    if (unverifiedPidUntil !== null && now() >= unverifiedPidUntil) {
      return {
        status: 'failed', exit_code: 2,
        error: `recorded PID ${existingPid} is live but daemon ownership could not be verified`,
      };
    }
    pollDelayMs = Math.min(5_000, pollDelayMs * 2);
  }

  if (spawned && !childExited && !spawnedObserved) {
    // This invocation's detached child never published a run file or a
    // healthy recovery probe. Wait for the child to exit before allowing a
    // retry; SIGTERM alone does not release SQLite or its listener.
    child.kill?.('SIGTERM');
    const gone = () => childExited || (child?.pid != null && !isProcessAlive(child.pid));
    for (let i = 0; i < 10 && !gone(); i += 1) await delay(200);
    if (!gone()) {
      child.kill?.('SIGKILL');
      for (let i = 0; i < 5 && !gone(); i += 1) await delay(200);
    }
    if (!gone()) {
      return {
        status: 'failed', exit_code: 2,
        error: `unobservable daemon child ${child?.pid ?? 'unknown'} did not exit after termination`,
      };
    }
  }
  return {
    status: 'failed',
    exit_code: 2,
    error: 'verified runtime daemon did not become ready before timeout',
    last_status_exit_code: Number.isInteger(lastProbe?.status) ? lastProbe.status : null,
  };
}
