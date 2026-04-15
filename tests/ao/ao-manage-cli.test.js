import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunManageCommand = jest.fn();
const tempDirs = [];

jest.unstable_mockModule('../../scripts/ao/lib/manage-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  runManageCommand: mockRunManageCommand,
}));

const { runCli } = await import('../../scripts/ao-manage.js');

describe('ao manage cli', () => {
  beforeEach(() => {
    mockRunManageCommand.mockReset();
    mockRunManageCommand.mockResolvedValue({
      command: 'enroll',
      task: {
        task_id: 'issue-89',
        status: 'active',
      },
      prBinding: null,
      ownershipLease: null,
    });
    process.env.AO_SESSION_NAME = 'worker-50';
    process.env.AO_SESSION_ID = 'worker-50';
  });

  afterEach(() => {
    while (tempDirs.length) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  it('parses enroll arguments and forwards them to the manage runner', async () => {
    const stdout = [];
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-manage-cli-'));
    tempDirs.push(tempRoot);
    const taskSpecPath = path.join(tempRoot, 'task-spec.md');
    fs.writeFileSync(taskSpecPath, '## Problem Type\nissue_delivery\n', 'utf8');

    const result = await runCli([
      'enroll',
      '--issue',
      '89',
      '--title',
      'Managed-task enrollment and shadow controller loop',
      '--branch',
      'feat/89',
      '--worktree',
      '/tmp/worker-50',
      '--task-spec-file',
      taskSpecPath,
      '--pr',
      '109',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunManageCommand).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      command: 'enroll',
      issueNumber: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50',
      taskSpecBody: '## Problem Type\nissue_delivery\n',
      prNumber: 109,
      ownerSessionName: 'worker-50',
      ownerSessionId: 'worker-50',
      cwd: process.cwd(),
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      task: {
        task_id: 'issue-89',
      },
    });
  });

  it('accepts resume as an explicit command without requiring branch or worktree flags', async () => {
    const result = await runCli([
      'resume',
      '--issue',
      '110',
      '--owner-session',
      'worker-57',
      '--owner-session-id',
      'worker-57',
      '--json',
    ], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunManageCommand).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      command: 'resume',
      issueNumber: 110,
      ownerSessionName: 'worker-57',
      ownerSessionId: 'worker-57',
      cwd: process.cwd(),
    }));
  });

  it('renders continuity posture in the human summary', async () => {
    mockRunManageCommand.mockResolvedValue({
      command: 'resume',
      task: {
        task_id: 'issue-117',
        status: 'active',
      },
      prBinding: {
        pr_number: 117,
        status: 'bound',
      },
      ownershipLease: {
        owner_session_name: 'worker-59',
        status: 'active',
      },
      resume: {
        checkpoint_id: 'checkpoint-issue-117-abc',
        state: 'valid',
      },
      handoffTransfer: {
        request_id: 'handoff-issue-117-1',
        transfer_id: 'transfer-issue-117-1',
      },
      continuity: {
        posture: 'handoff_granted',
        recommended_action: 'handoff_to_successor',
        owner_session_name: 'worker-58',
        successor_session_name: 'worker-59',
        checkpoint_state: 'valid',
      },
      review: {
        posture: 'review_pending',
        freeze_status: 'active',
        reviewer_session_name: null,
        target_head_sha: 'abc123',
        blocking_reason: 'independent_review_active',
      },
      releasedOwnershipLeaseIds: [],
      releasedPrBindingIds: [],
    });
    const stdout = [];

    const result = await runCli([
      'resume',
      '--issue',
      '117',
      '--owner-session',
      'worker-59',
      '--owner-session-id',
      'worker-59',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join('')).toContain('continuity: handoff_granted -> handoff_to_successor owner=worker-58 successor=worker-59 checkpoint=valid');
    expect(stdout.join('')).toContain('review: review_pending freeze=active reviewer=none target=abc123 reason=independent_review_active');
  });

  it('rejects unsupported commands and invalid numeric arguments', async () => {
    const stderr = [];

    const invalidCommand = await runCli(['launch'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidIssue = await runCli(['enroll', '--issue', 'abc'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(invalidCommand.exitCode).toBe(4);
    expect(invalidIssue.exitCode).toBe(4);
    expect(mockRunManageCommand).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Unsupported command');
    expect(stderr.join('')).toContain('Invalid value for --issue');
  });
});
