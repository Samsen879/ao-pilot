import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { assertRelease, fileSha256, readJson, sha256 } from './release-manifest.js';
const text = (buffer) => buffer.toString('utf8').replace(/\0.*$/s, '');
function pax(data) {
  const result = {}; let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset); const length = Number(data.subarray(offset, space).toString());
    assertRelease(space > offset && Number.isSafeInteger(length) && length > space - offset + 1 && offset + length <= data.length, 'invalid_release_tarball');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equal = record.indexOf('='); assertRelease(equal > 0, 'invalid_release_tarball');
    result[record.slice(0, equal)] = record.slice(equal + 1); offset += length;
  }
  return result;
}
// Read-only parser: verification never extracts attacker-controlled paths.
export function packedFiles(tarball) {
  const archive = gunzipSync(fs.readFileSync(tarball), { maxOutputLength: 1024 * 1024 * 1024 });
  const files = new Map(); let offset = 0; let attributes = {}; let longName = null;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512); if (header.every((byte) => byte === 0)) break;
    const checksum = Number.parseInt(text(header.subarray(148, 156)).trim(), 8);
    const calculated = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    assertRelease(checksum === calculated, 'invalid_release_tarball');
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    assertRelease(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length, 'invalid_release_tarball');
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const kind = String.fromCharCode(header[156] || 48);
    if (kind === 'x') { attributes = pax(data); continue; }
    if (kind === 'g') { const global = pax(data); assertRelease(!global.path && !global.linkpath, 'invalid_release_tarball'); continue; }
    if (kind === 'L') { longName = text(data); continue; }
    const prefix = text(header.subarray(345, 500));
    const name = attributes.path ?? longName ?? [prefix, text(header.subarray(0, 100))].filter(Boolean).join('/');
    const link = attributes.linkpath ?? text(header.subarray(157, 257));
    attributes = {}; longName = null;
    if (name === 'package/' || name === 'package') continue;
    assertRelease(name.startsWith('package/') && !name.includes('\\') && !name.includes('\0')
      && name.slice(8).split('/').filter(Boolean).every((part) => part !== '.' && part !== '..'), 'unsafe_release_tarball_path');
    const relative = name.slice(8).replace(/\/$/, '');
    assertRelease(relative !== '' && !files.has(relative), 'invalid_release_tarball');
    assertRelease(['0', '2', '5'].includes(kind), 'unsupported_release_tarball_entry');
    files.set(relative, { type: kind === '0' ? 'file' : kind === '2' ? 'symlink' : 'directory',
      mode: Number.parseInt(text(header.subarray(100, 108)).trim() || '0', 8),
      sha256: kind === '0' ? sha256(data) : null, target: kind === '2' ? link : null });
  }
  assertRelease(files.size > 0, 'invalid_release_tarball'); return files;
}
// npm deliberately omits dependencies, lockfiles and tooling metadata. Those
// bytes remain mandatory in the separately transferred, manifest-verified
// payload and its actual consumer smoke; no runtime module/config is exempt.
export function payloadOnlyPath(name) {
  return name.split('/').includes('node_modules') || /(?:^|\/)\.next\/cache(?:\/|$)/.test(name)
    || /(?:^|\/)(?:package-lock\.json|\.gitignore|\.npmignore|\.npmrc|\.DS_Store|npm-debug\.log|config\.gypi)$/.test(name);
}
export function requiredPackageFiles(manifest) {
  return manifest.files.filter((file) => file.type !== 'directory' && !payloadOnlyPath(file.path));
}
export function verifyPackedRelease(tarball, payloadRoot, manifest) {
  const packed = packedFiles(tarball);
  assertRelease(packed.get('release.json')?.sha256 === fileSha256(`${payloadRoot}/release.json`), 'packed_manifest_mismatch');
  const inventory = new Map(manifest.files.map((file) => [file.path, file]));
  for (const [name, entry] of packed) {
    if (name === 'release.json') continue;
    const installed = inventory.get(name);
    assertRelease(installed && installed.type === entry.type, 'packed_payload_mismatch');
    if (entry.type === 'file') assertRelease(installed.sha256 === entry.sha256
      && Boolean(installed.mode & 0o111) === Boolean(entry.mode & 0o111), 'packed_payload_mismatch');
    else if (entry.type === 'symlink') assertRelease(installed.target === entry.target, 'packed_payload_mismatch');
  }
  for (const file of requiredPackageFiles(manifest)) assertRelease(packed.has(file.path), 'release_package_file_missing');
  const metadataFile = `${payloadRoot}/package.json`;
  if (fs.existsSync(metadataFile)) {
    const metadata = readJson(metadataFile);
    const values = (value) => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(values) : [];
    for (const entry of [...values(metadata.exports), ...values(metadata.bin)]) {
      const name = entry.replace(/^\.\//, '');
      assertRelease(packed.get(name)?.type === 'file', 'release_package_export_missing');
    }
  }
  for (const component of Object.values(manifest.components)) assertRelease(packed.get(component.entrypoint)?.type === 'file', 'release_package_component_missing');
  assertRelease(packed.has('browser/packages/web/.next/BUILD_ID') && packed.has('browser/packages/web/dist-server/start-all.js'), 'release_package_component_missing');
  return true;
}
