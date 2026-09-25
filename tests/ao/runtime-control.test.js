import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockResolveManagedRuntime = jest.fn();
const mockVerifyReceipt = jest.fn();
const mockLoadRuntimeLock = jest.fn();

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
  loadRuntimeLock: mockLoadRuntimeLock,
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
    mockLoadRuntimeLock.mockReset();
    mockLoadRuntimeLock.mockReturnValue({ lock: runtimeLock });
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

  it('reports a packaged runtime lock load failure instead of throwing', () => {
    mockLoadRuntimeLock.mockImplementationOnce(() => { throw new Error('invalid runtime lock json'); });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: '' });

    const report = inspectRuntimeControl({ env: { PATH: '/safe' }, spawn });

    expect(report).toMatchObject({
      status: 'blocked',
      runtime: {
        status: 'blocked',
        code: 'runtime_lock_invalid',
        message: 'invalid runtime lock json',
        runtime_ref: null,
        source: null,
      },
    });
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
      expect.objectContaining({ cwd: '/repo', timeout: 15_000 }),
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

  it('waits for an existing live daemon to finish recovery without spawning', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"state":"not_ready","health":"ok","pid":42}',
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '{"state":"ready","health":"ok","pid":42}',
        stderr: '',
      });
    const childSpawn = jest.fn();

    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn,
      childSpawn,
      delay: async () => {},
    });

    expect(result.status).toBe('already_running');
    expect(childSpawn).not.toHaveBeenCalled();
    expect(syncSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not replace a live PID after an inconclusive health probe', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"unhealthy","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":42}' });
    const childSpawn = jest.fn();
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, isProcessAlive: () => true, isDaemonPid: () => true, delay: async () => {},
    });
    expect(result.status).toBe('already_running');
    expect(childSpawn).not.toHaveBeenCalled();
  });

  it('starts when a recycled PID belongs to another executable', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"unhealthy","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":73}' });
    const childSpawn = jest.fn().mockReturnValue({ once: jest.fn(), unref: jest.fn() });
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, isProcessAlive: () => true, isDaemonPid: () => false, delay: async () => {},
    });
    expect(result).toMatchObject({ status: 'started', exit_code: 0 });
    expect(childSpawn).toHaveBeenCalledTimes(1);
  });

  it('bounds an unverified live PID rather than waiting the whole recovery deadline', async () => {
    const syncSpawn = jest.fn().mockReturnValue({ status: 0, stdout: '{"state":"unhealthy","pid":42}' });
    const childSpawn = jest.fn();
    let clock = 0;
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, isProcessAlive: () => true, isDaemonPid: () => null,
      now: () => clock, timeoutMs: 30_000, delay: async (ms) => { clock += ms; },
    });
    expect(result).toMatchObject({ status: 'failed', exit_code: 2 });
    expect(result.error).toMatch(/ownership could not be verified/);
    expect(clock).toBeLessThan(30_000);
    expect(childSpawn).not.toHaveBeenCalled();
  });

  it('starts a replacement when the recovering daemon is confirmed gone', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"not_ready","health":"ok","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"stopped"}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","health":"ok","pid":43}' });
    const childSpawn = jest.fn().mockReturnValue({ once: jest.fn(), unref: jest.fn() });
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, delay: async () => {}, isProcessAlive: () => false,
    });
    expect(result).toMatchObject({ status: 'started', exit_code: 0, daemon_status: { pid: 43 } });
    expect(childSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not spawn while the old PID lives after its run file disappears', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"not_ready","health":"ok","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"stopped"}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":42}' });
    const childSpawn = jest.fn();
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, delay: async () => {}, isProcessAlive: () => true,
    });
    expect(result.status).toBe('already_running');
    expect(childSpawn).not.toHaveBeenCalled();
  });

  it('tracks a competing daemon PID after losing the start race', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 1, stdout: '' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"not_ready","health":"ok","pid":73}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"stopped"}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":73}' });
    const callbacks = {};
    const childSpawn = jest.fn().mockReturnValue({
      once: jest.fn((event, callback) => { callbacks[event] = callback; }),
      unref: jest.fn(),
    });
    let delayed = false;
    const isProcessAlive = jest.fn().mockReturnValue(true);
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn, isProcessAlive,
      delay: async () => {
        if (!delayed) {
          delayed = true;
          callbacks.exit(1, null);
        }
      },
    });
    expect(result.status).toBe('already_running');
    expect(isProcessAlive).toHaveBeenCalledWith(73);
    expect(childSpawn).toHaveBeenCalledTimes(1);
  });

  it('backs off status probes during a long recovery', async () => {
    const starting = { status: 0, stdout: '{"state":"not_ready","health":"ok","pid":42}' };
    const syncSpawn = jest.fn()
      .mockReturnValueOnce(starting)
      .mockReturnValueOnce(starting)
      .mockReturnValueOnce(starting)
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":42}' });
    const delays = [];
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn: jest.fn(), delay: async (ms) => { delays.push(ms); },
    });
    expect(result.status).toBe('already_running');
    expect(delays).toEqual([250, 500, 1000]);
  });

  it('bounds the initial status probe by the remaining startup timeout', async () => {
    const syncSpawn = jest.fn().mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      error: { code: 'ETIMEDOUT' },
    });
    const childSpawn = jest.fn();
    const now = jest.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(10_000);

    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn,
      childSpawn,
      timeoutMs: 10_000,
      now,
    });

    expect(result).toMatchObject({
      status: 'failed',
      exit_code: 2,
      error: expect.stringContaining('status probe exceeded'),
    });
    expect(syncSpawn).toHaveBeenCalledWith(
      verified.binary_path,
      ['status', '--json'],
      expect.objectContaining({ timeout: 10_000 }),
    );
    expect(childSpawn).not.toHaveBeenCalled();
  });

  it('returns structured failure when daemon spawn throws synchronously', async () => {
    const syncSpawn = jest.fn().mockReturnValue({ status: 1, stdout: '', stderr: '' });
    const childSpawn = jest.fn(() => { throw new Error('spawn denied'); });

    const result = await startVerifiedRuntimeDaemon(verified, { syncSpawn, childSpawn });

    expect(result).toMatchObject({ status: 'failed', exit_code: 2, error: 'spawn denied' });
  });

  it('terminates its unobservable child after the startup deadline', async () => {
    const child = { pid: 91, once: jest.fn(), unref: jest.fn(), kill: jest.fn() };
    let clock = 0;
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn: jest.fn().mockReturnValue({ status: 1, stdout: '' }),
      childSpawn: jest.fn().mockReturnValue(child),
      timeoutMs: 1000,
      now: () => clock,
      delay: async (ms) => { clock += ms; },
    });
    expect(result.status).toBe('failed');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('waits for an unobservable child to exit after SIGTERM', async () => {
    const callbacks = {};
    const child = {
      pid: 91,
      once: jest.fn((event, callback) => { callbacks[event] = callback; }),
      unref: jest.fn(), kill: jest.fn(),
    };
    let clock = 0;
    let cleanupWaits = 0;
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn: jest.fn().mockReturnValue({ status: 1, stdout: '' }),
      childSpawn: jest.fn().mockReturnValue(child),
      isProcessAlive: () => true,
      timeoutMs: 1000, now: () => clock,
      delay: async (ms) => {
        clock += ms;
        if (ms === 200 && ++cleanupWaits === 2) callbacks.exit(0, 'SIGTERM');
      },
    });
    expect(result.status).toBe('failed');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(cleanupWaits).toBe(2);
  });

  it('performs a final probe at the deadline after a capped backoff', async () => {
    const syncSpawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"not_ready","health":"ok","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"not_ready","health":"ok","pid":42}' })
      .mockReturnValueOnce({ status: 0, stdout: '{"state":"ready","pid":42}' });
    let clock = 0;
    const delays = [];
    const result = await startVerifiedRuntimeDaemon(verified, {
      syncSpawn, childSpawn: jest.fn(), timeoutMs: 300, now: () => clock,
      delay: async (ms) => { delays.push(ms); clock += ms; },
    });
    expect(result.status).toBe('already_running');
    expect(delays).toEqual([250, 50]);
  });
});
