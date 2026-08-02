import { describe, expect, it, jest } from '@jest/globals';

import {
  buildRuntimeArguments,
  parseRuntimeArgs,
  runCli,
} from '../../scripts/ao-runtime.js';

const runtime = {
  status: 'verified',
  runtime_ref: 'runtime.test.v1',
  lock_digest: 'sha256:lock',
  source: {
    repository: 'https://github.com/example/runtime.git',
    version: '1.2.3',
    commit_sha: '1'.repeat(40),
    tree_sha: '2'.repeat(40),
    integrity: { algorithm: 'git-tree-sha1', digest: '2'.repeat(40) },
  },
  binary_path: '/managed/runtime/bin/ao',
  binary_sha256: 'a'.repeat(64),
  bootstrap_receipt_path: '/managed/runtime/runtime-bootstrap.json',
};

function createIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

describe('ao-pilot runtime lifecycle CLI', () => {
  it('maps lifecycle options to the locked runtime CLI contract', () => {
    expect(buildRuntimeArguments(parseRuntimeArgs([
      'start', '--project', 'portable',
    ]))).toEqual(['daemon']);
    expect(buildRuntimeArguments(parseRuntimeArgs([
      'stop', '--project', 'portable',
    ]))).toEqual(['stop', '--json']);
    expect(buildRuntimeArguments(parseRuntimeArgs([
      'status', '--project', 'portable', '--json',
    ]))).toEqual(['status', '--json']);
  });

  it('prints exact runtime provenance without invoking the runtime', async () => {
    const output = createIo();
    const executeRuntime = jest.fn();
    const result = await runCli(['runtime-path', '--json', '--project', 'portable'], output.io, {
      resolveRuntime: () => runtime,
      executeRuntime,
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      status: 'verified',
      runtime_ref: runtime.runtime_ref,
      binary_path: runtime.binary_path,
      source: { commit_sha: runtime.source.commit_sha },
    });
    expect(executeRuntime).not.toHaveBeenCalled();
  });

  it('executes start through the exact resolved binary contract', async () => {
    const output = createIo();
    const executeRuntime = jest.fn();
    const startDaemon = jest.fn().mockResolvedValue({
      status: 'started',
      exit_code: 0,
      daemon_status: { state: 'ready', pid: 1234 },
    });
    const result = await runCli(['start', '--project', 'portable', '--json'], output.io, {
      resolveRuntime: () => runtime,
      executeRuntime,
      startDaemon,
      cwd: '/repo',
      env: { PATH: '/safe' },
    });

    expect(result.exitCode).toBe(0);
    expect(startDaemon).toHaveBeenCalledWith(runtime, {
      cwd: '/repo', env: { PATH: '/safe' },
    });
    expect(executeRuntime).not.toHaveBeenCalled();
    expect(JSON.parse(output.stdout.join(''))).toMatchObject({
      status: 'started',
      operation: 'start',
      runtime: { binary_path: runtime.binary_path },
      daemon_status: { state: 'ready', pid: 1234 },
    });
  });

  it('rejects desktop-only and unsupported lifecycle flags', () => {
    expect(() => parseRuntimeArgs(['start', '--with-dashboard'])).toThrow('Unknown argument');
    expect(() => parseRuntimeArgs(['stop', '--purge-session'])).toThrow('Unknown argument');
    expect(() => parseRuntimeArgs(['status', '--watch'])).toThrow('Unknown argument');
  });

  it('executes status from the already verified runtime without a second resolution', async () => {
    const output = createIo();
    const resolveRuntime = jest.fn().mockReturnValue(runtime);
    const executeRuntime = jest.fn().mockReturnValue({
      runtime,
      result: {
        status: 0,
        signal: null,
        stdout: '{"state":"ready"}',
        stderr: '',
        error: null,
      },
    });

    const result = await runCli(['status', '--json'], output.io, {
      resolveRuntime,
      executeRuntime,
      cwd: '/repo',
      env: { PATH: '/safe' },
    });

    expect(result.exitCode).toBe(0);
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
    expect(executeRuntime).toHaveBeenCalledWith(
      runtime,
      ['status', '--json'],
      expect.objectContaining({ cwd: '/repo', env: { PATH: '/safe' } }),
    );
  });

  it('returns a structured blocker if resolved execution throws', async () => {
    const output = createIo();
    const error = Object.assign(new Error('binary changed after verification'), {
      code: 'runtime_binary_integrity_mismatch',
    });

    const result = await runCli(['stop', '--json'], output.io, {
      resolveRuntime: () => runtime,
      executeRuntime: () => { throw error; },
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(output.stderr.join(''))).toMatchObject({
      status: 'blocked',
      code: 'runtime_binary_integrity_mismatch',
    });
  });

  it('fails closed and does not execute when a wrong ao shadows the runtime', async () => {
    const output = createIo();
    const executeRuntime = jest.fn();
    const result = await runCli(['status', '--project', 'portable', '--json'], output.io, {
      resolveRuntime: () => {
        const error = new Error('PATH contains a different binary');
        error.code = 'runtime_path_shadowed';
        error.details = { path_candidate: '/wrong/bin/ao' };
        throw error;
      },
      executeRuntime,
    });

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(output.stderr.join(''))).toMatchObject({
      status: 'blocked',
      code: 'runtime_path_shadowed',
    });
    expect(executeRuntime).not.toHaveBeenCalled();
  });
});
