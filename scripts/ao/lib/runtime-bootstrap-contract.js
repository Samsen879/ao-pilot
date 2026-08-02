import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_BOOTSTRAP_TOOLCHAIN_SCHEMA_VERSION =
  'ao.runtime-bootstrap-toolchain.v1';

const SHA256 = /^[a-f0-9]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILENAME = /^[A-Za-z0-9._-]+$/;

function assertObject(value, name) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function assertKeys(value, name, keys) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`Invalid ${name} keys`);
  }
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${name}`);
  return value.trim();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function normalizeBootstrapToolchainLock(value) {
  const lock = assertObject(value, 'bootstrap toolchain lock');
  assertKeys(lock, 'bootstrap toolchain lock', [
    'schema_version', 'name', 'version', 'distribution', 'platforms',
  ]);
  if (lock.schema_version !== RUNTIME_BOOTSTRAP_TOOLCHAIN_SCHEMA_VERSION) {
    throw new Error(`Unsupported bootstrap toolchain schema: ${String(lock.schema_version)}`);
  }
  const name = requiredString(lock.name, 'toolchain name');
  const version = requiredString(lock.version, 'toolchain version');
  if (name !== 'go' || !SEMVER.test(version)) throw new Error('Invalid bootstrap toolchain');
  const distribution = requiredString(lock.distribution, 'toolchain distribution');
  if (distribution !== 'https://go.dev/dl/') {
    throw new Error('Untrusted bootstrap toolchain distribution');
  }
  if (!Array.isArray(lock.platforms) || lock.platforms.length !== 2) {
    throw new Error('Invalid bootstrap toolchain platforms');
  }
  const platforms = lock.platforms.map((entry, index) => {
    const item = assertObject(entry, `toolchain platform ${index}`);
    assertKeys(item, `toolchain platform ${index}`, [
      'os', 'arch', 'goarch', 'filename', 'url', 'sha256',
    ]);
    const os = requiredString(item.os, `toolchain platform ${index} os`);
    const arch = requiredString(item.arch, `toolchain platform ${index} arch`);
    const goarch = requiredString(item.goarch, `toolchain platform ${index} goarch`);
    const filename = requiredString(item.filename, `toolchain platform ${index} filename`);
    const url = requiredString(item.url, `toolchain platform ${index} url`);
    const sha256 = requiredString(item.sha256, `toolchain platform ${index} sha256`).toLowerCase();
    const expectedGoarch = arch === 'x64' ? 'amd64' : arch;
    if (os !== 'linux' || !['x64', 'arm64'].includes(arch) || goarch !== expectedGoarch) {
      throw new Error(`Unsupported bootstrap toolchain platform: ${os}-${arch}`);
    }
    if (!FILENAME.test(filename) || filename !== `go${version}.linux-${goarch}.tar.gz`) {
      throw new Error(`Invalid bootstrap toolchain filename: ${filename}`);
    }
    if (url !== `${distribution}${filename}`) {
      throw new Error(`Invalid bootstrap toolchain URL: ${url}`);
    }
    if (!SHA256.test(sha256)) throw new Error('Invalid bootstrap toolchain SHA-256');
    return { os, arch, goarch, filename, url, sha256 };
  });
  const identities = platforms.map((item) => `${item.os}-${item.arch}`);
  if (new Set(identities).size !== platforms.length) {
    throw new Error('Duplicate bootstrap toolchain platform');
  }
  return {
    schema_version: RUNTIME_BOOTSTRAP_TOOLCHAIN_SCHEMA_VERSION,
    name,
    version,
    distribution,
    platforms,
  };
}

export function computeBootstrapToolchainLockDigest(value) {
  const normalized = normalizeBootstrapToolchainLock(value);
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(normalized)))
    .digest('hex')}`;
}

export function getDefaultBootstrapToolchainLockPath() {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(directory, '../../../runtime/go-toolchain.lock.json');
}

export function loadBootstrapToolchainLock({
  lockPath = getDefaultBootstrapToolchainLockPath(),
} = {}) {
  const resolvedPath = path.resolve(lockPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load bootstrap toolchain lock at ${resolvedPath}: ${error.message}`);
  }
  const lock = normalizeBootstrapToolchainLock(parsed);
  return {
    path: resolvedPath,
    lock,
    digest: computeBootstrapToolchainLockDigest(lock),
  };
}
