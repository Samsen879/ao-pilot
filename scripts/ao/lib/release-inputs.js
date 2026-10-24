import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRelease, confined, fileSha256, sha256, syncDirectory } from './release-manifest.js';

// Exact install-time esbuild alias pairs, not patterns or an inventory bypass.
// The installed binary is legitimate payload; only its shared inode is removed.
const PAIRS = {
  x64: [
    ['browser/node_modules/@esbuild/linux-x64/bin/esbuild', 'browser/node_modules/esbuild/bin/esbuild'],
    ['browser/packages/web/node_modules/@esbuild/linux-x64/bin/esbuild', 'browser/packages/web/node_modules/esbuild/bin/esbuild'],
  ],
  arm64: [
    ['browser/node_modules/@esbuild/linux-arm64/bin/esbuild', 'browser/node_modules/esbuild/bin/esbuild'],
    ['browser/packages/web/node_modules/@esbuild/linux-arm64/bin/esbuild', 'browser/packages/web/node_modules/esbuild/bin/esbuild'],
  ],
};
export function registeredReleaseFiles(arch = process.arch) {
  assertRelease(Object.hasOwn(PAIRS, arch), 'release_platform_unsupported');
  return PAIRS[arch].map((paths) => ({ paths: [...paths], type: 'file', source_type: 'internal_hardlink', source_nlink: 2 }));
}
function entry(root, relative) {
  const absolute = confined(root, relative); let parent = root;
  // Never follow a dependency directory symlink while materializing binaries.
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    let stat;
    try { stat = fs.lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    assertRelease(stat.isDirectory() && !stat.isSymbolicLink(), 'release_inventory_registration_mismatch');
  }
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assertRelease(stat.isFile() && Boolean(stat.mode & 0o111), 'release_inventory_registration_mismatch');
  return { absolute, stat };
}
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink;

export function materializeRegisteredReleaseFiles(root, { arch = process.arch } = {}) {
  root = path.resolve(root);
  assertRelease(fs.realpathSync(root) === root, 'unsafe_release_path');
  const materialized = [];
  for (const spec of registeredReleaseFiles(arch)) {
    const entries = spec.paths.map((relative) => entry(root, relative));
    if (entries.every((item) => item === null)) continue; // Optional/deduplicated install: no alias pair.
    assertRelease(entries.every(Boolean), 'release_inventory_registration_mismatch');
    const [binary, alias] = entries;
    // esbuild may retain an independent JS launcher when its optimization is
    // unavailable. Ordinary single-link files still go through normal inventory.
    if (entries.every((item) => item.stat.nlink === 1)) continue;
    assertRelease(binary.stat.mode === alias.stat.mode && binary.stat.size === alias.stat.size, 'release_inventory_registration_mismatch');
    // All links to this inode must be exactly the two registered private paths.
    assertRelease(entries.every((item) => item.stat.nlink === 2) && sameInode(binary.stat, alias.stat), 'release_inventory_registration_mismatch');
    const fd = fs.openSync(binary.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const temporary = path.join(path.dirname(alias.absolute), `.ao-release-${randomUUID()}`);
    let temporaryOwned = false;
    try {
      assertRelease(sameFile(fs.fstatSync(fd), binary.stat), 'release_inventory_registration_mismatch');
      const bytes = fs.readFileSync(fd); const digest = sha256(bytes);
      const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryOwned = true;
      try { fs.writeFileSync(output, bytes); fs.fchmodSync(output, binary.stat.mode & 0o777); fs.fsyncSync(output); }
      finally { fs.closeSync(output); }
      assertRelease(sameFile(fs.lstatSync(alias.absolute), alias.stat) && sameFile(fs.lstatSync(binary.absolute), binary.stat)
        && sameFile(fs.fstatSync(fd), binary.stat), 'release_inventory_registration_mismatch');
      fs.renameSync(temporary, alias.absolute); temporaryOwned = false; syncDirectory(path.dirname(alias.absolute));
      for (const relative of spec.paths) {
        const final = entry(root, relative);
        assertRelease(final && final.stat.nlink === 1 && final.stat.mode === binary.stat.mode
          && final.stat.size === bytes.length && fileSha256(final.absolute) === digest, 'release_inventory_registration_mismatch');
        materialized.push({ path: relative, type: spec.type, source_type: spec.source_type, source_nlink: 2,
          nlink: 1, mode: final.stat.mode & 0o777, size: bytes.length, sha256: digest });
      }
    } finally {
      fs.closeSync(fd);
      if (temporaryOwned) fs.rmSync(temporary, { force: true });
    }
  }
  return materialized;
}
