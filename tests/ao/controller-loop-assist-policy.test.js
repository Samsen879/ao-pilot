import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { runControllerLoop } from 'ao-pilot/engines';
import { runRuntimeBootstrapPreflight } from 'ao-pilot/providers';
import { createStateRepository } from 'ao-pilot/repository';
import {
  createControllerModeRecord,
  createManagedTask,
  createPrBinding,
  createReviewRecord,
  createRuntimePreflightRecord,
  createTaskSpecRecord,
} from 'ao-pilot/contracts';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-action-policy-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function seedAssistTask(repository) {
  repository.upsertManagedTask(createManagedTask({
    task_id: 'issue-92',
    issue_number: 92,
    title: 'Guarded auto-merge integration',
    branch_name: 'feat/issue-92',
    worktree_path: '/tmp/worker-92',
    status: 'active',
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: 'binding-issue-92-pr-92',
    task_id: 'issue-92',
    pr_number: 92,
    branch_name: 'feat/issue-92',
    base_branch: 'main',
    status: 'bound',
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
  }));
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: 'default',
    mode: 'assist',
    updated_at: '2026-03-29T06:40:00.000Z',
    updated_by: 'operator',
    reason: 'Guarded auto-merge integration test.',
  }));
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: 'issue-92',
    source_kind: 'github_issue',
    source_issue_number: 92,
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Exact-head merge only.'],
        runtime_ref: 'runtime.github_local',
        policy_ref: 'policy.operator_gated',
        human_gates: ['independent_review'],
      },
    },
  }));
  repository.upsertRuntimePreflight(createRuntimePreflightRecord({
    recorded_at: '2026-03-29T06:40:00.000Z',
    snapshot: runRuntimeBootstrapPreflight({
      runtimeRef: 'runtime.github_local',
      cwd: repository.getSnapshot().paths.repoRoot,
      now: '2026-03-29T06:40:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    }),
  }));
}

function seedPassedReview(repository, targetHeadSha = 'head-92') {
  repository.upsertReviewRecord(createReviewRecord({
    review_id: 'review-issue-92-pass',
    task_id: 'issue-92',
    issue_number: 92,
    pr_number: 92,
    status: 'passed',
    trigger_kind: 'ready_for_review',
    target_branch: 'feat/issue-92',
    target_head_sha: targetHeadSha,
    requested_by_session_name: 'worker-92',
    requested_by_session_id: 'worker-92',
    implementation_session_name: 'worker-92',
    implementation_session_id: 'worker-92',
    reviewer_session_name: 'worker-92-review',
    reviewer_session_id: 'worker-92-review',
    verification_baseline: [{
      category: 'workspace_sanity',
      commands: ['git status --short'],
    }],
    verdict: 'pass',
    freeze_status: 'released',
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:30.000Z',
  }));
}

function createReadyAutoMergeDeps(repository, {
  commandRunner = undefined,
  providerCalls = [],
  blockedNotificationTransport = undefined,
} = {}) {
  return {
    loadAoProjectObservation: async ({ projectId }) => {
      providerCalls.push({ provider: 'ao', projectId });
      return {
        observed_at: '2026-03-29T06:41:00.000Z',
        workers: [{
          session_name: 'worker-92',
          session_runtime_id: 'worker-92',
          issue_number: 92,
          branch_name: 'feat/issue-92',
          pr_number: 92,
          lifecycle_state: 'idle',
          last_seen_at: '2026-03-29T06:40:45.000Z',
          freshness: { status: 'fresh' },
        }],
      };
    },
    loadGitHubObservationSet: async ({ scope }) => {
      providerCalls.push({ provider: 'github', scope });
      return {
        observed_at: '2026-03-29T06:41:00.000Z',
        prs: [{
          pr_number: 92,
          state: 'OPEN',
          head_branch: 'feat/issue-92',
          head_sha: 'head-92',
          review_status: 'approved',
          ci_status: 'passing',
          mergeability: 'mergeable',
          is_draft: false,
        }],
      };
    },
    resolveLifecycleReport: async () => ({
      top_status: 'continue',
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-92',
      },
      release_decision: {
        disposition: 'auto_merge_ready_pr',
        expected_head_sha: 'head-92',
      },
      actions: [{
        id: 'auto_merge_ready_pr',
        action_class: 'merge_pr',
        summary: 'Merge the release-ready AO-managed PR.',
        commands: [
          'gh pr view 92 --json number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url',
          'gh pr merge 92 --squash --delete-branch',
        ],
        rationale: 'The consumer explicitly selected guarded auto-merge.',
      }],
    }),
    ensureRuntimePreflights: () => repository.getSnapshot().state.runtime_preflights,
    commandRunner,
    blockedNotificationTransport,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('controller assist release-action policy', () => {
  it('executes exact-head reviewed auto-merge through the public controller/provider seam', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedAssistTask(repository);
    seedPassedReview(repository);
    const commandCalls = [];
    const providerCalls = [];
    let viewCount = 0;
    const commandRunner = async ({ command, args, cwd }) => {
      commandCalls.push({ command, args, cwd });
      if (args[1] === 'view') {
        viewCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            state: viewCount === 1 ? 'OPEN' : 'MERGED',
            headRefOid: 'head-92',
            reviewDecision: 'APPROVED',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          }),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'action-policy-test',
      holderType: 'test',
      now: '2026-03-29T06:41:00.000Z',
      deps: createReadyAutoMergeDeps(repository, {
        commandRunner,
        providerCalls,
      }),
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 1,
      executed_action_count: 1,
      blocked_action_count: 0,
      task_results: [
        expect.objectContaining({
          release_decision: expect.objectContaining({
            disposition: 'auto_merge_ready_pr',
            expected_head_sha: 'head-92',
          }),
          assist_actions: [
            expect.objectContaining({
              action_kind: 'auto_merge_ready_pr',
              status: 'executed',
              effect_status: 'succeeded',
              effect_kind: 'auto_merge',
            }),
          ],
        }),
      ],
    });
    expect(providerCalls).toEqual([
      { provider: 'ao', projectId: PROJECT_ID },
      expect.objectContaining({ provider: 'github' }),
    ]);
    expect(commandCalls).toEqual([
      {
        command: 'gh',
        args: ['pr', 'view', '92', '--json', 'number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url'],
        cwd: repository.getSnapshot().paths.repoRoot,
      },
      {
        command: 'gh',
        args: ['pr', 'merge', '92', '--squash', '--delete-branch', '--match-head-commit', 'head-92'],
        cwd: repository.getSnapshot().paths.repoRoot,
      },
      {
        command: 'gh',
        args: ['pr', 'view', '92', '--json', 'number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url'],
        cwd: repository.getSnapshot().paths.repoRoot,
      },
    ]);
  });

  it('holds auto-merge when TaskSpec requires independent review but no review exists', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedAssistTask(repository);
    const commandCalls = [];

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'missing-review-test',
      holderType: 'test',
      now: '2026-03-29T06:41:00.000Z',
      deps: createReadyAutoMergeDeps(repository, {
        commandRunner: async (intent) => {
          commandCalls.push(intent);
          return { status: 0, stdout: '', stderr: '' };
        },
      }),
    });

    expect(result).toMatchObject({
      proposed_action_count: 1,
      executed_action_count: 0,
      blocked_action_count: 1,
      task_results: [
        expect.objectContaining({
          release_decision: {
            disposition: 'await_review',
            basis: ['review_missing'],
            authoritative: true,
          },
          assist_actions: [
            expect.objectContaining({
              action_kind: 'hold_review',
              status: 'blocked',
            }),
          ],
        }),
      ],
    });
    expect(commandCalls).toEqual([]);
  });

  it('forwards the injected blocked-notification transport through the controller', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedAssistTask(repository);
    const notificationIntents = [];
    const blockedNotificationTransport = {
      async sendBlockedNotification(intent) {
        notificationIntents.push(intent);
        return {
          status: 'succeeded',
          transport: 'fake',
          attempts: 1,
          delivery_semantics: intent.delivery_semantics,
          idempotency_key: intent.delivery_id,
        };
      },
    };
    const deps = createReadyAutoMergeDeps(repository, {
      blockedNotificationTransport,
    });
    deps.resolveLifecycleReport = async () => ({
      top_status: 'human_gate',
      routing_decision: {
        action: 'hold_for_human',
        owner_session: 'worker-92',
      },
      release_decision: {
        disposition: 'human_gate',
        basis: ['operator_input_required'],
        authoritative: false,
      },
      actions: [{
        id: 'notify_human_blocked',
        action_class: 'notify_human',
        summary: 'Record a blocked notification through the injected transport.',
        commands: [],
        rationale: 'AO cannot continue without explicit human input.',
      }],
    });

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'blocked-notification-test',
      holderType: 'test',
      now: '2026-03-29T06:41:00.000Z',
      deps,
    });

    expect(notificationIntents).toEqual([
      expect.objectContaining({
        format: 'ao_blocked_notification_intent',
        project_id: PROJECT_ID,
        pr_number: 92,
      }),
    ]);
    expect(result).toMatchObject({
      executed_action_count: 1,
      blocked_action_count: 0,
      task_results: [
        expect.objectContaining({
          assist_actions: [
            expect.objectContaining({
              action_kind: 'notify_human_blocked',
              status: 'executed',
              effect_status: 'succeeded',
              effect_kind: 'blocked_notification',
            }),
          ],
        }),
      ],
    });
  });
});
