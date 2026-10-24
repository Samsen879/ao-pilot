import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { assertRuntimeLockArtifact, CANDIDATE_RUNTIME_PIN, candidateRuntimeRef } from '../../scripts/ao/lib/release-runtime.js';
import { durableJson, fileSha256, readJson } from '../../scripts/ao/lib/release-manifest.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-runtime-pin-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'native')); fs.writeFileSync(path.join(root, 'native/ao'), 'new candidate binary');
  const lock = readJson(new URL('../../runtime/agent-orchestrator.lock.json', import.meta.url));
  durableJson(path.join(root, 'runtime/agent-orchestrator.lock.json'), lock);
  const commit = 'a'.repeat(40), tree = 'b'.repeat(40), version = '0.12.0-p0.1';
  const sha = fileSha256(path.join(root, 'native/ao'));
  const pin = { schema_version: 'ao.release-runtime-pin.v1', release_id: `${version}+${commit}`, version,
    runtime_ref: candidateRuntimeRef(version), commit, tree, platform: { os: 'linux', arch: process.arch }, binary_sha256: sha,
    source_lock_sha256: fileSha256(path.join(root, 'runtime/agent-orchestrator.lock.json')) };
  durableJson(path.join(root, CANDIDATE_RUNTIME_PIN), pin);
  const manifest = { version, release_id: pin.release_id, commit, tree, platform: pin.platform,
    components: { daemon: { entrypoint: 'native/ao', source_commit: commit, files: [{ path: 'native/ao', sha256: sha }] } },
    runtime_lock: { kind: 'candidate', runtime_ref: pin.runtime_ref, sha256: fileSha256(path.join(root, CANDIDATE_RUNTIME_PIN)), commit, tree, binary_sha256: sha } };
  return { root, pin, lock, manifest };
}
it('accepts a fully bound candidate while preserving the distinct strict annotated-tag input', () => {
  const { root, manifest, lock } = fixture();
  expect(lock.compatibility.platforms[0].binary_sha256).not.toBe(manifest.runtime_lock.binary_sha256);
  expect(assertRuntimeLockArtifact(root, manifest).pin.commit).toBe(manifest.commit);
  expect(readJson(path.join(root, 'runtime/agent-orchestrator.lock.json'))).toEqual(lock);
});
it.each(['release_id', 'version', 'runtime_ref', 'commit', 'tree', 'platform', 'binary_sha256', 'source_lock_sha256', 'schema_version', 'extra'])('rejects a mismatched pin %s even when its file digest is rebound', (key) => {
  const { root, pin, manifest } = fixture();
  pin[key] = key === 'platform' ? { os: 'linux', arch: 'wrong' } : 'wrong';
  durableJson(path.join(root, CANDIDATE_RUNTIME_PIN), pin);
  manifest.runtime_lock.sha256 = fileSha256(path.join(root, CANDIDATE_RUNTIME_PIN));
  expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow('installed_runtime_lock_drift');
});
it.each(['native/ao', CANDIDATE_RUNTIME_PIN, 'runtime/agent-orchestrator.lock.json'])('rejects changed on-disk %s', (file) => {
  const { root, manifest } = fixture(); fs.appendFileSync(path.join(root, file), 'changed');
  expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow();
});
it('keeps strict legacy binary-lock matching when candidate kind is absent', () => {
  const { root, manifest, lock } = fixture(); delete manifest.runtime_lock.kind;
  manifest.runtime_lock = { runtime_ref: lock.runtime_ref, sha256: fileSha256(path.join(root, 'runtime/agent-orchestrator.lock.json')),
    commit: lock.artifact.ref.commit_sha, tree: lock.artifact.ref.tree_sha,
    binary_sha256: lock.compatibility.platforms.find((p) => p.arch === process.arch).binary_sha256 };
  expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow('installed_runtime_lock_drift');
});
it('rejects an unknown kind, a forged source component or an invalid annotated-tag input', () => {
  const { root, manifest, pin, lock } = fixture();
  manifest.runtime_lock.kind = 'unknown'; expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow('installed_runtime_lock_drift');
  manifest.runtime_lock.kind = 'candidate'; manifest.components.daemon.source_commit = 'c'.repeat(40);
  expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow('installed_runtime_lock_drift');
  manifest.components.daemon.source_commit = manifest.commit; lock.artifact.ref.kind = 'commit';
  durableJson(path.join(root, 'runtime/agent-orchestrator.lock.json'), lock);
  pin.source_lock_sha256 = fileSha256(path.join(root, 'runtime/agent-orchestrator.lock.json'));
  durableJson(path.join(root, CANDIDATE_RUNTIME_PIN), pin); manifest.runtime_lock.sha256 = fileSha256(path.join(root, CANDIDATE_RUNTIME_PIN));
  expect(() => assertRuntimeLockArtifact(root, manifest)).toThrow('installed_runtime_lock_drift');
});
