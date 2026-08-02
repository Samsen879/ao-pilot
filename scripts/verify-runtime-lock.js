#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeLock } from './ao/lib/runtime-lock.js';

export function verifyRuntimeLock({ lockPath = null } = {}) {
  const loaded = loadRuntimeLock(lockPath == null ? {} : { lockPath });
  const { lock } = loaded;
  return {
    status: 'verified',
    schema_version: lock.schema_version,
    runtime_ref: lock.runtime_ref,
    lock_path: loaded.path,
    lock_digest: loaded.digest,
    artifact: {
      kind: lock.artifact.kind,
      repository: lock.artifact.repository,
      upstream_repository: lock.artifact.upstream_repository,
      version: lock.artifact.version,
      package: lock.artifact.package,
      tag: lock.artifact.ref.name,
      tag_object_sha: lock.artifact.ref.tag_object_sha,
      commit_sha: lock.artifact.ref.commit_sha,
      tree_sha: lock.artifact.ref.tree_sha,
      integrity: lock.artifact.integrity,
    },
    build: lock.build,
    binary: lock.binary,
    compatibility: lock.compatibility,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    process.stdout.write(`${JSON.stringify(verifyRuntimeLock(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Runtime lock verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
