import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  createManagedTask,
  createPrBinding,
} from '../../scripts/ao/lib/state-contracts.js';
import { ingestManagedTaskPollEvents } from '../../scripts/ao/lib/event-ingest.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-event-ingest-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao event ingest', () => {
  it('persists new poll-derived observations once and dedupes repeated cursors', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-89',
      issue_number: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50',
      status: 'active',
      created_at: '2026-03-29T06:30:00.000Z',
      updated_at: '2026-03-29T06:30:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-89-pr-109',
      task_id: 'issue-89',
      pr_number: 109,
      branch_name: 'feat/89',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-29T06:30:00.000Z',
      updated_at: '2026-03-29T06:30:00.000Z',
    }));

    const task = repository.getSnapshot().state.managed_tasks[0];
    const prBindings = repository.getSnapshot().state.pr_bindings;
    const aoObservation = {
      observed_at: '2026-03-29T06:31:00.000Z',
      workers: [
        {
          session_name: 'worker-50',
          session_runtime_id: 'worker-50',
          issue_number: 89,
          branch_name: 'feat/89',
          pr_number: 109,
          lifecycle_state: 'idle',
          last_seen_at: '2026-03-29T06:30:45.000Z',
          freshness: { status: 'fresh' },
        },
      ],
    };
    const githubObservation = {
      observed_at: '2026-03-29T06:31:00.000Z',
      prs: [
        {
          pr_number: 109,
          state: 'OPEN',
          head_branch: 'feat/89',
          head_sha: 'abc123',
          review_status: 'pending',
          ci_status: 'pending',
          mergeability: 'mergeable',
          is_draft: false,
          url: 'https://example.test/pr/109',
        },
      ],
    };

    const firstResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation,
      now: '2026-03-29T06:31:00.000Z',
    });
    const secondResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation,
      now: '2026-03-29T06:32:00.000Z',
    });
    const thirdResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation: {
        ...githubObservation,
        observed_at: '2026-03-29T06:33:00.000Z',
        prs: [
          {
            ...githubObservation.prs[0],
            ci_status: 'failing',
            head_sha: 'def456',
          },
        ],
      },
      now: '2026-03-29T06:33:00.000Z',
    });

    expect(firstResult).toMatchObject({
      task_id: 'issue-89',
      ingested_count: 2,
      skipped_count: 0,
    });
    expect(secondResult).toMatchObject({
      ingested_count: 0,
      skipped_count: 2,
    });
    expect(thirdResult).toMatchObject({
      ingested_count: 1,
      skipped_count: 1,
      delivery_event_count: 3,
    });

    const snapshot = repository.getSnapshot().state;
    expect(snapshot.observations).toHaveLength(3);
    expect(snapshot.delivery_events).toHaveLength(6);
    expect(snapshot.controller_cursors).toHaveLength(2);
    expect(snapshot.controller_cursors.find((record) => record.source_kind === 'github_poll')).toMatchObject({
      task_id: 'issue-89',
      source_kind: 'github_poll',
      observed_at: '2026-03-29T06:33:00.000Z',
    });
    expect(snapshot.delivery_events.map((record) => record.event_family)).toEqual(expect.arrayContaining([
      'pr',
      'check',
      'review',
    ]));
  });

  it('dedupes repeated review-comment loops and preserves durable lineage per head sha', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-106',
      issue_number: 106,
      title: 'Protocolize delivery events',
      branch_name: 'feat/106',
      worktree_path: '/tmp/worker-53',
      status: 'active',
      created_at: '2026-03-30T08:30:00.000Z',
      updated_at: '2026-03-30T08:30:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-106-pr-112',
      task_id: 'issue-106',
      pr_number: 112,
      branch_name: 'feat/106',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-30T08:30:00.000Z',
      updated_at: '2026-03-30T08:30:00.000Z',
    }));

    const task = repository.getSnapshot().state.managed_tasks[0];
    const prBindings = repository.getSnapshot().state.pr_bindings;
    const aoObservation = {
      observed_at: '2026-03-30T08:31:00.000Z',
      workers: [
        {
          session_name: 'worker-53',
          session_runtime_id: 'worker-53',
          issue_number: 106,
          branch_name: 'feat/106',
          pr_number: 112,
          lifecycle_state: 'idle',
          last_seen_at: '2026-03-30T08:30:45.000Z',
          freshness: { status: 'fresh' },
        },
      ],
    };

    const firstGitHubObservation = {
      observed_at: '2026-03-30T08:31:00.000Z',
      prs: [
        {
          pr_number: 112,
          state: 'OPEN',
          head_branch: 'feat/106',
          head_sha: 'abc123',
          review_status: 'changes_requested',
          ci_status: 'passing',
          mergeability: 'mergeable',
          is_draft: false,
          url: 'https://example.test/pr/112',
          reviews: [
            {
              review_id: 'review-comment-1',
              state: 'commented',
              author_login: 'chatgpt-codex-connector',
              submitted_at: '2026-03-30T08:30:50.000Z',
              commit_oid: 'abc123',
            },
          ],
        },
      ],
    };

    const firstResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation: firstGitHubObservation,
      now: '2026-03-30T08:31:00.000Z',
    });
    const secondResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation: firstGitHubObservation,
      now: '2026-03-30T08:32:00.000Z',
    });
    const thirdResult = ingestManagedTaskPollEvents({
      repository,
      controllerId: 'default',
      task,
      prBindings,
      aoObservation,
      githubObservation: {
        observed_at: '2026-03-30T08:33:00.000Z',
        prs: [
          {
            ...firstGitHubObservation.prs[0],
            head_sha: 'def456',
            reviews: [
              {
                review_id: 'review-comment-2',
                state: 'commented',
                author_login: 'chatgpt-codex-connector',
                submitted_at: '2026-03-30T08:32:45.000Z',
                commit_oid: 'def456',
              },
            ],
          },
        ],
      },
      now: '2026-03-30T08:33:00.000Z',
    });

    expect(firstResult).toMatchObject({
      ingested_count: 2,
      delivery_event_count: 4,
    });
    expect(secondResult).toMatchObject({
      ingested_count: 0,
      delivery_event_count: 0,
    });
    expect(thirdResult).toMatchObject({
      ingested_count: 1,
      delivery_event_count: 4,
    });

    const snapshot = repository.getSnapshot().state;
    const reviewCommentEvents = snapshot.delivery_events
      .filter((record) => record.event_family === 'review_comment')
      .sort((left, right) => String(left.payload.commit_oid ?? '').localeCompare(String(right.payload.commit_oid ?? '')));

    expect(reviewCommentEvents).toHaveLength(2);
    expect(reviewCommentEvents.map((record) => record.payload.review_id)).toEqual([
      'review-comment-1',
      'review-comment-2',
    ]);
    expect(reviewCommentEvents.map((record) => record.payload.commit_oid)).toEqual([
      'abc123',
      'def456',
    ]);
    expect(reviewCommentEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lifecycle_trigger: 'bugbot_comments',
        controller_action_hint: 'hold_review',
        lineage: expect.objectContaining({
          source_observation_id: expect.stringContaining('issue-106:github_poll:'),
        }),
      }),
    ]));
  });

  it('keeps conservative delivery hints by default and supports explicit auto-merge opt-in', () => {
    const ingestReadyPr = (releaseReadyAction) => {
      const repository = createStateRepository({
        repoRoot: createTempRepo(),
        projectId: PROJECT_ID,
      });
      repository.upsertManagedTask(createManagedTask({
        task_id: 'issue-120',
        issue_number: 120,
        title: 'Release-ready action policy',
        branch_name: 'feat/120',
        worktree_path: '/tmp/worker-120',
        status: 'active',
        created_at: '2026-03-30T09:00:00.000Z',
        updated_at: '2026-03-30T09:00:00.000Z',
      }));
      repository.upsertPrBinding(createPrBinding({
        binding_id: 'binding-issue-120-pr-120',
        task_id: 'issue-120',
        pr_number: 120,
        branch_name: 'feat/120',
        base_branch: 'main',
        status: 'bound',
        created_at: '2026-03-30T09:00:00.000Z',
        updated_at: '2026-03-30T09:00:00.000Z',
      }));
      const snapshot = repository.getSnapshot().state;
      ingestManagedTaskPollEvents({
        repository,
        task: snapshot.managed_tasks[0],
        prBindings: snapshot.pr_bindings,
        aoObservation: { observed_at: '2026-03-30T09:01:00.000Z', workers: [] },
        githubObservation: {
          observed_at: '2026-03-30T09:01:00.000Z',
          prs: [{
            pr_number: 120,
            state: 'OPEN',
            head_branch: 'feat/120',
            head_sha: 'head-120',
            review_status: 'approved',
            ci_status: 'passing',
            mergeability: 'mergeable',
            is_draft: false,
          }],
        },
        ...(releaseReadyAction == null ? {} : { releaseReadyAction }),
        now: '2026-03-30T09:01:00.000Z',
      });
      return repository.getSnapshot().state.delivery_events.find((event) => event.event_family === 'pr');
    };

    expect(ingestReadyPr(null)).toMatchObject({
      lifecycle_trigger: 'approved_and_green',
      controller_action_hint: 'notify_human_ready',
    });
    expect(ingestReadyPr('auto_merge_ready_pr')).toMatchObject({
      lifecycle_trigger: 'approved_and_green',
      controller_action_hint: 'auto_merge_ready_pr',
    });
  });
});
