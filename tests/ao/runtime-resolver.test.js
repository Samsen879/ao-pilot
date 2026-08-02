import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

const {
  loadRuntimeLock,
} = await import('../../scripts/ao/lib/runtime-lock.js');
const {
  createRuntimeProvenance,
  RUNTIME_PROVENANCE_FILENAME,
} = await import('../../scripts/ao/lib/runtime-provenance.js');
const {
  getManagedRuntimeDirectory,
  resolveManagedRuntime,
} = await import('../../scripts/ao/lib/runtime-resolver.js');

const tempDirs = [];
const NOW = '2026-08-02T05:00:00.000Z';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function writeExecutable(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function createVerifiedFixture() {
  const lock = loadRuntimeLock().lock;
  const storeRoot = createTempDir('ao-runtime-store-');
  const runtimeDirectory = getManagedRuntimeDirectory({ lock, storeRoot });
  const binaryPath = path.join(runtimeDirectory, lock.binary.relative_path);
  const binaryContent = '#!/bin/sh\necho ao\n';
  writeExecutable(binaryPath, binaryContent);
  const provenance = createRuntimeProvenance({
    lock,
    binary_sha256: sha256(binaryContent),
    installed_at: NOW,
  });
  const provenancePath = path.join(runtimeDirectory, RUNTIME_PROVENANCE_FILENAME);
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return {
    lock,
    storeRoot,
    runtimeDirectory,
    binaryPath,
    provenancePath,
    provenance,
  };
}

function resolveFixture(fixture, overrides = {}) {
  return resolveManagedRuntime({
    lock: fixture.lock,
    storeRoot: fixture.storeRoot,
    aoPilotVersion: '0.2.0',
    platform: 'linux',
    arch: 'x64',
    env: { PATH: path.dirname(fixture.binaryPath) },
    ...overrides,
  });
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('deterministic managed runtime resolver', () => {
  it('returns only the exact managed binary after provenance and integrity checks', () => {
    const fixture = createVerifiedFixture();
    expect(resolveFixture(fixture)).toEqual(expect.objectContaining({
      status: 'verified',
      runtime_ref: fixture.lock.runtime_ref,
      runtime_directory: fixture.runtimeDirectory,
      provenance_path: fixture.provenancePath,
      binary_path: fixture.binaryPath,
      binary_sha256: fixture.provenance.binary.sha256,
      source: expect.objectContaining({
        repository: fixture.lock.artifact.repository,
        tag_object_sha: fixture.lock.artifact.ref.tag_object_sha,
        commit_sha: fixture.lock.artifact.ref.commit_sha,
        tree_sha: fixture.lock.artifact.ref.tree_sha,
      }),
    }));
  });

  it('does not adopt a PATH-only binary when the managed runtime is missing', () => {
    const lock = loadRuntimeLock().lock;
    const storeRoot = createTempDir('ao-runtime-missing-');
    const wrongBin = path.join(createTempDir('ao-runtime-path-only-'), 'ao');
    writeExecutable(wrongBin, '#!/bin/sh\necho wrong\n');

    expect(() => resolveManagedRuntime({
      lock,
      storeRoot,
      aoPilotVersion: '0.2.0',
      platform: 'linux',
      arch: 'x64',
      env: { PATH: path.dirname(wrongBin) },
    })).toThrow(expect.objectContaining({
      code: 'runtime_missing',
      details: expect.objectContaining({
        path_candidate: wrongBin,
      }),
    }));
  });

  it('fails closed when PATH shadows a verified managed runtime', () => {
    const fixture = createVerifiedFixture();
    const wrongBin = path.join(createTempDir('ao-runtime-shadow-'), 'ao');
    writeExecutable(wrongBin, '#!/bin/sh\necho wrong\n');

    expect(() => resolveFixture(fixture, {
      env: { PATH: `${path.dirname(wrongBin)}${path.delimiter}${path.dirname(fixture.binaryPath)}` },
    })).toThrow(expect.objectContaining({
      code: 'runtime_path_shadowed',
      details: expect.objectContaining({
        path_candidate: wrongBin,
        binary_path: fixture.binaryPath,
      }),
    }));
  });

  it.each([
    ['runtime_source_unknown', (value) => { value.artifact.repository = 'https://github.com/example/ao.git'; }],
    ['runtime_version_mismatch', (value) => { value.artifact.version = '9.9.9'; }],
    ['runtime_mutable_ref', (value) => { value.artifact.ref.kind = 'branch'; }],
    ['runtime_tag_mismatch', (value) => { value.artifact.ref.tag_object_sha = '1111111111111111111111111111111111111111'; }],
    ['runtime_commit_mismatch', (value) => { value.artifact.ref.commit_sha = '2222222222222222222222222222222222222222'; }],
    ['runtime_tree_mismatch', (value) => { value.artifact.ref.tree_sha = '3333333333333333333333333333333333333333'; }],
    ['runtime_integrity_mismatch', (value) => { value.artifact.integrity.digest = '4444444444444444444444444444444444444444'; }],
  ])('rejects mismatched provenance with %s', (expectedCode, mutate) => {
    const fixture = createVerifiedFixture();
    const changed = JSON.parse(JSON.stringify(fixture.provenance));
    mutate(changed);
    fs.writeFileSync(fixture.provenancePath, `${JSON.stringify(changed, null, 2)}\n`);

    expect(() => resolveFixture(fixture)).toThrow(expect.objectContaining({
      code: expectedCode,
    }));
  });

  it('rejects a changed binary even when the executable path is unchanged', () => {
    const fixture = createVerifiedFixture();
    fs.writeFileSync(fixture.binaryPath, '#!/bin/sh\necho tampered\n');

    expect(() => resolveFixture(fixture)).toThrow(expect.objectContaining({
      code: 'runtime_binary_integrity_mismatch',
    }));
  });

  it('rejects a managed binary path that is a symlink to another runtime', () => {
    const fixture = createVerifiedFixture();
    const externalBinary = path.join(createTempDir('ao-runtime-external-'), 'ao');
    writeExecutable(externalBinary, '#!/bin/sh\necho ao\n');
    fs.rmSync(fixture.binaryPath);
    fs.symlinkSync(externalBinary, fixture.binaryPath);

    expect(() => resolveFixture(fixture)).toThrow(expect.objectContaining({
      code: 'runtime_binary_missing',
    }));
  });

  it('rejects a provenance path that is a symlink outside the managed runtime', () => {
    const fixture = createVerifiedFixture();
    const externalProvenance = path.join(
      createTempDir('ao-runtime-external-provenance-'),
      RUNTIME_PROVENANCE_FILENAME,
    );
    fs.writeFileSync(externalProvenance, `${JSON.stringify(fixture.provenance)}\n`);
    fs.rmSync(fixture.provenancePath);
    fs.symlinkSync(externalProvenance, fixture.provenancePath);

    expect(() => resolveFixture(fixture)).toThrow(expect.objectContaining({
      code: 'runtime_missing',
    }));
  });

  it.each([
    ['darwin', 'arm64', '0.2.0', 'runtime_platform_incompatible'],
    ['linux', 'x64', '0.1.9', 'runtime_version_incompatible'],
    ['linux', 'x64', '0.3.0', 'runtime_version_incompatible'],
  ])('rejects incompatible platform or ao-pilot version', (
    platform,
    arch,
    aoPilotVersion,
    expectedCode,
  ) => {
    const fixture = createVerifiedFixture();
    expect(() => resolveFixture(fixture, {
      platform,
      arch,
      aoPilotVersion,
    })).toThrow(expect.objectContaining({ code: expectedCode }));
  });
});
