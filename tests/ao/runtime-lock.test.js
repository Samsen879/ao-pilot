import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

const {
  RUNTIME_LOCK_SCHEMA_VERSION,
  computeRuntimeLockDigest,
  getDefaultRuntimeLockPath,
  loadRuntimeLock,
  normalizeRuntimeLock,
} = await import('../../scripts/ao/lib/runtime-lock.js');
const {
  verifyRuntimeLock,
} = await import('../../scripts/verify-runtime-lock.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('runtime lock contract', () => {
  it('pins the public fork artifact to an annotated tag, commit, tree, and build contract', () => {
    const loaded = loadRuntimeLock();

    expect(loaded.path).toBe(getDefaultRuntimeLockPath());
    expect(loaded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(loaded.lock).toMatchObject({
      schema_version: RUNTIME_LOCK_SCHEMA_VERSION,
      runtime_ref: 'runtime.agent_orchestrator.v0_11_2_p0_1',
      artifact: {
        kind: 'git_source',
        repository: 'https://github.com/Samsen879/agent-orchestrator.git',
        upstream_repository: 'https://github.com/Untrivial-ai/agent-orchestrator.git',
        version: '0.11.2-p0.1',
        package: {
          name: '@aoagents/ao',
          version: '0.11.2',
          role: 'upstream_identity',
          install_authority: false,
        },
        ref: {
          kind: 'annotated_tag',
          name: 'ao-pilot-runtime-v0.11.2-p0.1',
          tag_object_sha: '06ba07935cbacb7ff304779a2c1060ce98778200',
          commit_sha: '711178ebe07d436db36020eb08f0c4e29613f97b',
          tree_sha: '479fba6fd44f251f0c66fafc5cb5d638a6ff590a',
        },
        integrity: {
          algorithm: 'git-tree-sha1',
          digest: '479fba6fd44f251f0c66fafc5cb5d638a6ff590a',
        },
      },
      build: {
        working_directory: 'backend',
        toolchain: {
          name: 'go',
          version: '1.25.7',
        },
        environment: {
          CGO_ENABLED: '0',
        },
      },
      binary: {
        name: 'ao',
        relative_path: 'bin/ao',
      },
    });
    expect(loaded.lock.build.command).toContain('{binary_path}');
    expect(loaded.lock.compatibility.platforms).toEqual([
      {
        os: 'linux',
        arch: 'x64',
        binary_sha256: 'a403e096203e68e94dde5f45922b0880a4a2dd662c38aab3f0af6d47ec56aa34',
      },
      {
        os: 'linux',
        arch: 'arm64',
        binary_sha256: '132164dc29349ea2082d77d6758b3617be81c7cfcf27d3f0ba9a88d65a88c752',
      },
    ]);
  });

  it('produces a stable content digest independent of object key order', () => {
    const { lock } = loadRuntimeLock();
    const reordered = {
      compatibility: lock.compatibility,
      binary: lock.binary,
      build: lock.build,
      artifact: lock.artifact,
      runtime_ref: lock.runtime_ref,
      schema_version: lock.schema_version,
    };
    expect(computeRuntimeLockDigest(reordered)).toBe(computeRuntimeLockDigest(lock));
  });

  it('rejects mutable branch refs even when a commit is also present', () => {
    const mutated = clone(loadRuntimeLock().lock);
    mutated.artifact.ref.kind = 'branch';
    mutated.artifact.ref.name = 'main';

    expect(() => normalizeRuntimeLock(mutated)).toThrow(
      'Unsupported artifact.ref.kind: branch',
    );
  });

  it('rejects missing or malformed immutable Git object identities', () => {
    const missingCommit = clone(loadRuntimeLock().lock);
    missingCommit.artifact.ref.commit_sha = '';
    expect(() => normalizeRuntimeLock(missingCommit)).toThrow('Invalid artifact.ref.commit_sha');

    const malformedTag = clone(loadRuntimeLock().lock);
    malformedTag.artifact.ref.tag_object_sha = 'latest';
    expect(() => normalizeRuntimeLock(malformedTag)).toThrow(
      'Invalid artifact.ref.tag_object_sha',
    );
  });

  it('rejects a tree integrity digest that differs from the locked tree', () => {
    const mutated = clone(loadRuntimeLock().lock);
    mutated.artifact.integrity.digest = '1111111111111111111111111111111111111111';
    expect(() => normalizeRuntimeLock(mutated)).toThrow(
      'Runtime integrity digest does not match artifact.ref.tree_sha',
    );
  });

  it('rejects an ambiguous same-name ao package as runtime identity', () => {
    const mutated = clone(loadRuntimeLock().lock);
    mutated.artifact.package.name = 'ao';
    expect(() => normalizeRuntimeLock(mutated)).toThrow(
      'Unsupported artifact.package.name: ao',
    );
  });

  it('ships the lock in the package-owned runtime directory and verifies it offline', () => {
    const lockPath = getDefaultRuntimeLockPath();
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(path.basename(lockPath)).toBe('agent-orchestrator.lock.json');

    expect(verifyRuntimeLock()).toMatchObject({
      status: 'verified',
      schema_version: RUNTIME_LOCK_SCHEMA_VERSION,
      runtime_ref: 'runtime.agent_orchestrator.v0_11_2_p0_1',
      lock_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      artifact: {
        repository: 'https://github.com/Samsen879/agent-orchestrator.git',
        commit_sha: '711178ebe07d436db36020eb08f0c4e29613f97b',
        tree_sha: '479fba6fd44f251f0c66fafc5cb5d638a6ff590a',
      },
    });
  });

  it('binds platform digests to two byte-identical exact-source builds', () => {
    const { lock } = loadRuntimeLock();
    const receipt = JSON.parse(fs.readFileSync(path.join(
      process.cwd(),
      'docs',
      'runtime-portability',
      'p0-r04-binary-digest-receipt.json',
    ), 'utf8'));

    expect(receipt).toMatchObject({
      schema_version: 'ao.runtime-binary-digest-receipt.v1',
      source: {
        repository: lock.artifact.repository,
        tag: lock.artifact.ref.name,
        tag_object_sha: lock.artifact.ref.tag_object_sha,
        commit_sha: lock.artifact.ref.commit_sha,
        tree_sha: lock.artifact.ref.tree_sha,
      },
      toolchain: {
        name: lock.build.toolchain.name,
        version: lock.build.toolchain.version,
        archive_sha256: '12e6d6a191091ae27dc31f6efc630e3a3b8ba409baf3573d955b196fdf086005',
      },
    });
    expect(receipt.targets).toHaveLength(lock.compatibility.platforms.length);
    for (const target of receipt.targets) {
      const lockedTarget = lock.compatibility.platforms.find((item) => (
        item.os === target.os && item.arch === target.arch
      ));
      expect(lockedTarget).toBeDefined();
      expect(target.byte_identical).toBe(true);
      expect(target.run_sha256).toEqual([
        lockedTarget.binary_sha256,
        lockedTarget.binary_sha256,
      ]);
    }
  });
});
