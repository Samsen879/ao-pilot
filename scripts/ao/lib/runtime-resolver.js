import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { computeRuntimeLockDigest, normalizeRuntimeLock } from './runtime-lock.js';
import {
  normalizeRuntimeProvenance,
  RUNTIME_PROVENANCE_FILENAME,
} from './runtime-provenance.js';

export class RuntimeResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeResolutionError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new RuntimeResolutionError(code, message, details);
}

function parseVersion(value, fieldName) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(String(value));
  if (!match) fail('runtime_compatibility_invalid', `Invalid ${fieldName}`, { value });
  const prerelease = match[4] == null ? null : match[4].split('.').map((identifier) => {
    if (/^\d+$/.test(identifier)) {
      if (identifier.length > 1 && identifier.startsWith('0')) {
        fail('runtime_compatibility_invalid', `Invalid ${fieldName}`, { value });
      }
      return Number(identifier);
    }
    return identifier;
  });
  return {
    core: match.slice(1, 4).map(Number),
    prerelease,
  };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease == null && right.prerelease == null) return 0;
  if (left.prerelease == null) return 1;
  if (right.prerelease == null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier == null) return -1;
    if (rightIdentifier == null) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    if (typeof leftIdentifier === 'number' && typeof rightIdentifier === 'string') return -1;
    if (typeof leftIdentifier === 'string' && typeof rightIdentifier === 'number') return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

function assertCompatibility(lock, { platform, arch, aoPilotVersion }) {
  const supportedPlatform = lock.compatibility.platforms.some((item) => (
    item.os === platform && item.arch === arch
  ));
  if (!supportedPlatform) {
    fail('runtime_platform_incompatible', 'Runtime is incompatible with this platform', {
      platform,
      arch,
    });
  }
  const observed = parseVersion(aoPilotVersion, 'ao-pilot version');
  const minimum = parseVersion(
    lock.compatibility.ao_pilot.minimum_version,
    'minimum ao-pilot version',
  );
  const maximum = parseVersion(
    lock.compatibility.ao_pilot.maximum_exclusive_version,
    'maximum ao-pilot version',
  );
  if (compareVersions(observed, minimum) < 0 || compareVersions(observed, maximum) >= 0) {
    fail('runtime_version_incompatible', 'Runtime is incompatible with this ao-pilot version', {
      ao_pilot_version: aoPilotVersion,
      minimum_version: lock.compatibility.ao_pilot.minimum_version,
      maximum_exclusive_version: lock.compatibility.ao_pilot.maximum_exclusive_version,
    });
  }
}

function readJson(filePath, code) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(code, `Unable to read ${filePath}: ${error.message}`, { path: filePath });
  }
  return parsed;
}

function fileSha256(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function getTargetContract(lock, platform, arch) {
  const target = lock.compatibility.platforms.find((item) => (
    item.os === platform && item.arch === arch
  ));
  if (!target) {
    fail('runtime_platform_incompatible', 'Runtime is incompatible with this platform', {
      platform,
      arch,
    });
  }
  return target;
}

function assertProvenance(lock, provenance, { platform, arch }) {
  const target = getTargetContract(lock, platform, arch);
  const expectedDigest = computeRuntimeLockDigest(lock);
  if (provenance.runtime_ref !== lock.runtime_ref) {
    fail('runtime_ref_mismatch', 'Runtime provenance ref does not match the lock');
  }
  if (provenance.lock_digest !== expectedDigest) {
    fail('runtime_lock_digest_mismatch', 'Runtime provenance lock digest is stale or wrong');
  }
  if (provenance.artifact.repository !== lock.artifact.repository) {
    fail('runtime_source_unknown', 'Runtime provenance repository is not the locked source');
  }
  if (provenance.artifact.version !== lock.artifact.version) {
    fail('runtime_version_mismatch', 'Runtime provenance version does not match the lock');
  }
  if (provenance.artifact.ref?.kind !== 'annotated_tag') {
    fail('runtime_mutable_ref', 'Runtime provenance is not anchored to an annotated tag');
  }
  if (provenance.artifact.ref?.name !== lock.artifact.ref.name) {
    fail('runtime_tag_mismatch', 'Runtime provenance tag name does not match the lock');
  }
  if (provenance.artifact.ref?.tag_object_sha !== lock.artifact.ref.tag_object_sha) {
    fail('runtime_tag_mismatch', 'Runtime provenance tag object does not match the lock');
  }
  if (provenance.artifact.ref?.commit_sha !== lock.artifact.ref.commit_sha) {
    fail('runtime_commit_mismatch', 'Runtime provenance commit does not match the lock');
  }
  if (provenance.artifact.ref?.tree_sha !== lock.artifact.ref.tree_sha) {
    fail('runtime_tree_mismatch', 'Runtime provenance tree does not match the lock');
  }
  if (!sameJson(provenance.artifact.integrity, lock.artifact.integrity)) {
    fail('runtime_integrity_mismatch', 'Runtime provenance integrity does not match the lock');
  }
  if (provenance.binary.name !== lock.binary.name
      || provenance.binary.relative_path !== lock.binary.relative_path) {
    fail('runtime_binary_contract_mismatch', 'Runtime binary contract does not match the lock');
  }
  if (!sameJson(provenance.compatibility, lock.compatibility)) {
    fail('runtime_compatibility_mismatch', 'Runtime compatibility contract does not match the lock');
  }
  if (!sameJson(provenance.target, target)) {
    fail('runtime_target_mismatch', 'Runtime provenance target does not match this platform');
  }
  if (provenance.binary.sha256 !== target.binary_sha256) {
    fail('runtime_binary_expected_digest_mismatch', 'Runtime provenance binary digest is not lock-authorized');
  }
}

function isManagedExecutable(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isPathExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function isRegularFileWithoutSymlink(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function findFirstPathBinary(binaryName, pathValue) {
  for (const entry of String(pathValue ?? '').split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, binaryName);
    if (isPathExecutable(candidate)) return candidate;
  }
  return null;
}

function assertNoManagedSymlink({ storeRoot, targetPath }) {
  const resolvedRoot = path.resolve(storeRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relativeTarget = path.relative(resolvedRoot, resolvedTarget);
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    fail('runtime_managed_path_invalid', 'Managed runtime path escapes the store root', {
      store_root: resolvedRoot,
      target_path: resolvedTarget,
    });
  }
  const candidates = [resolvedRoot];
  let current = resolvedRoot;
  for (const component of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    candidates.push(current);
  }
  for (const candidate of candidates) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        fail('runtime_managed_path_symlink', 'Managed runtime path contains a symlink', {
          path: candidate,
        });
      }
    } catch (error) {
      if (error instanceof RuntimeResolutionError) throw error;
      if (error?.code === 'ENOENT') break;
      fail('runtime_managed_path_invalid', `Unable to inspect managed path: ${error.message}`, {
        path: candidate,
      });
    }
  }
}

function realpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function getManagedRuntimeDirectory({ lock, storeRoot, platform, arch } = {}) {
  const normalizedLock = normalizeRuntimeLock(lock);
  if (typeof storeRoot !== 'string' || storeRoot.trim() === '') {
    throw new Error('Invalid storeRoot');
  }
  getTargetContract(normalizedLock, platform, arch);
  return path.resolve(
    storeRoot,
    normalizedLock.runtime_ref,
    `${platform}-${arch}`,
    normalizedLock.artifact.ref.commit_sha,
  );
}

export function resolveManagedRuntime({
  lock,
  storeRoot,
  aoPilotVersion,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  const normalizedLock = normalizeRuntimeLock(lock);
  assertCompatibility(normalizedLock, { platform, arch, aoPilotVersion });
  const runtimeDirectory = getManagedRuntimeDirectory({
    lock: normalizedLock,
    storeRoot,
    platform,
    arch,
  });
  const provenancePath = path.join(runtimeDirectory, RUNTIME_PROVENANCE_FILENAME);
  assertNoManagedSymlink({ storeRoot, targetPath: provenancePath });
  if (!isRegularFileWithoutSymlink(provenancePath)) {
    const pathCandidate = findFirstPathBinary(normalizedLock.binary.name, env.PATH);
    fail('runtime_missing', 'Managed runtime provenance is missing', {
      runtime_directory: runtimeDirectory,
      path_candidate: pathCandidate,
    });
  }

  let provenance;
  try {
    provenance = normalizeRuntimeProvenance(
      readJson(provenancePath, 'runtime_provenance_invalid'),
    );
  } catch (error) {
    if (error instanceof RuntimeResolutionError) throw error;
    fail('runtime_provenance_invalid', error.message, { path: provenancePath });
  }
  assertProvenance(normalizedLock, provenance, { platform, arch });

  const binaryPath = path.resolve(runtimeDirectory, normalizedLock.binary.relative_path);
  if (!binaryPath.startsWith(`${runtimeDirectory}${path.sep}`)) {
    fail('runtime_binary_path_invalid', 'Runtime binary escapes the managed runtime directory');
  }
  assertNoManagedSymlink({ storeRoot, targetPath: binaryPath });
  if (!isManagedExecutable(binaryPath)) {
    fail('runtime_binary_missing', 'Locked runtime binary is missing or not executable', {
      binary_path: binaryPath,
    });
  }
  const observedSha256 = fileSha256(binaryPath);
  const expectedSha256 = getTargetContract(normalizedLock, platform, arch).binary_sha256;
  if (observedSha256 !== expectedSha256 || observedSha256 !== provenance.binary.sha256) {
    fail('runtime_binary_integrity_mismatch', 'Runtime binary SHA-256 does not match provenance', {
      binary_path: binaryPath,
      expected_sha256: expectedSha256,
      observed_sha256: observedSha256,
    });
  }

  const pathCandidate = findFirstPathBinary(normalizedLock.binary.name, env.PATH);
  if (pathCandidate && realpath(pathCandidate) !== realpath(binaryPath)) {
    fail('runtime_path_shadowed', 'PATH contains a different binary with the locked runtime name', {
      binary_path: binaryPath,
      path_candidate: pathCandidate,
    });
  }

  return {
    status: 'verified',
    runtime_ref: normalizedLock.runtime_ref,
    lock_digest: computeRuntimeLockDigest(normalizedLock),
    runtime_directory: runtimeDirectory,
    provenance_path: provenancePath,
    binary_path: binaryPath,
    binary_sha256: observedSha256,
    source: {
      repository: normalizedLock.artifact.repository,
      version: normalizedLock.artifact.version,
      tag: normalizedLock.artifact.ref.name,
      tag_object_sha: normalizedLock.artifact.ref.tag_object_sha,
      commit_sha: normalizedLock.artifact.ref.commit_sha,
      tree_sha: normalizedLock.artifact.ref.tree_sha,
      integrity: normalizedLock.artifact.integrity,
    },
    compatibility: normalizedLock.compatibility,
    path_candidate: pathCandidate,
  };
}
