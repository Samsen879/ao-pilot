import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const RELEASE_COMPONENTS = ['daemon', 'cli', 'dashboard', 'adapter'];
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fileSha256 = (file) => sha256(fs.readFileSync(file));
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export const objectSha256 = (value) => sha256(JSON.stringify(canonical(value)));
export function releaseError(code, message = code) { return Object.assign(new Error(message), { code }); }
export function assertRelease(condition, code, message) { if (!condition) throw releaseError(code, message); }
export function relativePath(value) {
  assertRelease(typeof value === 'string' && value !== '' && !value.includes('\\') && !value.includes('\0')
    && !path.posix.isAbsolute(value) && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'), 'unsafe_release_path');
  return value;
}
export function confined(root, relative) {
  relativePath(relative);
  const resolved = path.resolve(root, relative);
  assertRelease(resolved.startsWith(`${path.resolve(root)}${path.sep}`), 'unsafe_release_path');
  return resolved;
}
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
export function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export function durableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file); syncDirectory(path.dirname(file));
}
export function inventoryTree(root, { exclude = ['release.json'] } = {}) {
  const records = []; const violations = []; let firstError;
  function reject(relative, error, reason, details = {}) {
    firstError ??= error;
    violations.push({ path: relative || '.', code: error.code, reason, ...details });
  }
  function walk(relative) {
    const absolute = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (error) { reject(relative, error, 'metadata_unreadable'); return; }
    const mode = stat.mode & 0o777;
    if (stat.isSymbolicLink()) {
      let target;
      try { target = fs.readlinkSync(absolute); }
      catch (error) { reject(relative, error, 'symlink_unreadable'); return; }
      const destination = path.resolve(path.dirname(absolute), target);
      if (path.isAbsolute(target) || !(destination === path.resolve(root) || destination.startsWith(`${path.resolve(root)}${path.sep}`))) {
        reject(relative, releaseError('escaping_release_symlink'), 'escaping_symlink', { type: 'symlink' }); return;
      }
      if (!fs.existsSync(destination)) {
        reject(relative, releaseError('dangling_release_symlink'), 'dangling_symlink', { type: 'symlink' }); return;
      }
      records.push({ path: relative, type: 'symlink', mode, size: Buffer.byteLength(target), target });
    } else if (stat.isDirectory()) {
      if (relative) records.push({ path: relative, type: 'directory', mode, size: 0 });
      let names;
      try { names = fs.readdirSync(absolute); }
      catch (error) { reject(relative, error, 'directory_unreadable', { type: 'directory' }); return; }
      for (const name of names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
        const child = relative ? `${relative}/${name}` : name;
        if (!exclude.includes(child)) walk(child);
      }
    } else {
      if (!stat.isFile() || stat.nlink !== 1) {
        const type = stat.isFile() ? 'file' : stat.isFIFO() ? 'fifo' : stat.isSocket() ? 'socket'
          : stat.isBlockDevice() ? 'block_device' : stat.isCharacterDevice() ? 'character_device' : 'unknown';
        reject(relative, releaseError('unsupported_release_file'), stat.isFile() ? (stat.nlink > 1 ? 'multiple_links' : 'invalid_link_count') : 'unsupported_type',
          { type, nlink: stat.nlink, ...(stat.isFile() ? { link_group: sha256(`${stat.dev}:${stat.ino}`) } : {}) });
        return; // Never read a rejected entry (in particular a FIFO or device).
      }
      try { records.push({ path: relative, type: 'file', mode, size: stat.size, sha256: fileSha256(absolute) }); }
      catch (error) { reject(relative, error, 'file_unreadable', { type: 'file' }); }
    }
  }
  walk('');
  if (firstError) {
    firstError.violations = violations.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    throw firstError; // Keep the original verdict, first code and message.
  }
  return records.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
function validateSchema(value, schema, label = 'manifest') {
  if (schema.const !== undefined) assertRelease(value === schema.const, 'invalid_release_manifest', label);
  if (schema.enum) assertRelease(schema.enum.includes(value), 'invalid_release_manifest', label);
  if (schema.type === 'object') {
    assertRelease(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_release_manifest', label);
    for (const name of schema.required ?? []) assertRelease(Object.hasOwn(value, name), 'invalid_release_manifest', `${label}.${name}`);
    for (const [name, child] of Object.entries(value)) {
      assertRelease(schema.properties?.[name] !== undefined || schema.additionalProperties !== false, 'invalid_release_manifest', `${label}.${name}`);
      if (schema.properties?.[name]) validateSchema(child, schema.properties[name], `${label}.${name}`);
    }
  } else if (schema.type === 'array') {
    assertRelease(Array.isArray(value), 'invalid_release_manifest', label);
    for (const child of value) validateSchema(child, schema.items, label);
  } else if (schema.type === 'string') {
    assertRelease(typeof value === 'string' && (!schema.pattern || new RegExp(schema.pattern).test(value)), 'invalid_release_manifest', label);
  } else if (schema.type === 'integer') assertRelease(Number.isSafeInteger(value) && value >= (schema.minimum ?? 0), 'invalid_release_manifest', label);
  else if (schema.type === 'boolean') assertRelease(typeof value === 'boolean', 'invalid_release_manifest', label);
}
export function validateReleaseManifest(manifest) {
  const schema = readJson(new URL('../../../schemas/ao.release.v1.schema.json', import.meta.url));
  validateSchema(manifest, schema);
  assertRelease(manifest.release_id === `${manifest.version}+${manifest.commit}`, 'invalid_release_id');
  assertRelease(/^1\.25\.\d+$/.test(manifest.toolchain.go) && manifest.toolchain.CGO_ENABLED === '0', 'release_toolchain_unsupported');
  assertRelease(manifest.database.schema_min_readable <= manifest.database.schema_current
    && manifest.database.schema_current <= manifest.database.schema_max_readable, 'release_schema_incompatible');
  for (const name of RELEASE_COMPONENTS) {
    const component = manifest.components[name];
    relativePath(component.entrypoint);
    assertRelease(component.files.length > 0 && objectSha256(component.files) === component.sha256, 'release_component_digest_mismatch');
    assertRelease(component.files.some((entry) => entry.path === component.entrypoint && entry.type === 'file'), 'release_entrypoint_missing');
  }
  return manifest;
}
export function verifyReleaseTree(root, expectedManifestSha = null) {
  const manifestFile = path.join(root, 'release.json');
  if (expectedManifestSha) assertRelease(fileSha256(manifestFile) === expectedManifestSha, 'release_manifest_digest_mismatch');
  const manifest = validateReleaseManifest(readJson(manifestFile));
  const actual = inventoryTree(root);
  assertRelease(objectSha256(actual) === objectSha256(manifest.files), 'release_payload_digest_mismatch');
  const byPath = new Map(actual.map((record) => [record.path, record]));
  for (const component of Object.values(manifest.components)) {
    for (const entry of component.files) assertRelease(objectSha256(byPath.get(entry.path)) === objectSha256(entry), 'release_component_digest_mismatch');
  }
  return manifest;
}
export function syncTree(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) syncTree(target);
    else if (entry.isFile()) { const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  syncDirectory(root);
}
