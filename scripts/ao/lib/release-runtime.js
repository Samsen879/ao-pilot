import fs from 'node:fs';
import path from 'node:path';
import { assertRelease, fileSha256, readJson, verifyReleaseTree } from './release-manifest.js';
export function resolveUnifiedRuntime({ env = process.env } = {}) {
  assertRelease(path.isAbsolute(env.AO_INSTALL_ROOT ?? ''), 'unified_installation_required');
  const root = fs.realpathSync(path.join(env.AO_INSTALL_ROOT, 'current'));
  assertRelease(root.startsWith(`${fs.realpathSync(env.AO_INSTALL_ROOT)}/releases/`), 'unsafe_install_pointer');
  const manifest = verifyReleaseTree(root);
  const binary = path.join(root, manifest.components.daemon.entrypoint);
  const lockPath = path.join(root, 'runtime/agent-orchestrator.lock.json'); const lock = readJson(lockPath);
  const platform = lock.compatibility?.platforms?.find((entry) => entry.os === 'linux' && entry.arch === process.arch);
  assertRelease(platform && fileSha256(lockPath) === manifest.runtime_lock.sha256
    && platform.binary_sha256 === manifest.runtime_lock.binary_sha256 && fileSha256(binary) === platform.binary_sha256, 'installed_runtime_lock_drift');
  return {
    runtime_ref: lock.runtime_ref, lock_digest: manifest.runtime_lock.sha256, runtime_directory: root,
    provenance_path: path.join(root, 'release.json'), bootstrap_receipt_path: path.join(root, 'release.json'),
    binary_path: binary, binary_sha256: fileSha256(binary), store_root: env.AO_INSTALL_ROOT,
    source: { repository: lock.artifact.repository, version: lock.artifact.version, tag: lock.artifact.ref.name,
      commit_sha: lock.artifact.ref.commit_sha, tree_sha: lock.artifact.ref.tree_sha, integrity: lock.artifact.integrity },
    compatibility: lock.compatibility, path_candidate: null, manifest,
  };
}
