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
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match) fail('runtime_compatibility_invalid', `Invalid ${fieldName}`, { value });
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertProvenance(lock, provenance) {
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
}

function isExecutable(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0;
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
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function realpath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

export function getManagedRuntimeDirectory({ lock, storeRoot } = {}) {
  const normalizedLock = normalizeRuntimeLock(lock);
  if (typeof storeRoot !== 'string' || storeRoot.trim() === '') {
    throw new Error('Invalid storeRoot');
  }
  return path.resolve(
    storeRoot,
    normalizedLock.runtime_ref,
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
  });
  const provenancePath = path.join(runtimeDirectory, RUNTIME_PROVENANCE_FILENAME);
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
  assertProvenance(normalizedLock, provenance);

  const binaryPath = path.resolve(runtimeDirectory, normalizedLock.binary.relative_path);
  if (!binaryPath.startsWith(`${runtimeDirectory}${path.sep}`)) {
    fail('runtime_binary_path_invalid', 'Runtime binary escapes the managed runtime directory');
  }
  if (!isExecutable(binaryPath)) {
    fail('runtime_binary_missing', 'Locked runtime binary is missing or not executable', {
      binary_path: binaryPath,
    });
  }
  const observedSha256 = fileSha256(binaryPath);
  if (observedSha256 !== provenance.binary.sha256) {
    fail('runtime_binary_integrity_mismatch', 'Runtime binary SHA-256 does not match provenance', {
      binary_path: binaryPath,
      expected_sha256: provenance.binary.sha256,
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
