#!/usr/bin/env node

import fs from 'node:fs';

import { loadBootstrapToolchainLock } from './ao/lib/runtime-bootstrap-contract.js';
import { getDefaultRuntimeCache, getDefaultRuntimeStore } from './ao/lib/runtime-bootstrap.js';
import { loadRuntimeLock } from './ao/lib/runtime-lock.js';

const runtime = loadRuntimeLock();
const toolchain = loadBootstrapToolchainLock();
if (runtime.lock.build.toolchain.name !== toolchain.lock.name) {
  throw new Error('Runtime and bootstrap toolchain names differ');
}
if (runtime.lock.build.toolchain.version !== toolchain.lock.version) {
  throw new Error('Runtime and bootstrap toolchain versions differ');
}
for (const target of runtime.lock.compatibility.platforms) {
  if (!toolchain.lock.platforms.some(
    (candidate) => candidate.os === target.os && candidate.arch === target.arch,
  )) {
    throw new Error(`Missing bootstrap toolchain for ${target.os}-${target.arch}`);
  }
}
const entrypoint = new URL('./bootstrap.sh', import.meta.url);
const stat = fs.statSync(entrypoint);
if (!stat.isFile() || (stat.mode & 0o111) === 0) {
  throw new Error('scripts/bootstrap.sh is not executable');
}

process.stdout.write(`${JSON.stringify({
  status: 'verified',
  scope: 'bootstrap_contract_and_entrypoint',
  runtime_ref: runtime.lock.runtime_ref,
  runtime_lock_digest: runtime.digest,
  toolchain: {
    name: toolchain.lock.name,
    version: toolchain.lock.version,
    lock_digest: toolchain.digest,
    platforms: toolchain.lock.platforms.map((item) => ({
      os: item.os,
      arch: item.arch,
      archive: item.filename,
      sha256: item.sha256,
    })),
  },
  default_store: getDefaultRuntimeStore(),
  default_cache: getDefaultRuntimeCache(),
  entrypoint: 'scripts/bootstrap.sh',
  live_install_claim: false,
}, null, 2)}\n`);
