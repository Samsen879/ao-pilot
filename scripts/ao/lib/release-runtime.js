import fs from 'node:fs';
import path from 'node:path';
import { assertRelease, fileSha256, objectSha256, readJson, verifyReleaseTree } from './release-manifest.js';
import { normalizeRuntimeLock } from './runtime-lock.js';

export const CANDIDATE_RUNTIME_PIN = 'release/runtime-pin.json';
export const candidateRuntimeRef = (version) => `runtime.ao_pilot_headless.v${version.replace(/[^A-Za-z0-9]/g, '_')}`;
export function assertManagedReleaseEnvironment(env, root) {
  assertRelease(path.isAbsolute(env.AO_INSTALL_ROOT ?? '') && root.startsWith(`${env.AO_INSTALL_ROOT}/releases/`)
    && path.isAbsolute(env.AO_DATA_DIR ?? '') && env.AO_MANAGED_RUNTIME_DATA_DIR === env.AO_DATA_DIR
    && path.isAbsolute(env.AO_RUN_FILE ?? '') && env.AO_MANAGED_RUNTIME_RUN_FILE === env.AO_RUN_FILE
    && /^[A-Za-z0-9_-]+$/.test(env.AO_TMUX_SOCKET ?? '') && env.AO_TMUX_SOCKET !== 'default'
    && /^ao-pilot(?:-staging-[a-z0-9-]+)?$/.test(env.AO_INSTALL_NAMESPACE ?? '')
    && env.AO_TMUX_UNIT === `${env.AO_INSTALL_NAMESPACE}-tmux.service`
    && path.isAbsolute(env.AO_TMUX_TMPDIR ?? '') && env.TMUX_TMPDIR === env.AO_TMUX_TMPDIR,
  'release_managed_environment_incomplete');
}
export function assertRuntimeLockArtifact(root, manifest) {
  const binary = path.join(root, manifest.components.daemon.entrypoint);
  const lockPath = path.join(root, 'runtime/agent-orchestrator.lock.json'); const lock = readJson(lockPath);
  if (manifest.runtime_lock.kind === 'candidate') {
    const pinPath = path.join(root, CANDIDATE_RUNTIME_PIN); const pin = readJson(pinPath);
    const entry = manifest.components.daemon.files.find((file) => file.path === manifest.components.daemon.entrypoint);
    assertRelease(Object.keys(pin).sort().join(',') === 'binary_sha256,commit,platform,release_id,runtime_ref,schema_version,source_lock_sha256,tree,version'
      && pin.schema_version === 'ao.release-runtime-pin.v1'
      && fileSha256(pinPath) === manifest.runtime_lock.sha256
      && pin.release_id === manifest.release_id && pin.version === manifest.version
      && pin.commit === manifest.commit && pin.commit === manifest.runtime_lock.commit
      && pin.tree === manifest.tree && pin.tree === manifest.runtime_lock.tree
      && pin.runtime_ref === candidateRuntimeRef(manifest.version) && pin.runtime_ref === manifest.runtime_lock.runtime_ref
      && objectSha256(pin.platform) === objectSha256(manifest.platform)
      && pin.platform.os === process.platform && pin.platform.arch === process.arch
      && pin.binary_sha256 === manifest.runtime_lock.binary_sha256 && pin.binary_sha256 === entry?.sha256
      && manifest.components.daemon.source_commit === manifest.commit
      && fileSha256(binary) === pin.binary_sha256
      && /^[a-f0-9]{64}$/.test(pin.source_lock_sha256 ?? '') && fileSha256(lockPath) === pin.source_lock_sha256,
    'installed_runtime_lock_drift');
    // The archived bootstrap lock remains an unchanged, strict annotated-tag
    // input. It must never be rewritten to pretend the candidate has a tag.
    try { normalizeRuntimeLock(lock); } catch { assertRelease(false, 'installed_runtime_lock_drift'); }
    return { binary, lock, pin };
  }
  assertRelease(manifest.runtime_lock.kind === undefined, 'installed_runtime_lock_drift');
  const platform = lock.compatibility?.platforms?.find((entry) => entry.os === 'linux' && entry.arch === process.arch);
  assertRelease(platform && fileSha256(lockPath) === manifest.runtime_lock.sha256
    && platform.binary_sha256 === manifest.runtime_lock.binary_sha256 && fileSha256(binary) === platform.binary_sha256
    && lock.artifact.ref.commit_sha === manifest.runtime_lock.commit && lock.artifact.ref.tree_sha === manifest.runtime_lock.tree,
  'installed_runtime_lock_drift');
  return { binary, lock };
}
export function resolveUnifiedRuntime({ env = process.env } = {}) {
  assertRelease(path.isAbsolute(env.AO_INSTALL_ROOT ?? ''), 'unified_installation_required');
  const root = fs.realpathSync(path.join(env.AO_INSTALL_ROOT, 'current'));
  assertRelease(root.startsWith(`${fs.realpathSync(env.AO_INSTALL_ROOT)}/releases/`), 'unsafe_install_pointer');
  const manifest = verifyReleaseTree(root);
  const { binary, lock, pin } = assertRuntimeLockArtifact(root, manifest);
  return {
    runtime_ref: pin?.runtime_ref ?? lock.runtime_ref, lock_digest: manifest.runtime_lock.sha256, runtime_directory: root,
    provenance_path: path.join(root, 'release.json'), bootstrap_receipt_path: path.join(root, 'release.json'),
    binary_path: binary, binary_sha256: fileSha256(binary), store_root: env.AO_INSTALL_ROOT,
    source: pin ? { repository: lock.artifact.repository, version: pin.version, tag: null,
      commit_sha: pin.commit, tree_sha: pin.tree, integrity: { algorithm: 'git-tree-sha1', digest: pin.tree } }
      : { repository: lock.artifact.repository, version: lock.artifact.version, tag: lock.artifact.ref.name,
        commit_sha: lock.artifact.ref.commit_sha, tree_sha: lock.artifact.ref.tree_sha, integrity: lock.artifact.integrity },
    compatibility: pin ? { ...lock.compatibility, platforms: [{ ...pin.platform, binary_sha256: pin.binary_sha256 }] } : lock.compatibility,
    ...(pin ? { source_runtime_lock: { runtime_ref: lock.runtime_ref, sha256: pin.source_lock_sha256,
      commit_sha: lock.artifact.ref.commit_sha, tag: lock.artifact.ref.name } } : {}),
    path_candidate: null, manifest,
  };
}
