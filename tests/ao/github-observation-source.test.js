import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSpawnSync = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}));

const { loadGitHubObservationSet } = await import('../../scripts/ao/lib/github-observation-source.js');

describe('github observation source', () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it('loads a single explicit PR in PR-scoped mode', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        number: 44,
        state: 'OPEN',
        headRefName: 'feat/issue-44',
        headRefOid: 'abc123',
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
      stderr: '',
    });

    const set = await loadGitHubObservationSet({
      scope: {
        mode: 'pr',
        selected_pr_numbers: [44],
        selection_basis: ['explicit_pr'],
      },
    });

    expect(set.scope.mode).toBe('pr');
    expect(set.prs[0]).toMatchObject({
      pr_number: 44,
      state: 'OPEN',
      review_status: 'approved',
      ci_status: 'passing',
      mergeability: 'mergeable',
    });
  });

  it('builds AO-linked project selection without scanning all repo PRs', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 40,
          state: 'OPEN',
          headRefName: 'feat/issue-40',
          reviewDecision: 'REVIEW_REQUIRED',
          mergeStateStatus: 'UNKNOWN',
          isDraft: false,
        }),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 41,
          state: 'OPEN',
          headRefName: 'feat/issue-41',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          isDraft: true,
        }),
        stderr: '',
      });

    const set = await loadGitHubObservationSet({
      scope: {
        mode: 'project',
        selected_pr_numbers: [40, 41],
        selection_basis: ['ao_session_pr_reference', 'ao_session_branch_match'],
      },
    });

    expect(set.prs.map((pr) => pr.pr_number)).toEqual([40, 41]);
    expect(mockSpawnSync).toHaveBeenCalledTimes(2);
    expect(mockSpawnSync.mock.calls[0][1]).toContain('40');
    expect(mockSpawnSync.mock.calls[1][1]).toContain('41');
  });

  it('resolves AO-linked project PRs from worker branch hints when PR numbers are absent', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify([
        {
          number: 48,
          state: 'OPEN',
          headRefName: 'feat/issue-48',
          headRefOid: 'def456',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          isDraft: false,
          statusCheckRollup: [
            { status: 'COMPLETED', conclusion: 'SUCCESS' },
          ],
          url: 'https://github.com/example/repo/pull/48',
        },
      ]),
      stderr: '',
    });

    const set = await loadGitHubObservationSet({
      scope: {
        mode: 'project',
        selected_pr_numbers: [],
        selection_basis: ['ao_session_branch_match'],
        selection_notes: ['branch:feat/issue-48'],
      },
    });

    expect(set.prs).toHaveLength(1);
    expect(set.prs[0]).toMatchObject({
      pr_number: 48,
      head_branch: 'feat/issue-48',
      review_status: 'approved',
      ci_status: 'passing',
      mergeability: 'mergeable',
    });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    expect(mockSpawnSync.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'pr',
      'list',
      '--state',
      'open',
      '--head',
      'feat/issue-48',
    ]));
  });

  it('normalizes unknown mergeability and source failure explicitly', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: 'gh auth missing',
    });

    const set = await loadGitHubObservationSet({
      scope: {
        mode: 'pr',
        selected_pr_numbers: [44],
        selection_basis: ['explicit_pr'],
      },
    });

    expect(set.source_ok).toBe(false);
    expect(set.source_error).toMatch(/gh auth missing/);
  });

  it('normalizes review-comment metadata for protocolized delivery ingest', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        number: 106,
        state: 'OPEN',
        headRefName: 'feat/106',
        headRefOid: 'abc123',
        reviewDecision: 'APPROVED',
        mergeStateStatus: 'CLEAN',
        isDraft: false,
        statusCheckRollup: [
          { status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
        reviews: [
          {
            id: 'review-1',
            state: 'COMMENTED',
            author: { login: 'chatgpt-codex-connector' },
            submittedAt: '2026-03-30T08:52:11Z',
            commit: { oid: 'abc123' },
          },
        ],
      }),
      stderr: '',
    });

    const set = await loadGitHubObservationSet({
      scope: {
        mode: 'pr',
        selected_pr_numbers: [106],
        selection_basis: ['explicit_pr'],
      },
      now: '2026-03-30T08:53:00.000Z',
    });

    expect(set.prs[0]).toMatchObject({
      pr_number: 106,
      head_sha: 'abc123',
      review_status: 'approved',
      reviews: [
        {
          review_id: 'review-1',
          state: 'commented',
          author_login: 'chatgpt-codex-connector',
          submitted_at: '2026-03-30T08:52:11.000Z',
          commit_oid: 'abc123',
        },
      ],
    });
  });
});
