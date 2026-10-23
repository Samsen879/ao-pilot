import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileSha256, inventoryTree, objectSha256, durableJson, readJson } from '../../scripts/ao/lib/release-manifest.js';
export function fixtureRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ao-release-test-')); }
export function createBundle(root, { version = '1.0.0', commit = 'a'.repeat(40), native = '#!/bin/sh\nexit 0\n', schema = 43 } = {}) {
  const bundle = path.join(root, `bundle-${version}`); const payload = path.join(bundle, 'payload');
  fs.mkdirSync(payload, { recursive: true });
  for (const [file, bytes] of Object.entries({
    'native/ao': native, 'bin/ao-pilot.js': '#!/usr/bin/env node\n',
    'scripts/ao-release-entry.js': '/* fake immutable launcher */', 'schemas/fixture.json': '{"fixture":true}',
    'scripts/ao-dashboard.js': '/* fake dashboard fixture */', 'scripts/ao-session.js': '/* fake recovery fixture */',
    'adapter/server.mjs': '/* fake adapter test input, not production replacement */',
    'browser/dist.js': '/* fake dashboard build fixture */',
    'browser/packages/web/.next/BUILD_ID': 'fake-build', 'browser/packages/web/dist-server/start-all.js': '/* fake compiled fixture */',
  })) { fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true }); fs.writeFileSync(path.join(payload, file), bytes, { mode: file === 'native/ao' ? 0o755 : 0o644 }); }
  const daemonSha = fileSha256(path.join(payload, 'native/ao'));
  const lock = { runtime_ref: 'fixture.runtime', artifact: { repository: 'https://example.invalid/fixture', version, ref: { commit_sha: 'f'.repeat(40), tree_sha: 'e'.repeat(40) } },
    compatibility: { platforms: [{ os: 'linux', arch: process.arch, binary_sha256: daemonSha }] } };
  fs.mkdirSync(path.join(payload, 'runtime')); durableJson(path.join(payload, 'runtime/agent-orchestrator.lock.json'), lock);
  const files = inventoryTree(payload);
  const scopes = { daemon: ['native/ao'], cli: ['bin/ao-pilot.js', 'scripts/ao-session.js'], dashboard: ['scripts/ao-dashboard.js', 'browser/dist.js'], adapter: ['adapter/server.mjs'] };
  const manifest = {
    schema_version: 'ao.release.v1', release_id: `${version}+${commit}`, version, commit, tree: 'b'.repeat(40), built_at: '2026-10-23T00:00:00.000Z', platform: { os: 'linux', arch: process.arch },
    toolchain: { go: '1.25.7', CGO_ENABLED: '0', node: process.version, npm: '11', git: '2.52.0', tmux: 'tmux 3.5a', node_executable: process.execPath, node_sha256: fileSha256(process.execPath), tmux_executable: process.execPath, tmux_sha256: fileSha256(process.execPath) },
    database: { schema_current: schema, schema_min_readable: schema, schema_max_readable: schema, compatibility_evidence_sha256: '0'.repeat(64), previous_binary_sha256: daemonSha, previous_reader_compatible: true },
    runtime_lock: { runtime_ref: lock.runtime_ref, sha256: fileSha256(path.join(payload, 'runtime/agent-orchestrator.lock.json')), commit: lock.artifact.ref.commit_sha, tree: lock.artifact.ref.tree_sha, binary_sha256: daemonSha },
    components: Object.fromEntries(Object.entries(scopes).map(([name, paths]) => { const records = files.filter((entry) => paths.includes(entry.path)); return [name, { entrypoint: paths[0], files: records, sha256: objectSha256(records), source_commit: commit }]; })),
    inputs: { archive_sha256: '0'.repeat(64), root_lock_sha256: '0'.repeat(64), browser_lock_sha256: '0'.repeat(64), source_import_sha256: '0'.repeat(64), unit_templates_sha256: '0'.repeat(64), adapter_source: 'adapter', adapter_license_sha256: '0'.repeat(64) }, files,
  };
  durableJson(path.join(payload, 'release.json'), manifest);
  const pack = fs.mkdtempSync(path.join(root, 'pack-')); fs.cpSync(payload, path.join(pack, 'package'), { recursive: true });
  execFileSync('tar', ['-czf', path.join(bundle, 'package.tgz'), '-C', pack, 'package']); fs.rmSync(pack, { recursive: true });
  const envelope = { schema_version: 'ao.release-envelope.v1', release_id: manifest.release_id, manifest_sha256: fileSha256(path.join(payload, 'release.json')), npm_tarball_sha256: fileSha256(path.join(bundle, 'package.tgz')), platform: manifest.platform };
  durableJson(path.join(bundle, 'release-envelope.json'), envelope);
  return { bundle, payload, manifest, envelope, envelopeSha: fileSha256(path.join(bundle, 'release-envelope.json')) };
}
export function configuration(root) {
  const state = path.join(root, 'staging'); fs.mkdirSync(state, { recursive: true });
  const config = { schema_version: 'ao.install-config.v1', namespace: 'ao-pilot-staging-fixture', installRoot: path.join(root, 'install'), stateRoot: state,
    unitRoot: path.join(root, 'units'), dataDir: path.join(state, 'data'), discoveryDir: path.join(state, 'discovery'), configPath: path.join(state, 'ao.yaml'),
    controlPlaneRoot: path.join(state, 'control'), trustedHostDirectory: path.join(state, 'trusted-host'), tmuxTmpdir: path.join(state, 'tmux'), tmuxSocket: 'ao-pilot-staging-fixture',
    daemonURL: 'http://127.0.0.1:43001', terminalURL: 'ws://127.0.0.1:43002/terminal', terminalOrigin: 'http://127.0.0.1:43002', terminalCanaryPrefix: 'canary:', listenPorts: [43001, 43000, 43002, 43003, 43004],
    cliPath: path.join(root, 'bin/ao-pilot') };
  fs.writeFileSync(config.configPath, 'fake staging configuration'); return config;
}
export function healthyObservation(manifest, releaseRoot, { generation = 2, schema = manifest.database.schema_current } = {}) {
  const services = Object.fromEntries(['daemon', 'dashboard', 'adapter', 'session-recovery'].map((name, i) => [name, {
    pid: generation * 100 + i, start_token: `token-${generation}-${i}`, stable: true, unit_verified: true,
    release_id: manifest.release_id, release_root: releaseRoot,
    component_sha256: name === 'session-recovery' ? manifest.components.cli.sha256 : manifest.components[name].sha256,
  }]));
  return { native_cids: [{ ao_session_id: 'cid-orchestrator', native_conversation_id: 'native-original-orchestrator' }, { ao_session_id: 'cid-worker', native_conversation_id: 'native-original-worker' }], custody: [], identities: [], cli_bound: true, services, tmux: { level: 'PASS', status: 'ok', server_pid: 99, server_start_token: 'tmux-token', executable_sha256: manifest.toolchain.tmux_sha256 },
    ready: { status: 'ready', ready: true, reasons: [] }, cids: ['cid-worker', 'cid-orchestrator'], database: { schema, integrity: 'ok' },
    linger: true, listeners_loopback: true, terminal_auth: true, ownership_locks: true, lan_disabled: true, trusted_host_disabled: true, tokenless_lock_safe: true };
}
export function fakeRunner(root, { onObserve = null } = {}) {
  const calls = []; let generation = 1;
  return {
    calls,
    async preflight({ releaseRoot, manifest }) { calls.push('preflight'); return healthyObservation(manifest, releaseRoot, { generation }); },
    async backupDatabase({ backupRoot }) { calls.push('backup'); fs.mkdirSync(backupRoot, { recursive: true }); const file = path.join(backupRoot, 'ao.db'); fs.writeFileSync(file, 'fake consistent database backup'); return { path: file, sha256: fileSha256(file), completed_at: '2026-10-23T00:00:00.000Z' }; },
    async quiescent() { calls.push('quiescent'); return { native_cids: [{ ao_session_id: 'cid-orchestrator', native_conversation_id: 'native-original-orchestrator' }, { ao_session_id: 'cid-worker', native_conversation_id: 'native-original-worker' }], custody: [], identities: [], cids: ['cid-worker', 'cid-orchestrator'], database: { schema: 43, integrity: 'ok' } }; },
    async stop() { calls.push('stop'); }, async reload() { calls.push('reload'); },
    async start() { generation += 1; calls.push('start'); },
    async observe({ releaseRoot }) { calls.push('observe'); const manifest = readJson(path.join(releaseRoot, 'release.json')); const observation = healthyObservation(manifest, fs.realpathSync(releaseRoot), { generation }); return onObserve ? onObserve(observation, calls) : observation; },
    async restoreDatabase() { calls.push('restore_database'); }, async pins() { return []; },
  };
}
