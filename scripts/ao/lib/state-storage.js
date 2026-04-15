import * as fs from 'node:fs';
import path from 'node:path';

const syncSleepState = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_STALE_LOCK_AGE_MS = 30 * 1000;

export function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}

export async function sleep(waitMs) {
  const durationMs = Number(waitMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  await new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

export function sleepSync(waitMs) {
  const durationMs = Number(waitMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;

  if (typeof Atomics?.wait === 'function') {
    Atomics.wait(syncSleepState, 0, 0, durationMs);
    return;
  }

  const deadlineMs = Date.now() + durationMs;
  while (Date.now() < deadlineMs) {
    // Busy-wait to keep synchronous repository callers serialized under the same lock.
  }
}

export function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFileAtomic(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function isProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function normalizeProcessStartToken(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function readLinuxProcessStartToken(pid) {
  try {
    const statText = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const suffixStart = statText.lastIndexOf(') ');
    if (suffixStart < 0) return null;
    const suffixFields = statText.slice(suffixStart + 2).split(' ');
    const startToken = suffixFields[19] ?? null;
    return typeof startToken === 'string' && startToken.trim() !== ''
      ? startToken.trim()
      : null;
  } catch {
    return null;
  }
}

export function readLiveProcessIdentity(pid = process.pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return null;
  }
  if (!isProcessAlive(normalizedPid)) {
    return null;
  }

  return {
    process_pid: normalizedPid,
    process_start_token: readLinuxProcessStartToken(normalizedPid),
  };
}

export function buildCurrentProcessMetadata({
  pid = process.pid,
  startedAt = new Date().toISOString(),
} = {}) {
  const liveIdentity = readLiveProcessIdentity(pid);
  return {
    process_pid: Number(pid),
    process_started_at: startedAt,
    process_start_token: liveIdentity?.process_start_token ?? null,
  };
}

export function matchesRecordedProcessIdentity(metadata = {}) {
  const normalizedPid = Number(metadata?.process_pid ?? metadata?.pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  const liveIdentity = readLiveProcessIdentity(normalizedPid);
  if (!liveIdentity) {
    return false;
  }

  const recordedStartToken = normalizeProcessStartToken(metadata?.process_start_token);
  const liveStartToken = normalizeProcessStartToken(liveIdentity.process_start_token);

  if (recordedStartToken != null) {
    if (liveStartToken == null) {
      return false;
    }
    return recordedStartToken === liveStartToken;
  }

  return true;
}

function createLockFileMetadata({
  pid = process.pid,
  acquiredAt = new Date().toISOString(),
} = {}) {
  return {
    pid: Number(pid),
    acquired_at: acquiredAt,
    ...buildCurrentProcessMetadata({
      pid,
      startedAt: acquiredAt,
    }),
  };
}

function writeLockDescriptor(lockDescriptor, metadata = createLockFileMetadata()) {
  fs.writeFileSync(
    lockDescriptor,
    `${JSON.stringify(metadata)}\n`,
    'utf8',
  );
}

function sameFileIdentity(left, right) {
  if (!left || !right) return false;

  const leftInodeKnown = Number.isInteger(left.ino) && left.ino > 0;
  const rightInodeKnown = Number.isInteger(right.ino) && right.ino > 0;
  if (leftInodeKnown && rightInodeKnown) {
    return left.dev === right.dev && left.ino === right.ino;
  }

  return left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function sameLockSnapshot(left, right) {
  if (!left || !right) return false;
  return sameFileIdentity(left.stats, right.stats)
    && left.stats.size === right.stats.size
    && left.stats.mtimeMs === right.stats.mtimeMs
    && left.stats.ctimeMs === right.stats.ctimeMs;
}

function readLockMetadata(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const rawText = fs.readFileSync(filePath, 'utf8').trim();
    if (rawText === '') return null;
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function readLockSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return null;

  try {
    return {
      metadata: readLockMetadata(filePath),
      stats: fs.statSync(filePath),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function resolveLockSnapshotAgeMs(snapshot, nowMs = Date.now()) {
  if (!snapshot) return 0;
  const acquiredAtMs = new Date(snapshot.metadata?.acquired_at ?? '').getTime();
  const referenceMs = Number.isFinite(acquiredAtMs)
    ? acquiredAtMs
    : snapshot.stats.mtimeMs;
  return Math.max(0, nowMs - referenceMs);
}

function shouldRecoverStaleLockSnapshot(snapshot, staleLockAgeMs, nowMs = Date.now()) {
  if (!snapshot) return false;

  const metadata = snapshot.metadata ?? {};
  const recordedPid = Number(metadata?.pid ?? metadata?.process_pid);
  if (Number.isInteger(recordedPid) && recordedPid > 0) {
    const liveIdentity = readLiveProcessIdentity(recordedPid);
    if (!liveIdentity) {
      return true;
    }

    const recordedStartToken = normalizeProcessStartToken(metadata?.process_start_token);
    if (recordedStartToken != null && liveIdentity.process_start_token != null) {
      return recordedStartToken !== liveIdentity.process_start_token;
    }
  }

  return resolveLockSnapshotAgeMs(snapshot, nowMs) >= staleLockAgeMs;
}

function releaseLockDescriptor(lockDescriptor, filePath) {
  if (lockDescriptor == null) return;

  try {
    try {
      const descriptorStats = fs.fstatSync(lockDescriptor);
      const currentStats = fs.statSync(filePath);
      if (sameFileIdentity(descriptorStats, currentStats)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  } finally {
    fs.closeSync(lockDescriptor);
  }
}

function tryRecoverClaimFileSync(filePath, staleLockAgeMs) {
  const snapshot = readLockSnapshot(filePath);
  if (!shouldRecoverStaleLockSnapshot(snapshot, staleLockAgeMs)) {
    return false;
  }

  const currentSnapshot = readLockSnapshot(filePath);
  if (!sameLockSnapshot(snapshot, currentSnapshot)) {
    return false;
  }

  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function acquireRecoveryDescriptor(
  recoveryPath,
  {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
  } = {},
) {
  const startedAtMs = Date.now();
  let recoveryDescriptor = null;

  while (recoveryDescriptor == null) {
    try {
      recoveryDescriptor = fs.openSync(recoveryPath, 'wx');
      writeLockDescriptor(recoveryDescriptor);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (tryRecoverClaimFileSync(recoveryPath, staleLockAgeMs)) {
        continue;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        return null;
      }
      await sleepFn(retryMs);
    }
  }

  return recoveryDescriptor;
}

function acquireRecoveryDescriptorSync(
  recoveryPath,
  {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
  } = {},
) {
  const startedAtMs = Date.now();
  let recoveryDescriptor = null;

  while (recoveryDescriptor == null) {
    try {
      recoveryDescriptor = fs.openSync(recoveryPath, 'wx');
      writeLockDescriptor(recoveryDescriptor);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (tryRecoverClaimFileSync(recoveryPath, staleLockAgeMs)) {
        continue;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        return null;
      }
      sleepFn(retryMs);
    }
  }

  return recoveryDescriptor;
}

function tryRecoverStaleLockWithClaimSync(
  filePath,
  {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
    beforeStaleLockUnlink = null,
  } = {},
) {
  const recoveryPath = `${filePath}.recover`;
  const recoveryDescriptor = acquireRecoveryDescriptorSync(recoveryPath, {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
  });
  if (recoveryDescriptor == null) {
    return false;
  }

  try {
    const initialSnapshot = readLockSnapshot(filePath);
    if (!shouldRecoverStaleLockSnapshot(initialSnapshot, staleLockAgeMs)) {
      return false;
    }

    beforeStaleLockUnlink?.({
      filePath,
      snapshot: initialSnapshot,
    });
    const currentSnapshot = readLockSnapshot(filePath);
    if (!sameLockSnapshot(initialSnapshot, currentSnapshot)) {
      return false;
    }

    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  } finally {
    releaseLockDescriptor(recoveryDescriptor, recoveryPath);
  }
}

async function tryRecoverStaleLockWithClaim(
  filePath,
  {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
    beforeStaleLockUnlink = null,
  } = {},
) {
  const recoveryPath = `${filePath}.recover`;
  const recoveryDescriptor = await acquireRecoveryDescriptor(recoveryPath, {
    timeoutMs,
    retryMs,
    sleepFn,
    staleLockAgeMs,
  });
  if (recoveryDescriptor == null) {
    return false;
  }

  try {
    const initialSnapshot = readLockSnapshot(filePath);
    if (!shouldRecoverStaleLockSnapshot(initialSnapshot, staleLockAgeMs)) {
      return false;
    }

    beforeStaleLockUnlink?.({
      filePath,
      snapshot: initialSnapshot,
    });
    const currentSnapshot = readLockSnapshot(filePath);
    if (!sameLockSnapshot(initialSnapshot, currentSnapshot)) {
      return false;
    }

    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  } finally {
    releaseLockDescriptor(recoveryDescriptor, recoveryPath);
  }
}
export async function withFileLock(
  filePath,
  callback,
  {
    timeoutMs = 1000,
    retryMs = 10,
    sleepFn = sleep,
    staleLockAgeMs = DEFAULT_STALE_LOCK_AGE_MS,
    beforeStaleLockUnlink = null,
  } = {},
) {
  ensureDirectory(path.dirname(filePath));
  const startedAtMs = Date.now();
  let lockDescriptor = null;

  while (lockDescriptor == null) {
    try {
      lockDescriptor = fs.openSync(filePath, 'wx');
      writeLockDescriptor(lockDescriptor);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (await tryRecoverStaleLockWithClaim(filePath, {
        timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAtMs)),
        retryMs,
        sleepFn,
        staleLockAgeMs,
        beforeStaleLockUnlink,
      })) {
        continue;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        throw new Error(`Timed out acquiring file lock ${path.basename(filePath)}`);
      }
      await sleepFn(retryMs);
    }
  }

  try {
    return await callback();
  } finally {
    releaseLockDescriptor(lockDescriptor, filePath);
  }
}

export function withFileLockSync(
  filePath,
  callback,
  {
    timeoutMs = 1000,
    retryMs = 10,
    sleepFn = sleepSync,
    staleLockAgeMs = DEFAULT_STALE_LOCK_AGE_MS,
    beforeStaleLockUnlink = null,
  } = {},
) {
  ensureDirectory(path.dirname(filePath));
  const startedAtMs = Date.now();
  let lockDescriptor = null;

  while (lockDescriptor == null) {
    try {
      lockDescriptor = fs.openSync(filePath, 'wx');
      writeLockDescriptor(lockDescriptor);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
      if (tryRecoverStaleLockWithClaimSync(filePath, {
        timeoutMs: Math.max(0, timeoutMs - (Date.now() - startedAtMs)),
        retryMs,
        sleepFn,
        staleLockAgeMs,
        beforeStaleLockUnlink,
      })) {
        continue;
      }
      if (Date.now() - startedAtMs >= timeoutMs) {
        throw new Error(`Timed out acquiring file lock ${path.basename(filePath)}`);
      }
      sleepFn(retryMs);
    }
  }

  try {
    return callback();
  } finally {
    releaseLockDescriptor(lockDescriptor, filePath);
  }
}

export function appendJsonLine(filePath, payload) {
  ensureDirectory(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (text === '') return [];

  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
