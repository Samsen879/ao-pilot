import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { runControllerLoop } from '../../scripts/ao/lib/controller-loop.js';
import { runRuntimeBootstrapPreflight } from '../../scripts/ao/lib/runtime-preflight.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import {
  createControllerModeRecord,
  createManagedTask,
  createPrBinding,
  createRuntimePreflightRecord,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';

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

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('controller assist release-action policy', () => {
  it('executes an explicitly selected auto-merge action through the injected command runner', async () => {
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
      holderId: 'action-policy-test',
      holderType: 'test',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
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
        }),
        loadGitHubObservationSet: async () => ({
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
        }),
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
        commandRunner: async ({ command, args }) => {
          commandCalls.push([command, ...args]);
          if (args[1] === 'view') {
            return {
              status: 0,
              stdout: JSON.stringify({
                state: 'OPEN',
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
        },
      },
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
    expect(commandCalls).toEqual([
      ['gh', 'pr', 'view', '92', '--json', 'number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url'],
      ['gh', 'pr', 'merge', '92', '--squash', '--delete-branch'],
    ]);
  });
});
