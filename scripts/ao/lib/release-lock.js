import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertRelease, durableJson, readJson } from './release-manifest.js';

export function processStartToken(pid = process.pid) {
  const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[19];
}
export function acquireInstallLock(root, { transactionId = randomUUID(), flock = 'flock' } = {}) {
  assertRelease(process.platform === 'linux', 'release_platform_unsupported');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  assertRelease(!fs.lstatSync(root).isSymbolicLink() && fs.realpathSync(root) === path.resolve(root), 'unsafe_install_root');
  const lockPath = path.join(root, '.install.lock');
  const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  // flock attaches to the open file description. This one explicitly inherited
  // descriptor shares the Node parent's description; all other children inherit
  // no lock FD. The permanent inode is never unlinked or reclaimed by age.
  const result = spawnSync(flock, ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
  if (result.error || result.status !== 0) { fs.closeSync(fd); throw Object.assign(new Error('Installation lock is held or unavailable'), { code: 'install_lock_busy' }); }
  const owner = {
    schema_version: 'ao.install-lock-owner.v1', uid: process.getuid(),
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    pid: process.pid, start_token: processStartToken(), nonce: randomUUID(), transaction_id: transactionId,
  };
  const ownerPath = path.join(root, '.install-owner.json');
  try { durableJson(ownerPath, owner); } catch (error) { fs.closeSync(fd); throw error; }
  let active = true;
  function assertOwned() {
    assertRelease(active, 'install_lock_lost');
    const descriptor = fs.fstatSync(fd); const named = fs.lstatSync(lockPath);
    assertRelease(!named.isSymbolicLink() && descriptor.dev === named.dev && descriptor.ino === named.ino, 'install_lock_lost');
    const current = readJson(ownerPath);
    assertRelease(current.nonce === owner.nonce && current.transaction_id === transactionId
      && current.pid === process.pid && current.start_token === processStartToken()
      && current.boot_id === owner.boot_id && current.uid === owner.uid, 'install_lock_lost');
  }
  return {
    owner, assertOwned,
    release() {
      if (!active) return;
      try { assertOwned(); } finally { active = false; fs.closeSync(fd); }
    },
  };
}
