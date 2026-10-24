import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from '@jest/globals';
import { buildRelease, releaseCommand, verifyReleaseEnvelope } from '../../scripts/ao/lib/release-builder.js';
import { durableJson, fileSha256, readJson, sha256, verifyReleaseTree } from '../../scripts/ao/lib/release-manifest.js';
import { fixtureRoot, createBundle } from './release-fixture.js';
import { registeredReleaseFiles } from '../../scripts/ao/lib/release-inputs.js';
import { packedFiles } from '../../scripts/ao/lib/release-tarball.js';
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
    'scripts/verify-schema-compatibility.js': '/* fake harness fixture, test injects process runner */',
    'release/fixture/ao.db': 'explicit fake SQLite fixture bytes for injected runner',
    'adapter/server.mjs': '/* fake adapter input solely for fixture */', 'adapter/LICENSE': 'fixture public domain',
    'templates/systemd/ao-pilot-runtime.service': '[Service]\nExecStart={{CURRENT}}/native/ao',
  };
  for (const [file, content] of Object.entries(files)) { const absolute = path.join(repository, file); fs.mkdirSync(path.dirname(absolute), { recursive: true }); fs.writeFileSync(absolute, content); }
  durableJson(path.join(repository, 'runtime/agent-orchestrator.lock.json'), { runtime_ref: 'fixture.runtime', artifact: { ref: { commit_sha: 'a'.repeat(40), tree_sha: 'b'.repeat(40) } }, compatibility: { platforms: [{ os: 'linux', arch: process.arch, binary_sha256: sha256(native) }] } });
  const oldBinary = path.join(root, 'old-native-artifact'); fs.writeFileSync(oldBinary, native, { mode: 0o755 });
  durableJson(path.join(repository, 'release/compatibility.json'), { schema_version: 'ao.schema-compatibility-input.v1',
    old_binary_sha256: fileSha256(oldBinary), fixture_database: 'release/fixture/ao.db',
    fixture_sha256: fileSha256(path.join(repository, 'release/fixture/ao.db')) });
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
    if (command === process.execPath && args[0].endsWith('verify-schema-compatibility.js')) {
      const value = (name) => args[args.indexOf(name) + 1];
      durableJson(value('--output'), { schema_version: 'ao.schema-compatibility-result.v1', candidate_binary_sha256: fileSha256(value('--candidate')),
        old_binary_sha256: fileSha256(value('--old')), fixture_sha256: fileSha256(value('--fixture')), schema_before: 43, schema_after: 43,
        candidate_result: 'passed', old_reader_result: 'passed', integrity: 'ok', schema_sha256: '0'.repeat(64) });
      return '';
    }
    if (command === process.execPath && args[0].endsWith('verify-package-install.js')) {
      expect(args[1]).toBe('--tarball'); expect(args[3]).toBe('--sha256'); expect(fileSha256(args[2])).toBe(args[4]);
      return '{"status":"pass"}';
    }
    return releaseCommand(command, args, settings);
  };
  return { root, repository, env, calls, run, oldBinary, output: path.join(root, 'output'), adapter: { root: 'adapter', entrypoint: 'adapter/server.mjs', license: 'adapter/LICENSE' }, version: '1.0.0' };
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
it('packs literal dynamic routes and required browser build output with the real npm ignore rules', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  const routes = [
    'api/prs/[id]/merge/route.ts', 'api/sessions/[id]/kill/route.ts',
    'api/sessions/[id]/message/route.ts', 'api/sessions/[id]/remap/route.ts',
    'api/sessions/[id]/restore/route.ts', 'api/sessions/[id]/route.ts',
    'api/sessions/[id]/send/route.ts', 'api/webhooks/[...slug]/route.ts', 'sessions/[id]/page.tsx',
  ].map((name) => `browser/packages/web/src/app/${name}`);
  for (const file of routes) {
    fs.mkdirSync(path.dirname(path.join(options.repository, file)), { recursive: true });
    fs.writeFileSync(path.join(options.repository, file), `/* ${file} */`);
  }
  fs.copyFileSync(new URL('../../browser/.npmignore', import.meta.url), path.join(options.repository, 'browser/.npmignore'));
  releaseCommand('git', ['add', '.'], { cwd: options.repository });
  releaseCommand('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'actual browser ignore and route inputs'], { cwd: options.repository });
  const generated = ['browser/packages/core/dist/index.js', 'browser/packages/web/.next/server/app/sessions/[id]/page.js'];
  const result = await buildRelease({ ...options, onStage: (stage, source) => {
    if (stage !== 'dashboard') return;
    for (const file of generated) {
      fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      fs.writeFileSync(path.join(source, file), `/* ${file} */`);
    }
  } });
  verifyReleaseEnvelope(result.bundle, result.envelope_sha256);
  const packed = packedFiles(path.join(result.bundle, 'package.tgz'));
  for (const file of [...routes, ...generated, 'browser/packages/web/.next/BUILD_ID', 'browser/packages/web/dist-server/start-all.js']) {
    expect(packed.get(file)?.type).toBe('file');
  }
  expect(options.calls.filter(([command, args]) => command === 'npm' && args[0] === 'pack')).toHaveLength(1);
});
it('persists the complete private inventory diagnosis before cleanup without packing or changing the failure', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  const diagnosticsFile = path.join(options.root, 'private-diagnostics.json');
  await expect(buildRelease({ ...options, diagnosticsFile, onStage: (stage, source) => {
    if (stage === 'root_dependencies') fs.linkSync(path.join(source, 'node_modules/fixture.txt'), path.join(source, 'node_modules/linked.txt'));
  } })).rejects.toMatchObject({ code: 'unsupported_release_file' });
  expect(readJson(diagnosticsFile)).toMatchObject({ schema_version: 'ao.release-build-diagnostics.v1', phase: 'built_payload', result: 'FAIL',
    failure_code: 'unsupported_release_file', violation_count: 2, violations: [
      { path: 'node_modules/fixture.txt', reason: 'multiple_links', type: 'file', nlink: 2 },
      { path: 'node_modules/linked.txt', reason: 'multiple_links', type: 'file', nlink: 2 },
    ] });
  expect(fs.statSync(diagnosticsFile).mode & 0o777).toBe(0o600);
  expect(options.calls.some(([command, args]) => command === 'npm' && args[0] === 'pack')).toBe(false);
});
it('keeps registration failures plus missing peers and unrelated inventory violations in one private diagnosis', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  const diagnosticsFile = path.join(options.root, 'registration-diagnostics.json');
  const specs = registeredReleaseFiles(); const paths = specs.flatMap((spec) => spec.paths);
  await expect(buildRelease({ ...options, diagnosticsFile, onStage: (stage, source) => {
    if (stage !== 'root_dependencies') return;
    for (const relative of paths) fs.mkdirSync(path.dirname(path.join(source, relative)), { recursive: true });
    for (const spec of specs) {
      fs.writeFileSync(path.join(source, spec.paths[0]), 'executable fixture', { mode: 0o755 });
      fs.chmodSync(path.join(source, spec.paths[0]), 0o755);
      fs.linkSync(path.join(source, spec.paths[0]), path.join(source, spec.paths[1]));
    }
    fs.linkSync(path.join(source, specs[0].paths[0]), path.join(options.root, 'external-link'));
    fs.unlinkSync(path.join(source, specs[1].paths[1]));
    fs.writeFileSync(path.join(source, 'unregistered-a'), 'unregistered');
    fs.linkSync(path.join(source, 'unregistered-a'), path.join(source, 'unregistered-b'));
  } })).rejects.toMatchObject({ code: 'release_inventory_registration_mismatch' });
  const report = readJson(diagnosticsFile);
  expect(report.phase).toBe('registered_inputs');
  expect(new Set(report.violations.map((row) => row.path))).toEqual(new Set([...paths, 'unregistered-a', 'unregistered-b']));
  expect(report.violations).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: specs[0].paths[0], reason: 'unaccounted_link_count' }),
    expect.objectContaining({ path: specs[1].paths[1], reason: 'missing_registered_peer' }),
    expect.objectContaining({ path: 'unregistered-a', code: 'unsupported_release_file' }),
  ]));
  expect(options.calls.some(([command, args]) => command === 'npm' && args[0] === 'pack')).toBe(false);
});
it('preserves the first inventory code when private diagnostic persistence fails', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  const diagnosticsFile = path.join(options.root, 'existing-directory'); fs.mkdirSync(diagnosticsFile);
  await expect(buildRelease({ ...options, diagnosticsFile, onStage: (stage, source) => {
    if (stage === 'root_dependencies') fs.linkSync(path.join(source, 'node_modules/fixture.txt'), path.join(source, 'node_modules/linked.txt'));
  } })).rejects.toMatchObject({ code: 'unsupported_release_file', diagnostics_error_code: 'EISDIR' });
  expect(fs.statSync(diagnosticsFile).isDirectory()).toBe(true);
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

it('binds tarball critical payload bytes even if an attacker replaces both tarball and its envelope digest', async () => {
  const options = fixture(); if (typeof process.execve !== 'function') return;
  const result = await buildRelease(options);
  const staged = path.join(options.root, 'repack/package'); fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.cpSync(path.join(result.bundle, 'payload'), staged, { recursive: true });
  fs.appendFileSync(path.join(staged, 'scripts/ao-dashboard.js'), 'different consumer bytes');
  releaseCommand('tar', ['-czf', path.join(result.bundle, 'package.tgz'), '-C', path.dirname(staged), 'package']);
  const envelope = readJson(path.join(result.bundle, 'release-envelope.json')); envelope.npm_tarball_sha256 = fileSha256(path.join(result.bundle, 'package.tgz'));
  durableJson(path.join(result.bundle, 'release-envelope.json'), envelope);
  expect(() => verifyReleaseEnvelope(result.bundle, fileSha256(path.join(result.bundle, 'release-envelope.json')))).toThrow('packed_payload_mismatch');
});
it('rejects a compatibility descriptor whose old binary is replaced before build execution', async () => {
  const options = fixture(); fs.writeFileSync(options.oldBinary, 'different immutable artifact');
  await expect(buildRelease(options)).rejects.toMatchObject({ code: typeof process.execve === 'function' ? 'release_compatibility_artifact_missing' : 'release_node_execve_required' });
  expect(options.calls.some(([command, args]) => command === 'npm' && args[0] === 'ci')).toBe(false);
});

it.each(['scripts/ao-session.js', 'scripts/ao-release-entry.js', 'schemas/fixture.json'])('rejects a real tarball with missing non-entry component/config/launcher %s', (missing) => {
  const root = fixtureRoot(); roots.push(root); const bundle = createBundle(root);
  const repack = path.join(root, 'repack'); fs.mkdirSync(repack); fs.cpSync(bundle.payload, path.join(repack, 'package'), { recursive: true }); fs.rmSync(path.join(repack, 'package', missing));
  releaseCommand('tar', ['-czf', path.join(bundle.bundle, 'package.tgz'), '-C', repack, 'package']);
  const envelope = readJson(path.join(bundle.bundle, 'release-envelope.json')); envelope.npm_tarball_sha256 = fileSha256(path.join(bundle.bundle, 'package.tgz')); durableJson(path.join(bundle.bundle, 'release-envelope.json'), envelope);
  expect(() => verifyReleaseEnvelope(bundle.bundle, fileSha256(path.join(bundle.bundle, 'release-envelope.json')))).toThrow('release_package_file_missing');
});
