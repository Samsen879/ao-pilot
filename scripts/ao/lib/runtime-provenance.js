import { computeRuntimeLockDigest, normalizeRuntimeLock } from './runtime-lock.js';

export const RUNTIME_PROVENANCE_SCHEMA_VERSION = 'ao.runtime-provenance.v1';
export const RUNTIME_PROVENANCE_FILENAME = 'runtime-provenance.json';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }
  return value.trim();
}

function normalizeSha256(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName).toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) throw new Error(`Invalid ${fieldName}`);
  return normalized;
}

function normalizeTimestamp(value) {
  const normalized = normalizeRequiredString(value, 'installed_at');
  if (Number.isNaN(new Date(normalized).getTime())) throw new Error('Invalid installed_at');
  return normalized;
}

function cloneJsonValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRuntimeProvenance({
  lock,
  binary_sha256,
  installed_at,
} = {}) {
  const normalizedLock = normalizeRuntimeLock(lock);
  return {
    schema_version: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    runtime_ref: normalizedLock.runtime_ref,
    lock_digest: computeRuntimeLockDigest(normalizedLock),
    installed_at: normalizeTimestamp(installed_at),
    artifact: {
      repository: normalizedLock.artifact.repository,
      version: normalizedLock.artifact.version,
      ref: cloneJsonValue(normalizedLock.artifact.ref),
      integrity: cloneJsonValue(normalizedLock.artifact.integrity),
    },
    binary: {
      name: normalizedLock.binary.name,
      relative_path: normalizedLock.binary.relative_path,
      sha256: normalizeSha256(binary_sha256, 'binary_sha256'),
    },
    compatibility: cloneJsonValue(normalizedLock.compatibility),
  };
}

export function normalizeRuntimeProvenance(value) {
  if (!isPlainObject(value)) throw new Error('Invalid runtime provenance');
  if (value.schema_version !== RUNTIME_PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported runtime provenance schema: ${String(value.schema_version)}`);
  }
  if (!isPlainObject(value.artifact) || !isPlainObject(value.artifact.ref)) {
    throw new Error('Invalid runtime provenance artifact');
  }
  if (!isPlainObject(value.artifact.integrity) || !isPlainObject(value.binary)) {
    throw new Error('Invalid runtime provenance integrity');
  }
  if (!isPlainObject(value.compatibility)) {
    throw new Error('Invalid runtime provenance compatibility');
  }
  return {
    schema_version: RUNTIME_PROVENANCE_SCHEMA_VERSION,
    runtime_ref: normalizeRequiredString(value.runtime_ref, 'runtime_ref'),
    lock_digest: normalizeRequiredString(value.lock_digest, 'lock_digest'),
    installed_at: normalizeTimestamp(value.installed_at),
    artifact: cloneJsonValue(value.artifact),
    binary: {
      name: normalizeRequiredString(value.binary.name, 'binary.name'),
      relative_path: normalizeRequiredString(
        value.binary.relative_path,
        'binary.relative_path',
      ),
      sha256: normalizeSha256(value.binary.sha256, 'binary.sha256'),
    },
    compatibility: cloneJsonValue(value.compatibility),
  };
}
