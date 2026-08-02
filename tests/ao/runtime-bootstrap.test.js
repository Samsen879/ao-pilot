import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it } from '@jest/globals';

import { loadRuntimeLock } from '../../scripts/ao/lib/runtime-lock.js';
import { getManagedRuntimeDirectory } from '../../scripts/ao/lib/runtime-resolver.js';
import {
  bootstrapManagedRuntime,
  getDefaultRuntimeCache,
  getDefaultRuntimeStore,
  RUNTIME_BOOTSTRAP_RECEIPT_FILENAME,
} from '../../scripts/ao/lib/runtime-bootstrap.js';

const tempDirs = [];
const binaryContent = '#!/bin/sh\necho fixture-runtime\n';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function temp(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function createFixture() {
  const root = temp('ao-runtime-bootstrap-test-');
  const storeRoot = path.join(root, 'store');
  const cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(cacheRoot, { recursive: true });

  const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'backend'), { recursive: true });
  run('git', ['init', '--quiet'], source);
  run('git', ['config', 'user.name', 'Runtime Fixture'], source);
  run('git', ['config', 'user.email', 'runtime-fixture@example.invalid'], source);
  fs.writeFileSync(path.join(source, 'backend', 'fixture.txt'), 'fixture\n');
  run('git', ['add', 'backend/fixture.txt'], source);
  run('git', ['commit', '--quiet', '-m', 'fixture'], source);
  run('git', ['tag', '-a', 'locked-test', '-m', 'locked fixture'], source);
  const tagObject = run('git', ['rev-parse', 'locked-test'], source);
  const commit = run('git', ['rev-parse', 'locked-test^{}'], source);
  const tree = run('git', ['rev-parse', `${commit}^{tree}`], source);

  const runtimeLock = JSON.parse(JSON.stringify(loadRuntimeLock().lock));
  runtimeLock.artifact.repository = 'https://github.com/example/runtime-fixture.git';
  runtimeLock.artifact.ref.name = 'locked-test';
  runtimeLock.artifact.ref.tag_object_sha = tagObject;
  runtimeLock.artifact.ref.commit_sha = commit;
  runtimeLock.artifact.ref.tree_sha = tree;
  runtimeLock.artifact.integrity.digest = tree;
  runtimeLock.compatibility.platforms.find(
    (item) => item.os === 'linux' && item.arch === 'x64',
  ).binary_sha256 = sha256(binaryContent);

  const repositoryDigest = sha256(runtimeLock.artifact.repository).slice(0, 24);
  const sourceCache = path.join(cacheRoot, 'sources', repositoryDigest, tagObject);
  fs.mkdirSync(path.dirname(sourceCache), { recursive: true });
  run('git', ['clone', '--quiet', '--bare', source, sourceCache], root);
  run('git', ['update-ref', 'refs/ao-pilot/locked-tag', tagObject], sourceCache);

  const toolchainSource = path.join(root, 'toolchain-source');
  const goBinary = path.join(toolchainSource, 'go', 'bin', 'go');
  fs.mkdirSync(path.dirname(goBinary), { recursive: true });
  fs.writeFileSync(goBinary, '#!/bin/sh\necho "go version go1.25.7 linux/amd64"\n');
  fs.chmodSync(goBinary, 0o755);
  const archive = path.join(root, 'go.tar.gz');
  run('tar', ['-czf', archive, '-C', toolchainSource, 'go'], root);
  const archiveSha = sha256(fs.readFileSync(archive));
  const filename = 'go1.25.7.linux-amd64.tar.gz';
  const archiveCache = path.join(
    cacheRoot,
    'downloads',
    'go',
    '1.25.7',
    `${archiveSha}-${filename}`,
  );
  fs.mkdirSync(path.dirname(archiveCache), { recursive: true });
  fs.copyFileSync(archive, archiveCache);
  fs.chmodSync(archiveCache, 0o400);
  const toolchainLock = {
    schema_version: 'ao.runtime-bootstrap-toolchain.v1',
    name: 'go',
    version: '1.25.7',
    distribution: 'https://go.dev/dl/',
    platforms: [
      {
        os: 'linux',
        arch: 'x64',
        goarch: 'amd64',
        filename,
        url: `https://go.dev/dl/${filename}`,
        sha256: archiveSha,
      },
      {
        os: 'linux',
        arch: 'arm64',
        goarch: 'arm64',
        filename: 'go1.25.7.linux-arm64.tar.gz',
        url: 'https://go.dev/dl/go1.25.7.linux-arm64.tar.gz',
        sha256: 'f'.repeat(64),
      },
    ],
  };

  const buildOverride = async ({ runtimeStage, runtimeLock: lock }) => {
    const binaryPath = path.join(runtimeStage, lock.binary.relative_path);
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    fs.writeFileSync(binaryPath, binaryContent);
    fs.chmodSync(binaryPath, 0o755);
    return { binaryPath, sha256: sha256(binaryContent) };
  };
  return {
    root,
    storeRoot,
    cacheRoot,
    runtimeLock,
    toolchainLock,
    sourceCache,
    archiveCache,
    buildOverride,
  };
}

