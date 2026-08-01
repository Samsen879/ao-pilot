import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((result, key) => {
        result[key] = stableValue(value[key]);
        return result;
      }, {});
  }
  return value;
}
export function canonicalJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function artifactDigest(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}

export function writeFileExclusive(filePath, bytes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(filePath, bytes, { flag: 'wx' });
    return 'created';
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(filePath);
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (!existing.equals(expected)) {
      throw new Error(`Refusing to overwrite non-identical snapshot: ${filePath}`);
    }
    return 'verified';
  }
}

export function writeCanonicalJson(filePath, value, { exclusive = false } = {}) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (exclusive) return writeFileExclusive(filePath, bytes);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, bytes);
  fs.renameSync(temporaryPath, filePath);
  return 'written';
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function contentAddressedPath(root, digest) {
  return path.join(root, 'sha256', digest.slice(0, 2), `${digest}.json`);
}
