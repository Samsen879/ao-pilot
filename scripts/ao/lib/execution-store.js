import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { authorityDigest, canonicalAuthorityJson } from './owner-authority-ledger.js';
function hold(message) {
  throw new Error(`${message}; HOLD`);
}
export function privateDirectory(directory, create = false) {
  if (!path.isAbsolute(directory)) hold('Execution store must be absolute');
  const ancestors = [];
  for (let current = path.resolve(directory);; current = path.dirname(current)) {
    ancestors.unshift(current);
    if (path.dirname(current) === current) break;
  }
  for (const current of ancestors) {
    try {
      const info = fs.lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink()) hold('Execution store symlink/non-directory');
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      fs.mkdirSync(current, {
        mode: 0o700
      });
    }
  }
  const info = fs.statSync(directory);
  if (info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) hold('Execution store must be private and owned');
}
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
export function readPrivate(file, json = true) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || process.getuid && info.uid !== process.getuid()) hold('Untrusted execution file custody');
    if (json && info.size > 2 * 1024 * 1024) hold('Execution record size limit');
    const bytes = fs.readFileSync(fd);
    return json ? JSON.parse(bytes.toString('utf8')) : bytes;
  } finally {
    fs.closeSync(fd);
  }
}
export function savePrivate(file, value, exclusive = false) {
  const temp = exclusive ? file : file + '.' + crypto.randomUUID();
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, canonicalAuthorityJson(value) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!exclusive) fs.renameSync(temp, file);
  syncDirectory(path.dirname(file));
}
export function createExecutionStore(directory) {
  function recordDirectory(invocationId) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(invocationId)) hold('Invalid invocation ID');
    return path.join(directory, 'invocations', invocationId);
  }
  return {
    directory,
    recordDirectory,
    async withLock(action) {
      privateDirectory(directory, true);
      const lock = path.join(directory, '.mutation-lock');
      try {
        fs.mkdirSync(lock, {
          mode: 0o700
        });
      } catch (error) {
        if (error.code === 'EEXIST') hold('Execution mutation active or interrupted');
        throw error;
      }
      const token = crypto.randomUUID();
      savePrivate(path.join(lock, 'owner.json'), {
        token,
        pid: process.pid
      }, true);
      syncDirectory(directory);
      try {
        return await action();
      } finally {
        if (readPrivate(path.join(lock, 'owner.json')).token !== token) hold('Execution lock ownership changed');
        fs.unlinkSync(path.join(lock, 'owner.json'));
        fs.rmdirSync(lock);
        syncDirectory(directory);
      }
    },
    read(invocationId) {
      privateDirectory(directory);
      const dir = recordDirectory(invocationId);
      privateDirectory(dir);
      const envelope = readPrivate(path.join(dir, 'record.json'));
      if (envelope.record_sha256 !== authorityDigest(envelope.record) || envelope.record.invocation_id !== invocationId || envelope.record.schema_version !== 'ao.execution-record.v1') hold('Execution record identity/digest mismatch');
      return envelope.record;
    },
    save(record, exclusive = false) {
      const dir = recordDirectory(record.invocation_id);
      privateDirectory(dir, true);
      savePrivate(path.join(dir, 'record.json'), {
        record,
        record_sha256: authorityDigest(record)
      }, exclusive);
    },
    laneFile(scope) {
      const key = authorityDigest({
        repository: scope.repository,
        project_id: scope.project_id,
        session_id: scope.session_id,
        generation: scope.generation
      });
      const dir = path.join(directory, 'lanes', key);
      privateDirectory(dir, true);
      return path.join(dir, 'owner.json');
    }
  };
}
