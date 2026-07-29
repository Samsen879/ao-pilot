import { describe, expect, it, jest } from '@jest/globals';

import {
  createLocalCommandRunner,
} from '../../scripts/ao/lib/providers/command-runner.js';

describe('local command runner provider boundary', () => {
  it('normalizes process execution and keeps arguments separate from the shell', () => {
    const spawn = jest.fn(() => ({
      status: 0,
      signal: null,
      stdout: '{"ok":true}',
      stderr: '',
    }));
    const runner = createLocalCommandRunner({
      spawn,
      baseEnv: {
        BASE_VALUE: 'base',
      },
    });

    expect(runner.run('gh', ['pr', 'view', '42'], {
      env: {
        EXTRA_VALUE: 'extra',
      },
    })).toMatchObject({
      status: 0,
      stdout: '{"ok":true}',
      stderr: '',
      error: null,
    });
    expect(spawn).toHaveBeenCalledWith('gh', ['pr', 'view', '42'], expect.objectContaining({
      encoding: 'utf8',
      env: {
        BASE_VALUE: 'base',
        EXTRA_VALUE: 'extra',
      },
    }));
  });
});
