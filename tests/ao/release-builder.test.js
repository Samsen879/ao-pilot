import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from '@jest/globals';
import { buildRelease, releaseCommand, verifyReleaseEnvelope } from '../../scripts/ao/lib/release-builder.js';
import { durableJson, fileSha256, readJson, sha256, verifyReleaseTree } from '../../scripts/ao/lib/release-manifest.js';
import { fixtureRoot } from './release-fixture.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fixtureRoot(); roots.push(root); const repository = path.join(root, 'repo'); fs.mkdirSync(repository);
  const native = '#!/bin/sh\n# fake build output fixture\nexit 0\n';
  const files = {
    'package.json': JSON.stringify({ name: 'ao-fixture', version: '1.0.0', files: ['bin', 'scripts', 'browser', 'adapter', 'runtime', 'templates'] }),
    'package-lock.json': '{"lockfileVersion":3}', 'browser/package-lock.json': '{"fixture":true}', 'browser/SOURCE_IMPORT.json': '{}',
    'runtime/headless/backend/internal/storage/sqlite/migrations/0043_fixture.sql': '-- schema fixture',
    'bin/ao-pilot.js': '/* fake CLI */', 'scripts/ao-dashboard.js': '/* fake dashboard */', 'scripts/verify-package-install.js': '/* fake consumer verifier invoked by test runner */',
    'adapter/server.mjs': '/* fake adapter input solely for fixture */', 'adapter/LICENSE': 'fixture public domain',
    'templates/systemd/ao-pilot-runtime.service': '[Service]\nExecStart={{CURRENT}}/native/ao',
  };
  for (const [file, content] of Object.entries(files)) { const absolute = path.join(repository, file); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); }
  durableJson(path.join(repository, 'runtime/agent-orchestrator.lock.json'), { runtime_ref: 'fixture.runtime', artifact: { ref: { commit_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40) } }, compatibility: { platforms: [{ os: 'linux', arch: process.arch, binary_sha256: sha256(native) }] } });
  durableJson(path.join(repository, 'release/compatibility.json'), { schema_version: 'ao.schema-compatibility.v1', result: 'passed', old_reader_result: 'passed', old_binary_sha256: '0'.repeat(64), candidate_binary_sha256: sha256(native), schema_current: 43, schema_min_readable: 43, schema_max_readable: 43 });
  releaseCommand('git', ['init', '--quiet'], { cwd: repository }); releaseCommand('git', ['add', '.'], { cwd: repository });
  releaseCommand('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'], { cwd: repository });
  const tools = path.join(root, 'tools'); fs.mkdirSync(tools); fs.writeFileSync(path.join(tools, 'tmux'), '#!/bin/sh\necho tmux 3.5a\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}` }; const calls = [];
  const run = (command, args, settings = {}) => {
    calls.push([command, args]);
    if (command === 'go' && args[0] === 'version') return 'go version go1.25.7 linux/amd64';
    if (command === 'go' && args[0] === 'build') { expect(settings.env.CGO_ENABLED).toBe('0'); fs.writeFileSync(args[args.indexOf('-o') + 1], native, { mode: 0o755 }); return ''; }
    if (command === 'npm' && args[0] === 'ci') { fs.mkdirSync(path.join(settings.cwd, 'node_modules'), { recursive: true }); fs.writeFileSync(path.join(settings.cwd, 'node_modules/fixture.txt'), 'fixture dependency bytes'); return ''; }
    if (command === 'npm' && args[0] === 'run') {
      fs.mkdirSync(path.join(settings.cwd, 'packages/web/.next'), { recursive: true }); fs.writeFileSync(path.join(settings.cwd, 'packages/web/.next/BUILD_ID'), 'fixture-build');
      fs.mkdirSync(path.join(settings.cwd, 'packages/web/dist-server'), { recursive: true }); fs.writeFileSync(path.join(settings.cwd, 'packages/web/dist-server/start-all.js'), '/* fake compiled output */'); return '';
    }
    if (command === process.execPath && args[0].endsWith('verify-package-install.js')) {
      expect(args[1]).toBe('--tarball'); expect(args[3]).toBe('--sha256'); expect(fileSha256(args[2])).toBe(args[4]);
      return '{"status":"pass"}';
    }
    return releaseCommand(command, args, settings);
  };
  return { root, repository, env, calls, run, output: path.join(root, 'output'), adapter: { root: 'adapter', entrypoint: 'adapter/server.mjs', license: 'adapter/LICENSE' }, version: '1.0.0' };
}
it('exports immutable archive and packs once; verifier and installer consume the same pinned bytes', async () => {
  const options = fixture(); fs.writeFileSync(path.join(options.repository, 'WORKTREE_ONLY'), 'must never ship'); fs.writeFileSync(path.join(options.repository, 'package-lock.json'), 'dirty root lock');
  if (typeof process.execve !== 'function') { await expect(buildRelease(options)).rejects.toMatchObject({ code: 'release_node_execve_required' }); return; }
  const result = await buildRelease(options); const { manifest, envelope } = verifyReleaseEnvelope(result.bundle, result.envelope_sha256);
  expect(manifest.files.some((file) => file.path === 'WORKTREE_ONLY')).toBe(false);
  expect(manifest.inputs.root_lock_sha256).toBe(sha256('{"lockfileVersion":3}'));
  expect(options.calls.filter(([command, args]) => command === 'npm' && args[0] === 'pack')).toHaveLength(1);
  expect(envelope.npm_tarball_sha256).toBe(result.npm_tarball_sha256);
  expect(verifyReleaseTree(path.join(result.bundle, 'payload')).components.adapter.entrypoint).toBe('adapter/server.mjs');
});
it('missing adapter rejects a complete release without inventing recovery replacement', async () => {
  const options = fixture();
  await expect(buildRelease({ ...options, adapter: null })).rejects.toMatchObject({ code: typeof process.execve === 'function' ? 'release_adapter_source_missing' : 'release_node_execve_required' });
  expect(options.calls.some(([command, args]) => command === 'npm' && args[0] === 'ci')).toBe(false);
});
it.each(['/etc/passwd', '../../outside'])('rejects an archive symlink before dependency/build execution: %s', async (target) => {
  const options = fixture(); fs.symlinkSync(target, path.join(options.repository, 'outside'));
  releaseCommand('git', ['add', 'outside'], { cwd: options.repository }); releaseCommand('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'unsafe fixture'], { cwd: options.repository });
  await expect(buildRelease(options)).rejects.toMatchObject({ code: typeof process.execve === 'function' ? 'escaping_release_symlink' : 'release_node_execve_required' });
  expect(options.calls.some(([command, args]) => command === 'npm' && args[0] === 'ci')).toBe(false);
});
it('build failure permits retry of the identical release, and a root-lock-only commit changes binding', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  await expect(buildRelease({ ...options, onStage: (stage) => { if (stage === 'dashboard') throw Error('injected build failure'); } })).rejects.toThrow('injected');
  const first = await buildRelease(options);
  const oldManifest = readJson(path.join(first.bundle, 'payload/release.json'));
  fs.writeFileSync(path.join(options.repository, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
  releaseCommand('git', ['add', 'package-lock.json'], { cwd: options.repository }); releaseCommand('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'lock only'], { cwd: options.repository });
  const next = await buildRelease(options); const nextManifest = readJson(path.join(next.bundle, 'payload/release.json'));
  expect(nextManifest.inputs.root_lock_sha256).not.toBe(oldManifest.inputs.root_lock_sha256);
  expect(nextManifest.commit).not.toBe(oldManifest.commit);
  expect(nextManifest.runtime_lock.binary_sha256).toBe(oldManifest.runtime_lock.binary_sha256);
});
