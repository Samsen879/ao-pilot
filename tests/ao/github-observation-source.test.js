import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSpawnSync = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawnSync: mockSpawnSync,
}));

const { loadGitHubMergeObservation, loadGitHubObservationSet } = await import('../../scripts/ao/lib/github-observation-source.js');

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

  it('loads an exact-live authoritative post-merge GitHub observation', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: 123,
          full_name: 'Samsen879/ao-pilot',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        number: 85,
        state: 'closed',
        merged: true,
        base: {
          ref: 'main',
          sha: '0'.repeat(40),
          repo: { id: 123, full_name: 'Samsen879/ao-pilot' },
        },
        head: { sha: '1'.repeat(40) },
        merge_commit_sha: '2'.repeat(40),
        merged_at: '2026-08-09T12:31:00Z',
        url: 'https://api.github.com/repos/Samsen879/ao-pilot/pulls/85',
        html_url: 'https://github.com/Samsen879/ao-pilot/pull/85',
      }),
      stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: `${JSON.stringify({
          id: 456,
          url: 'https://api.github.com/repos/Samsen879/ao-pilot/issues/events/456',
          event: 'merged',
          commit_id: '2'.repeat(40),
          created_at: '2026-08-09T12:31:00Z',
        })}\n`,
        stderr: '',
      });
    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });
    expect(observation).toMatchObject({
      schema_version: 'ao.github-merge-observation.v1',
      provider: 'github',
      source_ok: true,
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      pull_request: {
        number: 85,
        state: 'MERGED',
        base_ref: 'main',
        base_sha: '0'.repeat(40),
        head_sha: '1'.repeat(40),
        merge_commit_sha: '2'.repeat(40),
        merged_at: '2026-08-09T12:31:00.000Z',
      },
    });
    expect(mockSpawnSync.mock.calls[0][1]).toEqual([
      'api', '--hostname', 'github.com', 'repos/Samsen879/ao-pilot',
    ]);
    expect(mockSpawnSync.mock.calls[1][1]).toEqual([
      'api', '--hostname', 'github.com', 'repos/Samsen879/ao-pilot/pulls/85',
    ]);
    expect(mockSpawnSync.mock.calls[2][1]).toEqual([
      'api', '--hostname', 'github.com', '--paginate',
      'repos/Samsen879/ao-pilot/issues/85/events?per_page=100',
      '--jq', '.[] | select(.event == "merged") | {id,url,event,commit_id,created_at}',
    ]);
    expect(observation.evidence_refs).toContain(
      'https://api.github.com/repos/Samsen879/ao-pilot/issues/events/456',
    );
  });

  it('fails closed when the slug resolves to another immutable repository id', async () => {
    mockSpawnSync.mockReturnValueOnce({
      status: 0,
      stdout: JSON.stringify({
        id: 999,
        full_name: 'Samsen879/ao-pilot',
        url: 'https://api.github.com/repos/Samsen879/ao-pilot',
      }),
      stderr: '',
    });
    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });
    expect(observation).toMatchObject({
      source_ok: false,
      source_error: 'github_repository_identity_mismatch',
    });
    expect(mockSpawnSync).toHaveBeenCalledTimes(1);
  });

  it('fails closed when exact pull request evidence is missing', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: 123,
          full_name: 'Samsen879/ao-pilot',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 85,
          state: 'closed',
          merged: true,
          base: {
            ref: 'main',
            repo: { id: 123, full_name: 'Samsen879/ao-pilot' },
          },
          head: { sha: '1'.repeat(40) },
          merge_commit_sha: '2'.repeat(40),
          merged_at: '2026-08-09T12:31:00Z',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot/pulls/85',
          html_url: 'https://github.com/Samsen879/ao-pilot/pull/85',
        }),
        stderr: '',
      });

    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });

    expect(observation).toMatchObject({
      source_ok: false,
      source_error: 'github_merge_evidence_missing',
      pull_request: { base_sha: null },
    });
  });

  it('fails closed when provider merge state is ambiguous', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: 123,
          full_name: 'Samsen879/ao-pilot',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 85,
          state: 'open',
          merged: true,
          base: { repo: { id: 123, full_name: 'Samsen879/ao-pilot' } },
        }),
        stderr: '',
      });

    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });

    expect(observation).toMatchObject({
      source_ok: false,
      source_error: 'github_merge_state_ambiguous',
    });
  });

  it('fails closed when immutable merged-event evidence is missing', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: 123,
          full_name: 'Samsen879/ao-pilot',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          number: 85,
          state: 'closed',
          merged: true,
          base: {
            ref: 'main',
            sha: '0'.repeat(40),
            repo: { id: 123, full_name: 'Samsen879/ao-pilot' },
          },
          head: { sha: '1'.repeat(40) },
          merge_commit_sha: '2'.repeat(40),
          merged_at: '2026-08-09T12:31:00Z',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot/pulls/85',
          html_url: 'https://github.com/Samsen879/ao-pilot/pull/85',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });

    expect(observation).toMatchObject({
      source_ok: false,
      source_error: 'github_merge_event_ambiguous',
    });
  });

  it('fails closed when the supported pull request API call fails', async () => {
    mockSpawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          id: 123,
          full_name: 'Samsen879/ao-pilot',
          url: 'https://api.github.com/repos/Samsen879/ao-pilot',
        }),
        stderr: '',
      })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'provider unavailable' });

    const observation = await loadGitHubMergeObservation({
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    });

    expect(observation).toMatchObject({ source_ok: false });
    expect(observation.source_error).toMatch(/provider unavailable/);
  });

  it('replays identical provider evidence deterministically at the same observation time', async () => {
    const repositoryPayload = JSON.stringify({
      id: 123,
      full_name: 'Samsen879/ao-pilot',
      url: 'https://api.github.com/repos/Samsen879/ao-pilot',
    });
    const pullPayload = JSON.stringify({
      number: 85,
      state: 'closed',
      merged: true,
      base: {
        ref: 'main',
        sha: '0'.repeat(40),
        repo: { id: 123, full_name: 'Samsen879/ao-pilot' },
      },
      head: { sha: '1'.repeat(40) },
      merge_commit_sha: '2'.repeat(40),
      merged_at: '2026-08-09T12:31:00Z',
      url: 'https://api.github.com/repos/Samsen879/ao-pilot/pulls/85',
      html_url: 'https://github.com/Samsen879/ao-pilot/pull/85',
    });
    const eventPayload = `${JSON.stringify({
      id: 456,
      url: 'https://api.github.com/repos/Samsen879/ao-pilot/issues/events/456',
      event: 'merged',
      commit_id: '2'.repeat(40),
      created_at: '2026-08-09T12:31:00Z',
    })}\n`;
    for (let index = 0; index < 2; index += 1) {
      mockSpawnSync
        .mockReturnValueOnce({ status: 0, stdout: repositoryPayload, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: pullPayload, stderr: '' })
        .mockReturnValueOnce({ status: 0, stdout: eventPayload, stderr: '' });
    }
    const input = {
      repository: { repository_id: 123, slug: 'Samsen879/ao-pilot' },
      prNumber: 85,
      now: '2026-08-09T12:32:00.000Z',
    };

    const first = await loadGitHubMergeObservation(input);
    const second = await loadGitHubMergeObservation(input);

    expect(second).toEqual(first);
  });

  it('returns a schema-shaped nullable failure observation for invalid scope', async () => {
    const observation = await loadGitHubMergeObservation({
      repository: null,
      prNumber: null,
      now: '2026-08-09T12:32:00.000Z',
    });
    expect(observation).toEqual({
      schema_version: 'ao.github-merge-observation.v1',
      provider: 'github',
      source_ok: false,
      source_error: 'invalid_exact_merge_observation_scope',
      observed_at: '2026-08-09T12:32:00.000Z',
      repository: { repository_id: null, slug: null },
      pull_request: {
        number: null,
        state: 'UNKNOWN',
        base_ref: null,
        base_sha: null,
        head_sha: null,
        merge_commit_sha: null,
        merged_at: null,
        url: null,
      },
      evidence_refs: [],
    });
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
