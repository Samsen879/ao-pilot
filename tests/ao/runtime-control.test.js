import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveManagedRuntime = jest.fn();
const mockVerifyReceipt = jest.fn();

const runtimeLock = {
  runtime_ref: 'runtime.test.v1',
  artifact: {
    repository: 'https://github.com/example/runtime.git',
    version: '1.2.3',
    ref: {
      name: 'v1.2.3',
      tag_object_sha: '1'.repeat(40),
      commit_sha: '2'.repeat(40),
      tree_sha: '3'.repeat(40),
    },
    integrity: { algorithm: 'git-tree-sha1', digest: '3'.repeat(40) },
  },
  compatibility: { ao_pilot: {}, platforms: [] },
};
const toolchainLock = { name: 'go', version: '1.25.7', platforms: [] };

jest.unstable_mockModule('../../scripts/ao/lib/runtime-resolver.js', () => ({
  resolveManagedRuntime: mockResolveManagedRuntime,
}));
jest.unstable_mockModule('../../scripts/ao/lib/runtime-bootstrap.js', () => ({
  getDefaultRuntimeStore: () => '/managed/store',
  verifyRuntimeBootstrapReceipt: mockVerifyReceipt,
}));
jest.unstable_mockModule('../../scripts/ao/lib/runtime-lock.js', () => ({
  loadRuntimeLock: () => ({ lock: runtimeLock }),
  computeRuntimeLockDigest: () => 'sha256:runtime-lock',
}));
jest.unstable_mockModule('../../scripts/ao/lib/runtime-bootstrap-contract.js', () => ({
  loadBootstrapToolchainLock: () => ({ lock: toolchainLock }),
}));

const {
  inspectRuntimeControl,
  resolveRuntimeControl,
  runVerifiedRuntime,
  startVerifiedRuntimeDaemon,
} = await import('../../scripts/ao/lib/runtime-control.js');

const verified = {
  status: 'verified',
  runtime_ref: 'runtime.test.v1',
  lock_digest: 'sha256:lock',
  runtime_directory: '/managed/store/runtime.test.v1/linux-x64/commit',
  provenance_path: '/managed/store/runtime.test.v1/linux-x64/commit/runtime-provenance.json',
  binary_path: '/managed/store/runtime.test.v1/linux-x64/commit/bin/ao',
  binary_sha256: 'a'.repeat(64),
  source: {
    repository: runtimeLock.artifact.repository,
    version: runtimeLock.artifact.version,
    commit_sha: runtimeLock.artifact.ref.commit_sha,
    tree_sha: runtimeLock.artifact.ref.tree_sha,
    integrity: runtimeLock.artifact.integrity,
  },
  compatibility: runtimeLock.compatibility,
  path_candidate: null,
};

describe('runtime control boundary', () => {
  beforeEach(() => {
    mockResolveManagedRuntime.mockReset();
    mockVerifyReceipt.mockReset();
    mockResolveManagedRuntime.mockReturnValue(verified);
    mockVerifyReceipt.mockReturnValue({ path: `${verified.runtime_directory}/runtime-bootstrap.json` });
  });

  it('returns an exact binary only after resolver and bootstrap receipt verification', () => {
    const result = resolveRuntimeControl({
      env: { PATH: '/safe/bin' },
      cwd: '/repo',
      runtimeLock,
      toolchainLock,
      platform: 'linux',
      arch: 'x64',
      aoPilotVersion: '0.2.0',
    });

    expect(result.binary_path).toBe(verified.binary_path);
    expect(result.bootstrap_receipt_path).toContain('runtime-bootstrap.json');
    expect(mockResolveManagedRuntime).toHaveBeenCalledWith(expect.objectContaining({
      storeRoot: '/managed/store',
      env: { PATH: '/safe/bin' },
    }));
    expect(mockVerifyReceipt).toHaveBeenCalledWith(expect.objectContaining({
      runtimeDirectory: verified.runtime_directory,
      runtimeLock,
      toolchainLock,
    }));
  });

  it('reports shadowed runtime and auth availability without retaining command output', () => {
    const error = new Error('PATH contains a different binary');
    error.code = 'runtime_path_shadowed';
    error.details = {
      binary_path: verified.binary_path,
      path_candidate: '/wrong/bin/ao',
    };
    mockResolveManagedRuntime.mockImplementation(() => { throw error; });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: 'secret-like gh output', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'secret-like codex output' });

    const report = inspectRuntimeControl({
      env: { PATH: '/wrong/bin' },
      runtimeLock,
      toolchainLock,
      spawn,
    });

    expect(report).toMatchObject({
      status: 'blocked',
      runtime: {
        code: 'runtime_path_shadowed',
        binary_path: verified.binary_path,
        path_candidate: '/wrong/bin/ao',
      },
      authentication: {
        github: { available: true, authenticated: true },
        codex: { available: true, authenticated: false },
      },
    });
    expect(JSON.stringify(report)).not.toContain('secret-like');
  });

  it('executes the verified absolute runtime path and never a PATH ao', () => {
    const spawn = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    const execution = runVerifiedRuntime(['status', '--json'], {
      env: { PATH: '/wrong/bin' },
      cwd: '/repo',
      spawn,
    });

    expect(execution.result.status).toBe(0);
    expect(spawn).toHaveBeenCalledWith(
      verified.binary_path,
      ['status', '--json'],
      expect.objectContaining({ cwd: '/repo' }),
    );
  });

  it('starts the verified binary daemon directly and waits for ready status', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'not running' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":42}', stderr: '' });
    const child = { once: jest.fn(), unref: jest.fn() };
    const childSpawn = jest.fn().mockReturnValue(child);

    const result = await startVerifiedRuntimeDaemon(verified, {
      cwd: '/repo',
      env: { PATH: '/safe' },
      childSpawn,
      syncSpawn,
      delay: async () => {},
    });

    expect(result).toMatchObject({
      status: 'started',
      exit_code: 0,
      daemon_status: { state: 'ready', pid: 42 },
    });
    expect(childSpawn).toHaveBeenCalledWith(
      verified.binary_path,
      ['daemon'],
      expect.objectContaining({ cwd: '/repo', detached: true, stdio: 'ignore' }),
    );
    expect(syncSpawn).toHaveBeenCalledWith(
      verified.binary_path,
      ['status', '--json'],
      expect.objectContaining({ cwd: '/repo' }),
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it('returns already-running without spawning another daemon', async () => {
    const syncSpawn = jest.fn().mockReturnValue({
      status: 0,
      stdout: '{"state":"ready","pid":42}',
      stderr: '',
    });
    const childSpawn = jest.fn();

    const result = await startVerifiedRuntimeDaemon(verified, { syncSpawn, childSpawn });

    expect(result.status).toBe('already_running');
    expect(childSpawn).not.toHaveBeenCalled();
  });
});
