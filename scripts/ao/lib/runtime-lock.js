import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_LOCK_SCHEMA_VERSION = 'ao.runtime-lock.v1';
export const DEFAULT_RUNTIME_LOCK_FILENAME = 'agent-orchestrator.lock.json';
export const RUNTIME_ARTIFACT_KINDS = ['git_source'];
export const RUNTIME_REF_KINDS = ['annotated_tag'];
export const RUNTIME_INTEGRITY_ALGORITHMS = ['git-tree-sha1'];

const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RUNTIME_REF_PATTERN = /^[A-Za-z0-9._-]+$/;
const RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/;
const GITHUB_REPOSITORY_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertPlainObject(value, fieldName) {
  if (!isPlainObject(value)) throw new Error(`Invalid ${fieldName}`);
  return value;
}

function assertExactKeys(value, fieldName, expectedKeys) {
  const actualKeys = Object.keys(value).sort();
  const normalizedExpectedKeys = [...expectedKeys].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(normalizedExpectedKeys)) {
    throw new Error(`Invalid ${fieldName} keys`);
  }
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function normalizeLiteral(value, fieldName, allowedValues) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Unsupported ${fieldName}: ${normalized}`);
  }
  return normalized;
}

function normalizeSha1(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName).toLowerCase();
  if (!SHA1_PATTERN.test(normalized)) throw new Error(`Invalid ${fieldName}`);
  return normalized;
}

function normalizeSha256(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`Invalid ${fieldName}`);
  return normalized;
}

function normalizeSemver(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!SEMVER_PATTERN.test(normalized)) throw new Error(`Invalid ${fieldName}`);
  return normalized;
}

function normalizeRelativePath(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName).replaceAll('\\', '/');
  if (!RELATIVE_PATH_PATTERN.test(normalized) || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeRepository(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!GITHUB_REPOSITORY_PATTERN.test(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizePackage(value) {
  const packageContract = assertPlainObject(value, 'artifact.package');
  assertExactKeys(packageContract, 'artifact.package', [
    'name',
    'version',
    'role',
    'install_authority',
  ]);
  if (packageContract.install_authority !== false) {
    throw new Error('Invalid artifact.package.install_authority');
  }
  return {
    name: normalizeRequiredString(packageContract.name, 'artifact.package.name'),
    version: normalizeSemver(packageContract.version, 'artifact.package.version'),
    role: normalizeLiteral(
      packageContract.role,
      'artifact.package.role',
      ['upstream_identity'],
    ),
    install_authority: false,
  };
}

function normalizeArtifactRef(value) {
  const ref = assertPlainObject(value, 'artifact.ref');
  assertExactKeys(ref, 'artifact.ref', [
    'kind',
    'name',
    'tag_object_sha',
    'commit_sha',
    'tree_sha',
  ]);
  return {
    kind: normalizeLiteral(ref.kind, 'artifact.ref.kind', RUNTIME_REF_KINDS),
    name: normalizeRequiredString(ref.name, 'artifact.ref.name'),
    tag_object_sha: normalizeSha1(ref.tag_object_sha, 'artifact.ref.tag_object_sha'),
    commit_sha: normalizeSha1(ref.commit_sha, 'artifact.ref.commit_sha'),
    tree_sha: normalizeSha1(ref.tree_sha, 'artifact.ref.tree_sha'),
  };
}

function normalizeArtifact(value) {
  const artifact = assertPlainObject(value, 'artifact');
  assertExactKeys(artifact, 'artifact', [
    'kind',
    'repository',
    'upstream_repository',
    'version',
    'package',
    'ref',
    'integrity',
  ]);
  const ref = normalizeArtifactRef(artifact.ref);
  const integrity = assertPlainObject(artifact.integrity, 'artifact.integrity');
  assertExactKeys(integrity, 'artifact.integrity', ['algorithm', 'digest']);
  const normalizedIntegrity = {
    algorithm: normalizeLiteral(
      integrity.algorithm,
      'artifact.integrity.algorithm',
      RUNTIME_INTEGRITY_ALGORITHMS,
    ),
    digest: normalizeSha1(integrity.digest, 'artifact.integrity.digest'),
  };
  if (normalizedIntegrity.digest !== ref.tree_sha) {
    throw new Error('Runtime integrity digest does not match artifact.ref.tree_sha');
  }
  return {
    kind: normalizeLiteral(artifact.kind, 'artifact.kind', RUNTIME_ARTIFACT_KINDS),
    repository: normalizeRepository(artifact.repository, 'artifact.repository'),
    upstream_repository: normalizeRepository(
      artifact.upstream_repository,
      'artifact.upstream_repository',
    ),
    version: normalizeSemver(artifact.version, 'artifact.version'),
    package: normalizePackage(artifact.package),
    ref,
    integrity: normalizedIntegrity,
  };
}

function normalizeBuild(value) {
  const build = assertPlainObject(value, 'build');
  assertExactKeys(build, 'build', [
    'working_directory',
    'toolchain',
    'environment',
    'command',
  ]);
  const toolchain = assertPlainObject(build.toolchain, 'build.toolchain');
  assertExactKeys(toolchain, 'build.toolchain', ['name', 'version']);
  const environment = assertPlainObject(build.environment, 'build.environment');
  assertExactKeys(environment, 'build.environment', ['CGO_ENABLED']);
  if (environment.CGO_ENABLED !== '0') {
    throw new Error('Invalid build.environment.CGO_ENABLED');
  }
  if (!Array.isArray(build.command) || build.command.length === 0) {
    throw new Error('Invalid build.command');
  }
  const command = build.command.map((item, index) => (
    normalizeRequiredString(item, `build.command[${index}]`)
  ));
  if (command[0] !== toolchain.name || !command.includes('{binary_path}')) {
    throw new Error('Invalid build.command contract');
  }
  return {
    working_directory: normalizeRelativePath(
      build.working_directory,
      'build.working_directory',
    ),
    toolchain: {
      name: normalizeLiteral(toolchain.name, 'build.toolchain.name', ['go']),
      version: normalizeSemver(toolchain.version, 'build.toolchain.version'),
    },
    environment: {
      CGO_ENABLED: '0',
    },
    command,
  };
}

function normalizeBinary(value) {
  const binary = assertPlainObject(value, 'binary');
  assertExactKeys(binary, 'binary', ['name', 'relative_path']);
  const name = normalizeRequiredString(binary.name, 'binary.name');
  const relativePath = normalizeRelativePath(binary.relative_path, 'binary.relative_path');
  if (path.posix.basename(relativePath) !== name) {
    throw new Error('Runtime binary path does not match binary.name');
  }
  return {
    name,
    relative_path: relativePath,
  };
}

function normalizeCompatibility(value) {
  const compatibility = assertPlainObject(value, 'compatibility');
  assertExactKeys(compatibility, 'compatibility', ['ao_pilot', 'platforms']);
  const aoPilot = assertPlainObject(compatibility.ao_pilot, 'compatibility.ao_pilot');
  assertExactKeys(aoPilot, 'compatibility.ao_pilot', [
    'minimum_version',
    'maximum_exclusive_version',
  ]);
  if (!Array.isArray(compatibility.platforms) || compatibility.platforms.length === 0) {
    throw new Error('Invalid compatibility.platforms');
  }
  const platforms = compatibility.platforms.map((item, index) => {
    const platform = assertPlainObject(item, `compatibility.platforms[${index}]`);
    assertExactKeys(platform, `compatibility.platforms[${index}]`, [
      'os',
      'arch',
      'binary_sha256',
    ]);
    return {
      os: normalizeLiteral(platform.os, `compatibility.platforms[${index}].os`, ['linux']),
      arch: normalizeLiteral(
        platform.arch,
        `compatibility.platforms[${index}].arch`,
        ['x64', 'arm64'],
      ),
      binary_sha256: normalizeSha256(
        platform.binary_sha256,
        `compatibility.platforms[${index}].binary_sha256`,
      ),
    };
  });
  return {
    ao_pilot: {
      minimum_version: normalizeSemver(
        aoPilot.minimum_version,
        'compatibility.ao_pilot.minimum_version',
      ),
      maximum_exclusive_version: normalizeSemver(
        aoPilot.maximum_exclusive_version,
        'compatibility.ao_pilot.maximum_exclusive_version',
      ),
    },
    platforms,
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function normalizeRuntimeLock(value) {
  const lock = assertPlainObject(value, 'runtime lock');
  assertExactKeys(lock, 'runtime lock', [
    'schema_version',
    'runtime_ref',
    'artifact',
    'build',
    'binary',
    'compatibility',
  ]);
  if (lock.schema_version !== RUNTIME_LOCK_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime lock schema: ${String(lock.schema_version)}`);
  }
  const runtimeRef = normalizeRequiredString(lock.runtime_ref, 'runtime_ref');
  if (!RUNTIME_REF_PATTERN.test(runtimeRef)) throw new Error('Invalid runtime_ref');
  return {
    schema_version: RUNTIME_LOCK_SCHEMA_VERSION,
    runtime_ref: runtimeRef,
    artifact: normalizeArtifact(lock.artifact),
    build: normalizeBuild(lock.build),
    binary: normalizeBinary(lock.binary),
    compatibility: normalizeCompatibility(lock.compatibility),
  };
}

export function computeRuntimeLockDigest(value) {
  const lock = normalizeRuntimeLock(value);
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(lock)))
    .digest('hex')}`;
}

export function getDefaultRuntimeLockPath() {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDirectory, '../../../runtime', DEFAULT_RUNTIME_LOCK_FILENAME);
}

export function loadRuntimeLock({ lockPath = getDefaultRuntimeLockPath() } = {}) {
  const resolvedPath = path.resolve(lockPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load runtime lock at ${resolvedPath}: ${error.message}`);
  }
  const lock = normalizeRuntimeLock(parsed);
  return {
    path: resolvedPath,
    lock,
    digest: computeRuntimeLockDigest(lock),
  };
}
