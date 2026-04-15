import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunControllerLoop = jest.fn();
const originalAoSessionName = process.env.AO_SESSION_NAME;
const originalAoSessionId = process.env.AO_SESSION_ID;

jest.unstable_mockModule('../../scripts/ao/lib/controller-loop.js', () => ({
  runControllerLoop: mockRunControllerLoop,
}));

const { runCli } = await import('../../scripts/ao-controller.js');

describe('ao controller cli', () => {
  beforeEach(() => {
    process.env.AO_SESSION_NAME = 'test-controller-holder';
    delete process.env.AO_SESSION_ID;
    mockRunControllerLoop.mockReset();
    mockRunControllerLoop.mockResolvedValue({
      controller_id: 'default',
      mode: 'assist',
      processed_task_count: 1,
      ingested_observation_count: 2,
      proposed_action_count: 2,
      executed_action_count: 1,
      pass_count: 1,
      runtime_kind: 'oneshot',
      stop_reason: 'completed',
      task_results: [],
    });
  });

  afterEach(() => {
    process.env.AO_SESSION_NAME = originalAoSessionName;
    process.env.AO_SESSION_ID = originalAoSessionId;
  });

  it('parses controller mode and scope arguments', async () => {
    const stdout = [];

    const result = await runCli(['--mode', 'assist', '--issue', '89', '--json'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      mode: 'assist',
      issueNumber: 89,
      cwd: process.cwd(),
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      mode: 'assist',
      proposed_action_count: 2,
      executed_action_count: 1,
    });
  });

  it('parses continuous runtime flags', async () => {
    const stdout = [];

    const result = await runCli([
      '--continuous',
      '--poll-interval-ms',
      '15000',
      '--shutdown-timeout-ms',
      '5000',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      continuous: true,
      pollIntervalMs: 15000,
      shutdownTimeoutMs: 5000,
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      runtime_kind: 'oneshot',
      pass_count: 1,
    });
  });

  it('parses an explicit manual holder identity', async () => {
    delete process.env.AO_SESSION_NAME;
    delete process.env.AO_SESSION_ID;
    const stdout = [];

    const result = await runCli([
      '--holder',
      'manual-controller',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunControllerLoop).toHaveBeenCalledWith(expect.objectContaining({
      holderId: 'manual-controller',
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      controller_id: 'default',
    });
  });

  it('rejects invalid controller modes and invalid issue filters', async () => {
    const stderr = [];

    const invalidMode = await runCli(['--mode', 'launch'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidIssue = await runCli(['--issue', 'abc'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidPollInterval = await runCli(['--continuous', '--poll-interval-ms', '0'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(invalidMode.exitCode).toBe(4);
    expect(invalidIssue.exitCode).toBe(4);
    expect(invalidPollInterval.exitCode).toBe(4);
    expect(mockRunControllerLoop).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Invalid value for --mode');
    expect(stderr.join('')).toContain('Invalid value for --issue');
    expect(stderr.join('')).toContain('Invalid value for --poll-interval-ms');
  });

  it('requires --holder for manual starts when AO env is unset', async () => {
    delete process.env.AO_SESSION_NAME;
    delete process.env.AO_SESSION_ID;
    const stderr = [];

    const result = await runCli(['--continuous'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockRunControllerLoop).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Manual controller runs require --holder');
  });

  it('treats missing flag values as normal parse errors', async () => {
    const stderr = [];

    const result = await runCli(['--mode'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockRunControllerLoop).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Missing value for --mode');
  });
});
