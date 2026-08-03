import fs from 'node:fs';
import { describe, expect, it } from '@jest/globals';

import {
  computeBootstrapToolchainLockDigest,
  loadBootstrapToolchainLock,
  normalizeBootstrapToolchainLock,
} from '../../scripts/ao/lib/runtime-bootstrap-contract.js';

describe('runtime bootstrap toolchain lock', () => {
  it('binds official Go archives for every runtime platform', () => {
    const loaded = loadBootstrapToolchainLock();
    expect(loaded.lock).toEqual(expect.objectContaining({
      schema_version: 'ao.runtime-bootstrap-toolchain.v1',
      name: 'go',
      version: '1.25.7',
      distribution: 'https://go.dev/dl/',
    }));
    expect(loaded.lock.platforms).toEqual([
      expect.objectContaining({
        os: 'linux',
        arch: 'x64',
        goarch: 'amd64',
        sha256: '12e6d6a191091ae27dc31f6efc630e3a3b8ba409baf3573d955b196fdf086005',
      }),
      expect.objectContaining({
        os: 'linux',
        arch: 'arm64',
        goarch: 'arm64',
        sha256: 'ba611a53534135a81067240eff9508cd7e256c560edd5d8c2fef54f083c07129',
      }),
    ]);
    expect(loaded.digest).toBe(computeBootstrapToolchainLockDigest(loaded.lock));
    expect(loaded.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('binds the R05 live bootstrap evidence to the locked runtime and toolchain', () => {
    const evidence = JSON.parse(fs.readFileSync(
      'docs/runtime-portability/p0-r05-bootstrap-evidence.json',
      'utf8',
    ));
    const toolchain = loadBootstrapToolchainLock();
    expect(evidence).toEqual(expect.objectContaining({
      schema_version: 'ao-pilot.p0-r05-bootstrap-evidence.v1',
      issue: 60,
      runtime: expect.objectContaining({
        runtime_ref: 'runtime.agent_orchestrator.v0_11_2_p0_1',
        tag_object_sha: '06ba07935cbacb7ff304779a2c1060ce98778200',
        commit_sha: '711178ebe07d436db36020eb08f0c4e29613f97b',
        tree_sha: '479fba6fd44f251f0c66fafc5cb5d638a6ff590a',
      }),
      toolchain: expect.objectContaining({
        lock_digest: toolchain.digest,
      }),
      claim_boundary: {
        runtime_bootstrap: 'ESTABLISHED_FOR_R05',
        runtime_lifecycle: 'NOT_ESTABLISHED_UNTIL_R06',
        fresh_clone_gate: 'NOT_ESTABLISHED_UNTIL_R07',
        workstation_self_hosting: 'NOT_ESTABLISHED_UNTIL_R08',
      },
    }));
    expect(evidence.runtime.lock_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.isolated_live_bootstrap.path_shadow_probe.shadow_binary_adopted).toBe(false);
  });

  it.each([
    ['mutable URL', (lock) => { lock.platforms[0].url = 'https://example.com/go.tar.gz'; }],
    ['wrong digest', (lock) => { lock.platforms[0].sha256 = 'wrong'; }],
    ['wrong distribution', (lock) => { lock.distribution = 'https://example.com/'; }],
    ['unknown key', (lock) => { lock.branch = 'main'; }],
  ])('rejects %s', (_name, mutate) => {
    const lock = JSON.parse(fs.readFileSync('runtime/go-toolchain.lock.json', 'utf8'));
    mutate(lock);
    expect(() => normalizeBootstrapToolchainLock(lock)).toThrow();
  });
});
