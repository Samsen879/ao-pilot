import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindRepoRoot = jest.fn();
const mockCreateStateRepository = jest.fn();
const mockCreateHandoffProtocol = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/repo-root.js', () => ({
  findRepoRoot: mockFindRepoRoot,
}));

jest.unstable_mockModule('../../scripts/ao/lib/state-repository.js', () => ({
  createStateRepository: mockCreateStateRepository,
}));

jest.unstable_mockModule('../../scripts/ao/lib/handoff-protocol.js', () => ({
  createHandoffProtocol: mockCreateHandoffProtocol,
}));

const { runCli } = await import('../../scripts/ao-handoff.js');

describe('ao handoff cli', () => {
  beforeEach(() => {
    mockFindRepoRoot.mockReset();
    mockCreateStateRepository.mockReset();
    mockCreateHandoffProtocol.mockReset();

    mockFindRepoRoot.mockReturnValue('/repo');
    mockCreateStateRepository.mockReturnValue({
      kind: 'repository',
      getSnapshot: () => ({
        state: {
          managed_tasks: [
            {
              task_id: 'issue-117',
              issue_number: 117,
              status: 'active',
            },
          ],
          pr_bindings: [
            {
              task_id: 'issue-117',
              pr_number: 117,
              status: 'bound',
            },
          ],
          ownership_leases: [],
          checkpoints: [],
          handoff_requests: [],
          handoff_claims: [],
          handoff_decisions: [],
          handoff_transfers: [],
        },
      }),
    });
    mockCreateHandoffProtocol.mockReturnValue({
      requestHandoff: jest.fn().mockReturnValue({
        request_id: 'handoff-issue-117',
        task_id: 'issue-117',
        status: 'open',
        successor_session_name: 'worker-59',
      }),
      claimHandoff: jest.fn(),
      acceptHandoff: jest.fn(),
      rejectHandoff: jest.fn(),
      expireHandoff: jest.fn(),
      inspectTaskHandoff: jest.fn().mockReturnValue({
        task_id: 'issue-117',
        top_status: 'accepted',
        reason_codes: [],
        request_id: 'handoff-issue-117',
        request: {
          selected_claim_id: 'claim-1',
        },
        claims: [
          {
            claim_id: 'claim-1',
            successor_session_name: 'worker-59',
          },
        ],
        checkpoint: {
          checkpoint_id: 'checkpoint-issue-117-abc',
          state: 'valid',
        },
      }),
      inspectAllHandoffs: jest.fn().mockReturnValue([]),
    });
  });

  it('dispatches request in JSON mode with explicit successor and operator surfaces', async () => {
    const stdout = [];

    const result = await runCli([
      'request',
      '--issue', '117',
      '--successor-session', 'worker-59',
      '--successor-session-id', 'worker-59',
      '--operator-session', 'operator-1',
      '--operator-session-id', 'operator-1',
      '--reason', 'owner_stale',
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
    expect(mockCreateHandoffProtocol().requestHandoff).toHaveBeenCalledWith({
      taskId: null,
      issueNumber: 117,
      requestedBySessionName: null,
      requestedBySessionId: null,
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'owner_stale',
      requestId: null,
      claimId: null,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      request_id: 'handoff-issue-117',
      status: 'open',
    });
  });

  it('dispatches inspect against a task scope', async () => {
    const stdout = [];

    const result = await runCli(['inspect', '--issue', '117', '--json'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockCreateHandoffProtocol().inspectTaskHandoff).toHaveBeenCalledWith({
      taskId: null,
      issueNumber: 117,
      requestId: null,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      task_id: 'issue-117',
      top_status: 'accepted',
      continuity: expect.objectContaining({
        posture: 'handoff_granted',
        recommended_action: 'handoff_to_successor',
        successor_session_name: 'worker-59',
      }),
    });
  });

  it('renders continuity posture in the human inspect summary', async () => {
    const stdout = [];

    const result = await runCli(['inspect', '--issue', '117'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join('')).toContain('continuity: handoff_granted -> handoff_to_successor');
  });

  it('rejects unsupported commands before touching the repo', async () => {
    const stderr = [];

    const result = await runCli(['bogus'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockFindRepoRoot).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Unsupported command');
  });
});
