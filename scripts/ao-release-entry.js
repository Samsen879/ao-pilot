#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRelease, fileSha256, verifyReleaseTree } from './ao/lib/release-manifest.js';

// Resolve once before any component imports. All subsequent paths are pinned.
const release = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const manifest = verifyReleaseTree(release);
const component = process.argv[2];
assertRelease(['daemon', 'dashboard', 'adapter', 'session-recovery'].includes(component), 'invalid_release_component');
assertRelease(fileSha256(manifest.toolchain.node_executable) === manifest.toolchain.node_sha256, 'release_external_binary_drift');
const entry = component === 'session-recovery' ? 'scripts/ao-session.js' : manifest.components[component].entrypoint;
const command = component === 'daemon' ? path.join(release, entry) : manifest.toolchain.node_executable;
const args = component === 'daemon' ? ['daemon'] : [path.join(release, entry), ...(component === 'session-recovery' ? ['serve'] : [])];
assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
process.chdir(release);
process.execve(command, [command, ...args], { ...process.env,
  AO_RELEASE_ID: manifest.release_id, AO_RELEASE_ROOT: release });
