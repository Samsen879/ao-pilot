import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunOverrideCommand = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/override-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  runOverrideCommand: mockRunOverrideCommand,
}));

const { runCli } = await import('../../scripts/ao-override.js');

describe('ao override cli', () => {
  beforeEach(() => {
    mockRunOverrideCommand.mockReset();
    mockRunOverrideCommand.mockResolvedValue({
      command: 'create',
      override: {
        override_id: 'override-1',
        status: 'active',
      },
      overrides: [],
    });
  });

  it('parses create arguments and forwards JSON values to the override runner', async () => {
    const stdout = [];

    const result = await runCli([
      'create',
      '--scope-kind',
      'task',
      '--scope-id',
      'issue-90',
      '--kind',
      'hold_autonomy',
      '--value',
      '{"enabled":true}',
      '--expires-at',
      '2026-03-30T12:00:00.000Z',
      '--created-by',
      'ao-operator',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunOverrideCommand).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(),
      projectId: 'my-project',
      command: 'create',
      scopeKind: 'task',
      scopeId: 'issue-90',
      overrideKind: 'hold_autonomy',
      value: { enabled: true },
      expiresAt: '2026-03-30T12:00:00.000Z',
      createdBy: 'ao-operator',
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      override: {
        override_id: 'override-1',
      },
    });
  });

  it('parses clear requests and rejects invalid commands or malformed JSON', async () => {
    const stderr = [];

    const cleared = await runCli([
      'clear',
      '--override',
      'override-1',
      '--reason',
      'resume_assist_mode',
    ], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidCommand = await runCli(['pause'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidJson = await runCli([
      'create',
      '--scope-kind',
      'task',
      '--scope-id',
      'issue-90',
      '--kind',
      'hold_autonomy',
      '--value',
      '{oops',
    ], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(cleared.exitCode).toBe(0);
    expect(invalidCommand.exitCode).toBe(4);
    expect(invalidJson.exitCode).toBe(4);
    expect(stderr.join('')).toContain('Unsupported command');
    expect(stderr.join('')).toContain('Invalid JSON for --value');
  });
});
