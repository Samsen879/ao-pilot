import { describe, expect, it, jest } from '@jest/globals';

import { parseBootstrapArgs, runCli } from '../../scripts/bootstrap-runtime.js';

function io() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    adapter: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

describe('runtime bootstrap CLI', () => {
  it('parses explicit managed paths and recovery modes', () => {
    expect(parseBootstrapArgs([
      '--store', '/tmp/store', '--cache', '/tmp/cache', '--offline', '--reinstall', '--json',
    ], {})).toEqual({
      storeRoot: '/tmp/store',
      cacheRoot: '/tmp/cache',
      offline: true,
      reinstall: true,
      json: true,
      help: false,
    });
  });

  it('emits exact provenance as JSON without invoking a PATH ao', async () => {
    const output = io();
    const bootstrap = jest.fn(async (options) => ({
      status: 'installed',
      store_root: options.storeRoot,
      cache_root: options.cacheRoot,
      offline: options.offline,
      reinstall: options.reinstall,
      recovered_interrupted_bootstrap: false,
      runtime: {
        runtime_ref: 'runtime.test',
        runtime_directory: '/tmp/store/runtime.test',
        binary_path: '/tmp/store/runtime.test/bin/ao',
        binary_sha256: 'a'.repeat(64),
        lock_digest: `sha256:${'b'.repeat(64)}`,
        source: {
          repository: 'https://github.com/example/runtime.git',
          tag: 'immutable',
          tag_object_sha: 'c'.repeat(40),
          commit_sha: 'd'.repeat(40),
          tree_sha: 'e'.repeat(40),
        },
      },
    }));
    const result = await runCli([
      '--store', '/tmp/store', '--cache', '/tmp/cache', '--offline', '--json',
    ], output.adapter, { bootstrap, env: { PATH: '/wrong/ao' }, cwd: '/tmp' });
    expect(result.exitCode).toBe(0);
    expect(bootstrap).toHaveBeenCalledWith(expect.objectContaining({
      storeRoot: '/tmp/store',
      cacheRoot: '/tmp/cache',
      offline: true,
      env: { PATH: '/wrong/ao' },
    }));
    expect(JSON.parse(output.stdout.join('')).runtime.source.commit_sha).toBe('d'.repeat(40));
  });

  it('fails closed with a machine-readable diagnostic', async () => {
    const output = io();
    const result = await runCli(['--json'], output.adapter, {
      env: { XDG_DATA_HOME: '/tmp/data', XDG_CACHE_HOME: '/tmp/cache' },
      bootstrap: async () => {
        const error = new Error('cache missing');
        error.code = 'runtime_source_cache_missing';
        error.details = { source_cache: '/tmp/cache/source' };
        throw error;
      },
    });
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(output.stderr.join(''))).toEqual(expect.objectContaining({
      status: 'failed',
      code: 'runtime_source_cache_missing',
    }));
  });
});
