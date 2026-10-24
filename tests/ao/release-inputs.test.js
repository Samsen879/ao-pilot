import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { fixtureRoot } from './release-fixture.js';
import { inventoryTree, fileSha256 } from '../../scripts/ao/lib/release-manifest.js';
import { registeredReleaseFiles, materializeRegisteredReleaseFiles } from '../../scripts/ao/lib/release-inputs.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(arch = 'x64') {
  const root = fixtureRoot(); roots.push(root); const specs = registeredReleaseFiles(arch);
  for (const { paths } of specs) {
    for (const name of paths) fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, paths[0]), '#!/bin/sh\n# registered fixture bytes\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(path.join(root, paths[0]), 0o755); // Test an exact mode independently of the caller's umask.
    fs.linkSync(path.join(root, paths[0]), path.join(root, paths[1]));
  }
  return { root, specs, arch };
}
it.each(['x64', 'arm64'])('materializes only the exact registered %s pairs while preserving bytes and executable mode', (arch) => {
  const { root, specs } = fixture(arch); const files = specs.flatMap((item) => item.paths);
  const hashes = files.map((name) => fileSha256(path.join(root, name)));
  expect(() => inventoryTree(root)).toThrow('unsupported_release_file');
  const records = materializeRegisteredReleaseFiles(root, { arch });
  expect(records.map((row) => row.path)).toEqual(files);
  expect(records.every((row) => row.type === 'file' && row.source_type === 'internal_hardlink' && row.nlink === 1)).toBe(true);
  expect(files.map((name) => fileSha256(path.join(root, name)))).toEqual(hashes);
  for (const name of files) { const stat = fs.lstatSync(path.join(root, name)); expect(stat.nlink).toBe(1); expect(stat.mode & 0o777).toBe(0o755); }
  expect(inventoryTree(root).filter((row) => row.type === 'file')).toHaveLength(4);
  expect(materializeRegisteredReleaseFiles(root, { arch })).toEqual([]);
});
it('leaves absent optional pairs alone without creating paths or weakening unknown hardlink rejection', () => {
  const root = fixtureRoot(); roots.push(root);
  fs.writeFileSync(path.join(root, 'unknown-a'), 'unregistered'); fs.linkSync(path.join(root, 'unknown-a'), path.join(root, 'unknown-b'));
  expect(materializeRegisteredReleaseFiles(root, { arch: 'x64' })).toEqual([]);
  expect(() => inventoryTree(root)).toThrow('unsupported_release_file');
});
it('rejects an unaccounted third link without modifying any registered member', () => {
  const { root, specs } = fixture(); const first = path.join(root, specs[0].paths[0]);
  const outside = fixtureRoot(); roots.push(outside); fs.linkSync(first, path.join(outside, 'external-link'));
  expect(() => materializeRegisteredReleaseFiles(root, { arch: 'x64' })).toThrow('release_inventory_registration_mismatch');
  expect(fs.statSync(first).nlink).toBe(3);
  expect(() => inventoryTree(root)).toThrow('unsupported_release_file');
});
it('rejects missing peers, symlink leaves and dependency directory symlinks', () => {
  for (const mode of ['missing', 'leaf', 'parent']) {
    const { root, specs } = fixture(); const [first, alias] = specs[0].paths.map((name) => path.join(root, name));
    fs.unlinkSync(alias);
    if (mode === 'leaf') fs.symlinkSync(path.relative(path.dirname(alias), first), alias);
    if (mode === 'parent') {
      const parent = path.dirname(alias); const moved = `${parent}-moved`; fs.renameSync(parent, moved); fs.symlinkSync(path.basename(moved), parent);
    }
    expect(() => materializeRegisteredReleaseFiles(root, { arch: 'x64' })).toThrow('release_inventory_registration_mismatch');
  }
});
it('rejects two unrelated shared inodes even at registered paths', () => {
  const { root, specs } = fixture(); const [first, alias] = specs[0].paths.map((name) => path.join(root, name));
  fs.unlinkSync(alias); fs.writeFileSync(alias, fs.readFileSync(first), { mode: 0o755 });
  fs.linkSync(first, path.join(root, 'first-unregistered-peer')); fs.linkSync(alias, path.join(root, 'alias-unregistered-peer'));
  expect(() => materializeRegisteredReleaseFiles(root, { arch: 'x64' })).toThrow('release_inventory_registration_mismatch');
});
it('does not turn registration into an executable/type bypass', () => {
  const { root, specs } = fixture(); fs.chmodSync(path.join(root, specs[0].paths[0]), 0o644);
  expect(() => materializeRegisteredReleaseFiles(root, { arch: 'x64' })).toThrow('release_inventory_registration_mismatch');
});
it('preserves an already-independent JS fallback launcher and lets normal inventory bind its bytes', () => {
  const { root, specs } = fixture(); const alias = path.join(root, specs[0].paths[1]);
  fs.unlinkSync(alias); fs.writeFileSync(alias, '#!/usr/bin/env node\n// valid independent fallback\n', { mode: 0o755 });
  const digest = fileSha256(alias); materializeRegisteredReleaseFiles(root, { arch: 'x64' });
  expect(fileSha256(alias)).toBe(digest);
  expect(inventoryTree(root).find((row) => row.path === specs[0].paths[1])).toMatchObject({ type: 'file', sha256: digest });
});
