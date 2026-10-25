import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { bindPackedRuntime, parseArgs, verifyFreshClone } from '../../scripts/verify-fresh-clone.js';
import { candidateRuntimeRef } from '../../scripts/ao/lib/release-runtime.js';
import { durableJson, fileSha256, inventoryTree, objectSha256, readJson } from '../../scripts/ao/lib/release-manifest.js';
import { createBundle, fixtureRoot } from './release-fixture.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fixtureRoot(); roots.push(root);
  const { payload, manifest } = createBundle(root);
  const lock = readJson(new URL('../../runtime/agent-orchestrator.lock.json', import.meta.url));
  durableJson(path.join(payload, 'runtime/agent-orchestrator.lock.json'), lock);
  const pin = { schema_version: 'ao.release-runtime-pin.v1', release_id: manifest.release_id, version: manifest.version,
    runtime_ref: candidateRuntimeRef(manifest.version), commit: manifest.commit, tree: manifest.tree,
    platform: manifest.platform, binary_sha256: fileSha256(path.join(payload, 'native/ao')),
    source_lock_sha256: fileSha256(path.join(payload, 'runtime/agent-orchestrator.lock.json')) };
  durableJson(path.join(payload, 'release/runtime-pin.json'), pin);
  manifest.runtime_lock = { kind: 'candidate', runtime_ref: pin.runtime_ref,
    sha256: fileSha256(path.join(payload, 'release/runtime-pin.json')), commit: pin.commit,
    tree: pin.tree, binary_sha256: pin.binary_sha256 };
  manifest.files = inventoryTree(payload).filter(file => file.path !== 'release.json');
  durableJson(path.join(payload, 'release.json'), manifest);
  return { root, packageRoot: payload, installedPackageRoot: payload, manifest, pin, env: { AO_DATA_DIR: path.join(root, 'native-data'),
    AO_RUN_FILE: path.join(root, 'discovery/running.json'), HOME: path.join(root, 'home') },
  expectedHead: manifest.commit, expectedTree: manifest.tree };
}
it('binds lifecycle to the packed candidate instead of the distinct archived bootstrap lock', () => {
  const input = fixture();
  const bound = bindPackedRuntime(input);
  expect(bound.runtime.binary_path).toBe(bound.env.AO_MANAGED_RUNTIME_BINARY);
  expect(bound.runtime.binary_sha256).toBe(input.pin.binary_sha256);
  expect(bound.runtime.source.commit_sha).toBe(input.expectedHead);
  expect(bound.runtime.source.tree_sha).toBe(input.expectedTree);
  expect(bound.runtime.source_runtime_lock.commit_sha).not.toBe(input.expectedHead);
  expect(bound.cli).toBe(path.join(input.installedPackageRoot, 'bin/ao-pilot.js'));
  expect(readJson(path.join(bound.storeRoot, 'installation.json')).namespace).toBe('ao-pilot-staging-fresh');
  expect(bound.env.AO_PORT).toBe('43101');
  expect(bound.env.AO_TMUX_SOCKET).not.toBe('default');
  expect(fs.realpathSync(path.join(bound.storeRoot, 'current'))).toBe(bound.runtime.runtime_directory);
});
it('requires the complete payload instead of treating npm-omitted dependency bytes as verified', async () => {
  const options = parseArgs(['--tarball', '/abs/package.tgz', '--sha256', 'a'.repeat(64)]);
  options.releasePayload = null;
  await expect(verifyFreshClone(options)).rejects.toMatchObject({ code: 'fresh_clone_release_payload_required' });
  expect(parseArgs(['--release-payload', '/abs/payload']).releasePayload).toBe('/abs/payload');
});
it('rejects an installed CLI drift even while the complete payload remains valid', () => {
  const input = fixture(); input.installedPackageRoot = path.join(input.root, 'npm-consumer');
  fs.cpSync(input.packageRoot, input.installedPackageRoot, { recursive: true });
  fs.appendFileSync(path.join(input.installedPackageRoot, 'bin/ao-pilot.js'), 'drift');
  expect(() => bindPackedRuntime(input)).toThrow('Installed package differs');
  expect(fs.existsSync(path.join(input.root, 'packed-install'))).toBe(false);
});
it.each(['expectedHead', 'expectedTree'])('rejects a different package %s before installing or starting it', (field) => {
  const input = fixture(); input[field] = 'c'.repeat(40);
  expect(() => bindPackedRuntime(input)).toThrow('Package does not match');
  expect(fs.existsSync(input.packageRoot)).toBe(true);
  expect(fs.existsSync(path.join(input.root, 'packed-install'))).toBe(false);
});
it('rejects a changed packed binary before installing it', () => {
  const input = fixture(); fs.appendFileSync(path.join(input.packageRoot, 'native/ao'), 'drift');
  expect(() => bindPackedRuntime(input)).toThrow();
  expect(fs.existsSync(path.join(input.root, 'packed-install'))).toBe(false);
});
it('rejects a rebound inventory whose candidate pin points to a different source', () => {
  const input = fixture(); input.pin.commit = 'c'.repeat(40);
  durableJson(path.join(input.packageRoot, 'release/runtime-pin.json'), input.pin);
  input.manifest.runtime_lock.sha256 = fileSha256(path.join(input.packageRoot, 'release/runtime-pin.json'));
  input.manifest.files = inventoryTree(input.packageRoot).filter(file => file.path !== 'release.json');
  // The pin stays outside this small fixture's CLI scope, as in createBundle.
  expect(objectSha256(input.manifest.components.cli.files)).toBe(input.manifest.components.cli.sha256);
  durableJson(path.join(input.packageRoot, 'release.json'), input.manifest);
  expect(() => bindPackedRuntime(input)).toThrow('installed_runtime_lock_drift');
});
it('rejects an inherited production data path rather than borrowing its namespace', () => {
  const input = fixture(); input.env.AO_DATA_DIR = path.join(path.dirname(input.root), 'foreign-data');
  expect(() => bindPackedRuntime(input)).toThrow('install_namespace_collision');
  expect(fs.existsSync(path.join(input.root, 'packed-install'))).toBe(false);
});
