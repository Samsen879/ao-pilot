#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertManagedReleaseEnvironment } from './ao/lib/release-runtime.js';
import { assertRelease, fileSha256, verifyReleaseTree } from './ao/lib/release-manifest.js';
import { managedBindingsPath } from './ao/lib/session-recovery.js';

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
const environment = { ...process.env, AO_RELEASE_ID: manifest.release_id, AO_RELEASE_ROOT: release,
  AO_MANAGED_RUNTIME_BINARY: path.join(release, manifest.components.daemon.entrypoint),
  AO_MANAGED_RUNTIME_BINARY_SHA256: manifest.components.daemon.files.find((file) => file.path === manifest.components.daemon.entrypoint).sha256 };
assertManagedReleaseEnvironment(environment, release);
if (component === 'session-recovery') args.push('--bindings', managedBindingsPath(environment.AO_MANAGED_RUNTIME_DATA_DIR));
if (component === 'adapter') {
  // The reviewed JSON is authoritative; inherited site variables cannot silently
  // override its upstreams or enable an unexpected listener.
  for (const key of ['LISTEN_HOST', 'LISTEN_PORT', 'DASHBOARD_UPSTREAM_HOST', 'DASHBOARD_UPSTREAM_PORT', 'AO_DAEMON_HOST', 'AO_DAEMON_PORT',
    'DIRECT_TERMINAL_HOST', 'DIRECT_TERMINAL_PORT', 'DIRECT_TERMINAL_BROWSER_PORT', 'TERMINAL_ORIGIN', 'PROJECT_NAME', 'ISSUE_BASE_URL']) delete environment[key];
}
process.execve(command, [command, ...args], environment);
