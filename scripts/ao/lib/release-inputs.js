import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertRelease, confined, fileSha256, releaseError, sha256, syncDirectory } from './release-manifest.js';

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
function assertRegistered(condition, reason) {
  if (!condition) throw Object.assign(releaseError('release_inventory_registration_mismatch'), { registration_reason: reason });
}
function entry(root, relative) {
  const absolute = confined(root, relative); let parent = root;
  // Never follow a dependency directory symlink while materializing binaries.
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    let stat;
    try { stat = fs.lstatSync(parent); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    assertRegistered(stat.isDirectory() && !stat.isSymbolicLink(), 'symlink_or_non_directory_parent');
  }
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  assertRegistered(stat.isFile() && Boolean(stat.mode & 0o111), 'not_regular_executable');
  return { absolute, stat };
}
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameInode(a, b) && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink;
function registeredFailure(error, spec) {
  error.violations = spec.paths.map((relative) => ({ path: relative, code: error.code,
    reason: error.registration_reason ?? 'registered_input_io_error', expected_type: spec.type }));
  return error;
}

export function materializeRegisteredReleaseFiles(root, { arch = process.arch } = {}) {
  root = path.resolve(root);
  assertRelease(fs.realpathSync(root) === root, 'unsafe_release_path');
  const materialized = []; const groups = []; const violations = []; let firstError;
  // Validate every registered group before modifying any of them. A failure
  // must still identify missing peers, which raw tree enumeration cannot see.
  for (const spec of registeredReleaseFiles(arch)) {
    try {
      const entries = spec.paths.map((relative) => entry(root, relative));
      if (entries.every((item) => item === null)) continue; // Optional/deduplicated install: no alias pair.
      assertRegistered(entries.every(Boolean), 'missing_registered_peer');
      if (entries.every((item) => item.stat.nlink === 1)) continue;
      const [binary, alias] = entries;
      assertRegistered(binary.stat.mode === alias.stat.mode && binary.stat.size === alias.stat.size, 'registered_mode_or_size_mismatch');
      assertRegistered(entries.every((item) => item.stat.nlink === 2), 'unaccounted_link_count');
      assertRegistered(sameInode(binary.stat, alias.stat), 'different_registered_inodes');
      groups.push({ spec, entries });
    } catch (error) {
      firstError ??= error;
      violations.push(...registeredFailure(error, spec).violations);
    }
  }
  if (firstError) { firstError.violations = violations; throw firstError; }
  for (const { spec, entries } of groups) {
    const [binary, alias] = entries;
    let fd;
    const temporary = path.join(path.dirname(alias.absolute), `.ao-release-${randomUUID()}`);
    let temporaryOwned = false;
    try {
      fd = fs.openSync(binary.absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      assertRegistered(sameFile(fs.fstatSync(fd), binary.stat), 'registered_input_changed');
      const bytes = fs.readFileSync(fd); const digest = sha256(bytes);
      const output = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryOwned = true;
      try { fs.writeFileSync(output, bytes); fs.fchmodSync(output, binary.stat.mode & 0o777); fs.fsyncSync(output); }
      finally { fs.closeSync(output); }
      assertRegistered(sameFile(fs.lstatSync(alias.absolute), alias.stat) && sameFile(fs.lstatSync(binary.absolute), binary.stat)
        && sameFile(fs.fstatSync(fd), binary.stat), 'registered_input_changed');
      fs.renameSync(temporary, alias.absolute); temporaryOwned = false; syncDirectory(path.dirname(alias.absolute));
      for (const relative of spec.paths) {
        const final = entry(root, relative);
        assertRegistered(final && final.stat.nlink === 1 && final.stat.mode === binary.stat.mode
          && final.stat.size === bytes.length && fileSha256(final.absolute) === digest, 'materialized_file_mismatch');
        materialized.push({ path: relative, type: spec.type, source_type: spec.source_type, source_nlink: 2,
          nlink: 1, mode: final.stat.mode & 0o777, size: bytes.length, sha256: digest });
      }
    } catch (error) {
      throw registeredFailure(error, spec);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (temporaryOwned) fs.rmSync(temporary, { force: true });
    }
  }
  return materialized;
}
