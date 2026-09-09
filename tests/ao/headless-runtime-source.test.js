import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { loadRuntimeLock } from '../../scripts/ao/lib/runtime-lock.js';
import { verifyHeadlessRuntimeSource } from '../../scripts/verify-headless-runtime-source.js';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-headless-source-'));
  temporaryRoots.push(root);
  const cli = path.join(root, 'backend', 'internal', 'cli');
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, 'start.go'), [
    'package cli',
    'var errDesktopEntrypointDisabled = true',
    '// It performs no filesystem discovery, network request, or process creation.',
  ].join('\n'));
  return root;
}

function fixtureStartDigest(root) {
  return createHash('sha256')
    .update(fs.readFileSync(path.join(root, 'backend', 'internal', 'cli', 'start.go')))
    .digest('hex');
}

describe('headless runtime source boundary', () => {
  it('accepts the committed repository-owned source', () => {
    expect(verifyHeadlessRuntimeSource()).toMatchObject({
      status: 'pass',
      forbidden_path_count: 0,
      forbidden_sink_count: 0,
    });
  });

  it('rejects a reintroduced Electron path', () => {
    const root = fixture();
    fs.mkdirSync(path.join(root, 'frontend', 'electron'), { recursive: true });
    fs.writeFileSync(path.join(root, 'frontend', 'electron', 'main.js'), '');
    expect(() => verifyHeadlessRuntimeSource({
      sourceRoot: root,
      expectedStartSourceSha256: fixtureStartDigest(root),
    })).toThrow('desktop paths present');
  });

  it('rejects a reintroduced desktop acquisition sink', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'launcher.go'), 'func fetchApp() {}');
    expect(() => verifyHeadlessRuntimeSource({
      sourceRoot: root,
      runtimeLock: loadRuntimeLock().lock,
      expectedStartSourceSha256: fixtureStartDigest(root),
    })).toThrow('desktop acquisition sinks present');
  });

  it('rejects any change to the fail-closed start implementation', () => {
    const root = fixture();
    expect(() => verifyHeadlessRuntimeSource({ sourceRoot: root })).toThrow(
      'headless start boundary digest mismatch',
    );
  });

  it('rejects recovery guidance that routes users to the disabled command', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'recovery.go'), 'var guidance = "run `ao start`"');
    expect(() => verifyHeadlessRuntimeSource({
      sourceRoot: root,
      expectedStartSourceSha256: fixtureStartDigest(root),
    })).toThrow('disabled start recovery instructions present');
  });
});