function bootstrap(fixture, overrides = {}) {
  return bootstrapManagedRuntime({
    runtimeLock: fixture.runtimeLock,
    toolchainLock: fixture.toolchainLock,
    storeRoot: fixture.storeRoot,
    cacheRoot: fixture.cacheRoot,
    platform: 'linux',
    arch: 'x64',
    aoPilotVersion: '0.2.0',
    env: { PATH: '/usr/bin:/bin' },
    cwd: fixture.root,
    offline: true,
    buildOverride: fixture.buildOverride,
    now: () => '2026-08-02T06:00:00.000Z',
    ...overrides,
  });
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('deterministic runtime bootstrap', () => {
  it('installs the exact runtime from verified offline caches', async () => {
    const fixture = createFixture();
    const report = await bootstrap(fixture);
    expect(report).toEqual(expect.objectContaining({
      status: 'installed',
      offline: true,
      internal_verification: 'verified',
      source_cache: expect.objectContaining({ path: fixture.sourceCache, reused: true }),
      toolchain_cache: expect.objectContaining({
        archive_path: fixture.archiveCache,
        reused: true,
      }),
    }));
    expect(report.runtime).toEqual(expect.objectContaining({
      status: 'verified',
      binary_sha256: sha256(binaryContent),
      source: expect.objectContaining({
        commit_sha: fixture.runtimeLock.artifact.ref.commit_sha,
        tree_sha: fixture.runtimeLock.artifact.ref.tree_sha,
      }),
    }));
    const receipt = JSON.parse(fs.readFileSync(
      path.join(report.runtime.runtime_directory, RUNTIME_BOOTSTRAP_RECEIPT_FILENAME),
      'utf8',
    ));
    expect(receipt).toEqual(expect.objectContaining({
      schema_version: 'ao.runtime-bootstrap-receipt.v1',
      runtime_ref: fixture.runtimeLock.runtime_ref,
      target: { os: 'linux', arch: 'x64' },
      source: expect.objectContaining({
        tag_object_sha: fixture.runtimeLock.artifact.ref.tag_object_sha,
      }),
      cache_reuse: { source: true, toolchain_archive: true, offline: true },
    }));
  });

  it('is idempotent and reuses an already verified install', async () => {
    const fixture = createFixture();
    await bootstrap(fixture);
    const report = await bootstrap(fixture);
    expect(report.status).toBe('reused');
    expect(report.runtime.status).toBe('verified');
    expect(report.runtime.bootstrap_receipt_path.endsWith(
      RUNTIME_BOOTSTRAP_RECEIPT_FILENAME,
    )).toBe(true);
  });

  it('rejects a changed bootstrap receipt and repairs it only on reinstall', async () => {
    const fixture = createFixture();
    const installed = await bootstrap(fixture);
    const receiptPath = installed.runtime.bootstrap_receipt_path;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.source.commit_sha = 'f'.repeat(40);
    fs.chmodSync(receiptPath, 0o600);
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    await expect(bootstrap(fixture)).rejects.toMatchObject({
      code: 'runtime_existing_invalid',
      details: expect.objectContaining({ cause_code: 'bootstrap_receipt_mismatch' }),
    });
    const repaired = await bootstrap(fixture, { reinstall: true });
    expect(repaired.status).toBe('reinstalled');
  });

  it('recovers a dead bootstrap owner and removes only matching staging state', async () => {
    const fixture = createFixture();
    const runtimeDirectory = getManagedRuntimeDirectory({
      lock: fixture.runtimeLock,
      storeRoot: fixture.storeRoot,
      platform: 'linux',
      arch: 'x64',
    });
    const parent = path.dirname(runtimeDirectory);
    const commit = fixture.runtimeLock.artifact.ref.commit_sha;
    const lockPath = path.join(parent, `.bootstrap-${commit}.lock`);
    const staleStage = path.join(parent, `.staging-${commit}-stale`);
    const staleSourcePartial = `${fixture.sourceCache}.partial-999999-deadbeef`;
    const staleToolchainPartial = `${fixture.archiveCache}.partial-999999-deadbeef`;
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999 }));
    fs.mkdirSync(staleStage);
    fs.mkdirSync(staleSourcePartial);
    fs.writeFileSync(staleToolchainPartial, 'partial');

    const report = await bootstrap(fixture, { processAlive: () => false });
    expect(report.recovered_interrupted_bootstrap).toBe(true);
    expect(fs.existsSync(staleStage)).toBe(false);
    expect(fs.existsSync(staleSourcePartial)).toBe(false);
    expect(fs.existsSync(staleToolchainPartial)).toBe(false);
  });

  it('fails closed while another bootstrap owner is alive', async () => {
    const fixture = createFixture();
    const runtimeDirectory = getManagedRuntimeDirectory({
      lock: fixture.runtimeLock,
      storeRoot: fixture.storeRoot,
      platform: 'linux',
      arch: 'x64',
    });
    const commit = fixture.runtimeLock.artifact.ref.commit_sha;
    const lockPath = path.join(path.dirname(runtimeDirectory), `.bootstrap-${commit}.lock`);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 123,
      started_at: 'now',
      process_start_token: 'fixture-start',
    }));
    await expect(bootstrap(fixture, {
      processAlive: () => true,
      processStartToken: () => 'fixture-start',
    })).rejects.toMatchObject({
      code: 'bootstrap_in_progress',
    });
  });

  it('fails offline when the verified source cache is missing', async () => {
    const fixture = createFixture();
    fs.rmSync(fixture.sourceCache, { recursive: true, force: true });
    await expect(bootstrap(fixture)).rejects.toMatchObject({
      code: 'runtime_source_cache_missing',
    });
  });

  it('fails offline when the verified toolchain archive is changed', async () => {
    const fixture = createFixture();
    fs.chmodSync(fixture.archiveCache, 0o600);
    fs.appendFileSync(fixture.archiveCache, 'changed');
    await expect(bootstrap(fixture)).rejects.toMatchObject({
      code: 'toolchain_cache_invalid',
    });
  });

  it('reinstalls atomically and preserves the prior runtime on build failure', async () => {
    const fixture = createFixture();
    const installed = await bootstrap(fixture);
    const binaryPath = installed.runtime.binary_path;
    await expect(bootstrap(fixture, {
      reinstall: true,
      buildOverride: async () => {
        throw new Error('interrupted build');
      },
    })).rejects.toThrow('interrupted build');
    expect(fs.readFileSync(binaryPath, 'utf8')).toBe(binaryContent);
    const replaced = await bootstrap(fixture, { reinstall: true });
    expect(replaced.status).toBe('reinstalled');
  });

  it('installs the managed runtime but fails closed on a shadowing PATH binary', async () => {
    const fixture = createFixture();
    const shadowRoot = path.join(fixture.root, 'shadow');
    fs.mkdirSync(shadowRoot);
    fs.writeFileSync(path.join(shadowRoot, 'ao'), '#!/bin/sh\necho wrong\n');
    fs.chmodSync(path.join(shadowRoot, 'ao'), 0o755);
    await expect(bootstrap(fixture, {
      env: { PATH: `${shadowRoot}:/usr/bin:/bin` },
    })).rejects.toMatchObject({ code: 'runtime_path_shadowed' });
    const runtimeDirectory = getManagedRuntimeDirectory({
      lock: fixture.runtimeLock,
      storeRoot: fixture.storeRoot,
      platform: 'linux',
      arch: 'x64',
    });
    expect(fs.existsSync(path.join(runtimeDirectory, 'bin', 'ao'))).toBe(true);
  });

  it('does not accept a symlink as a managed store root', async () => {
    const fixture = createFixture();
    const realStore = path.join(fixture.root, 'real-store');
    const symlinkStore = path.join(fixture.root, 'symlink-store');
    fs.mkdirSync(realStore);
    fs.symlinkSync(realStore, symlinkStore);
    await expect(bootstrap(fixture, { storeRoot: symlinkStore })).rejects.toMatchObject({
      code: 'bootstrap_path_symlink',
    });
  });

  it('does not accept a symlink in an ancestor of a managed root', async () => {
    const fixture = createFixture();
    const realParent = path.join(fixture.root, 'real-parent');
    const symlinkParent = path.join(fixture.root, 'symlink-parent');
    fs.mkdirSync(realParent);
    fs.symlinkSync(realParent, symlinkParent);
    await expect(bootstrap(fixture, {
      storeRoot: path.join(symlinkParent, 'store'),
    })).rejects.toMatchObject({ code: 'bootstrap_path_symlink' });
  });

  it('derives XDG defaults without consulting legacy runtime checkout paths', () => {
    expect(getDefaultRuntimeStore({
      env: { XDG_DATA_HOME: '/isolated/data' }, homedir: '/ignored',
    })).toBe('/isolated/data/ao-pilot/runtimes');
    expect(getDefaultRuntimeCache({
      env: { XDG_CACHE_HOME: '/isolated/cache' }, homedir: '/ignored',
    })).toBe('/isolated/cache/ao-pilot/runtime-bootstrap');
  });
});
