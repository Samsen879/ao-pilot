import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindRepoRoot = jest.fn();
const mockCreateStateRepository = jest.fn();
const mockCreateReviewProtocol = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/repo-root.js', () => ({
  findRepoRoot: mockFindRepoRoot,
}));

jest.unstable_mockModule('../../scripts/ao/lib/state-repository.js', () => ({
  createStateRepository: mockCreateStateRepository,
}));

jest.unstable_mockModule('../../scripts/ao/lib/review-protocol.js', () => ({
  createReviewProtocol: mockCreateReviewProtocol,
}));

const { runCli } = await import('../../scripts/ao-review.js');

describe('ao review cli', () => {
  let protocol;

  beforeEach(() => {
    mockFindRepoRoot.mockReset();
    mockCreateStateRepository.mockReset();
    mockCreateReviewProtocol.mockReset();

    mockFindRepoRoot.mockReturnValue('/repo');
    mockCreateStateRepository.mockReturnValue({
      kind: 'repository',
      getSnapshot: () => ({
        state: {
          managed_tasks: [],
          review_records: [],
        },
      }),
    });
    protocol = {
      requestReview: jest.fn().mockReturnValue({
        review_id: 'review-issue-125-1',
        task_id: 'issue-125',
        status: 'open',
        target_head_sha: 'abc123',
        freeze_status: 'active',
      }),
      claimReview: jest.fn().mockReturnValue({
        review_id: 'review-issue-125-1',
        task_id: 'issue-125',
        status: 'claimed',
        reviewer_session_name: 'worker-125-review',
        freeze_status: 'active',
      }),
      recordVerdict: jest.fn().mockReturnValue({
        review_id: 'review-issue-125-1',
        task_id: 'issue-125',
        status: 'passed',
        verdict: 'pass',
        freeze_status: 'released',
      }),
      inspectTaskReview: jest.fn().mockReturnValue({
        review_id: 'review-issue-125-1',
        task_id: 'issue-125',
        status: 'claimed',
        verdict: null,
        reviewer_session_name: 'worker-125-review',
        target_head_sha: 'abc123',
        freeze_status: 'active',
        posture: 'review_pending',
        freeze_active: true,
      }),
    };
    mockCreateReviewProtocol.mockReturnValue(protocol);
  });

  it('dispatches request in JSON mode with explicit review-target metadata', async () => {
    const stdout = [];

    const result = await runCli([
      'request',
      '--issue', '125',
      '--requested-by-session', 'worker-125-impl',
      '--requested-by-session-id', 'session-125-impl',
      '--implementation-session', 'worker-125-impl',
      '--implementation-session-id', 'session-125-impl',
      '--target-branch', 'task/125-reviewer-gate',
      '--target-sha', 'abc123',
      '--verification-baseline-json',
      '[{"category":"workspace_sanity","commands":["git status --short"]}]',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockCreateStateRepository).toHaveBeenCalledWith({
      repoRoot: '/repo',
      projectId: 'my-project',
    });
    expect(protocol.requestReview).toHaveBeenCalledWith({
      taskId: null,
      issueNumber: 125,
      requestedBySessionName: 'worker-125-impl',
      requestedBySessionId: 'session-125-impl',
      implementationSessionName: 'worker-125-impl',
      implementationSessionId: 'session-125-impl',
      targetBranch: 'task/125-reviewer-gate',
      targetHeadSha: 'abc123',
      verificationBaseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
      reviewId: null,
      reviewerSessionName: null,
      reviewerSessionId: null,
      verdict: null,
      findingsSummary: [],
      baselineExecution: null,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      review_id: 'review-issue-125-1',
      status: 'open',
      target_head_sha: 'abc123',
    });
  });

  it('dispatches verdict in JSON mode with findings and baseline execution evidence', async () => {
    const stdout = [];

    const result = await runCli([
      'verdict',
      '--review', 'review-issue-125-1',
      '--verdict', 'pass',
      '--findings-summary-json', '[]',
      '--baseline-execution-json',
      '{"status":"attested","summary":"Required baseline commands executed.","recorded_at":"2026-04-03T14:40:00.000Z","attested_by_session_name":"worker-125-review","attested_by_session_id":"session-125-review","commands_run":["git status --short"]}',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(protocol.recordVerdict).toHaveBeenCalledWith({
      reviewId: 'review-issue-125-1',
      taskId: null,
      issueNumber: null,
      verdict: 'pass',
      findingsSummary: [],
      baselineExecution: {
        status: 'attested',
        summary: 'Required baseline commands executed.',
        recorded_at: '2026-04-03T14:40:00.000Z',
        attested_by_session_name: 'worker-125-review',
        attested_by_session_id: 'session-125-review',
        commands_run: ['git status --short'],
      },
      requestedBySessionName: null,
      requestedBySessionId: null,
      implementationSessionName: null,
      implementationSessionId: null,
      reviewerSessionName: null,
      reviewerSessionId: null,
      targetBranch: null,
      targetHeadSha: null,
      verificationBaseline: [],
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      review_id: 'review-issue-125-1',
      status: 'passed',
      verdict: 'pass',
    });
  });

  it('dispatches inspect against a task scope and renders operator-facing posture output', async () => {
    const stdout = [];

    const result = await runCli(['inspect', '--issue', '125'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(protocol.inspectTaskReview).toHaveBeenCalledWith({
      taskId: null,
      issueNumber: 125,
      reviewId: null,
    });
    expect(stdout.join('')).toContain('posture: review_pending');
    expect(stdout.join('')).toContain('freeze: active');
    expect(stdout.join('')).toContain('reviewer: worker-125-review');
  });

  it('surfaces same-session claim rejection through the cli', async () => {
    const stderr = [];
    protocol.claimReview.mockImplementation(() => {
      throw new Error('Independent reviewer session required.');
    });

    const result = await runCli([
      'claim',
      '--review', 'review-issue-125-1',
      '--reviewer-session', 'worker-125-impl',
      '--reviewer-session-id', 'session-125-impl',
    ], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(3);
    expect(protocol.claimReview).toHaveBeenCalledWith({
      reviewId: 'review-issue-125-1',
      taskId: null,
      issueNumber: null,
      reviewerSessionName: 'worker-125-impl',
      reviewerSessionId: 'session-125-impl',
      requestedBySessionName: null,
      requestedBySessionId: null,
      implementationSessionName: null,
      implementationSessionId: null,
      targetBranch: null,
      targetHeadSha: null,
      verificationBaseline: [],
      verdict: null,
      findingsSummary: [],
      baselineExecution: null,
    });
    expect(stderr.join('')).toContain('Independent reviewer session required.');
  });

  it('rejects invalid verdicts before touching the repo', async () => {
    const stderr = [];

    const result = await runCli(['verdict', '--issue', '125', '--verdict', 'ship_it'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockFindRepoRoot).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Invalid value for --verdict');
  });
});
