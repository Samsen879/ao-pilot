import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  createControllerModeRecord,
  createCredentialProvenanceRecord,
  createManagedTask,
  createPrBinding,
  createReviewRecord,
  createRuntimePreflightRecord,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { runControllerLoop } from '../../scripts/ao/lib/controller-loop.js';
import { runRuntimeBootstrapPreflight } from '../../scripts/ao/lib/runtime-preflight.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-policy-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function seedActiveTask(repository, mode) {
  repository.upsertManagedTask(createManagedTask({
    task_id: 'issue-107',
    issue_number: 107,
    title: 'Policy engine v1',
    branch_name: 'feat/107',
    worktree_path: '/tmp/worker-54',
    status: 'active',
    created_at: '2026-03-30T10:10:00.000Z',
    updated_at: '2026-03-30T10:10:00.000Z',
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: 'binding-issue-107-pr-107',
    task_id: 'issue-107',
    pr_number: 107,
    branch_name: 'feat/107',
    base_branch: 'main',
    status: 'bound',
    created_at: '2026-03-30T10:10:00.000Z',
    updated_at: '2026-03-30T10:10:00.000Z',
  }));
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: 'default',
    mode,
    updated_at: '2026-03-30T10:10:00.000Z',
    updated_by: 'operator',
    reason: 'Issue #107 policy gating test setup',
  }));
}

function seedGitHubCredential(repository) {
  repository.upsertCredentialProvenance(createCredentialProvenanceRecord({
    provenance_id: 'cred-gh-cli',
    credential_kind: 'github_token',
    source_kind: 'gh_cli_auth',
    scope: 'github.com',
    created_at: '2026-03-30T10:10:00.000Z',
    updated_at: '2026-03-30T10:10:00.000Z',
  }));
}

function seedCleanRuntimePreflight(repository, {
  taskId = 'issue-107',
  issueNumber = 107,
  runtimeRef = 'runtime.github_local',
} = {}) {
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
    created_at: '2026-03-30T10:10:00.000Z',
    updated_at: '2026-03-30T10:10:00.000Z',
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Assist only executes after clean runtime preflight.'],
        runtime_ref: runtimeRef,
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_review'],
      },
    },
  }));

  repository.upsertRuntimePreflight(createRuntimePreflightRecord({
    recorded_at: '2026-03-30T10:10:00.000Z',
    snapshot: runRuntimeBootstrapPreflight({
      runtimeRef,
      cwd: repository.getSnapshot().paths.repoRoot,
      now: '2026-03-30T10:10:00.000Z',
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

describe('ao controller policy gating', () => {
  it('records inspectable allow, deny, and downgrade policy decisions in shadow mode', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'shadow');
    seedGitHubCredential(repository);

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'test-controller-policy',
      now: '2026-03-30T10:11:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-30T10:11:00.000Z',
          workers: [
            {
              session_name: 'worker-54',
              session_runtime_id: 'worker-54',
              issue_number: 107,
              branch_name: 'feat/107',
              pr_number: 107,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-30T10:10:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-30T10:11:00.000Z',
          prs: [
            {
              pr_number: 107,
              state: 'OPEN',
              head_branch: 'feat/107',
              head_sha: 'abc107',
              review_status: 'pending',
              ci_status: 'pending',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/107',
            },
          ],
        }),
        resolveLifecycleReport: async () => ({
          top_status: 'hold',
          routing_decision: {
            action: 'continue_current_worker',
          },
          release_decision: {
            disposition: 'await_review',
          },
          actions: [
            {
              id: 'continue_worker',
              action_class: 'continue_worker',
              summary: 'Continue the current worker owner.',
              commands: ['ao status -p my-project --json'],
              rationale: 'Ownership continuity is clear enough to continue the current worker.',
            },
            {
              id: 'workflow_gate',
              action_class: 'hold',
              summary: 'Hold workflow mutation for review.',
              commands: ['git status --short'],
              rationale: 'Workflow mutations require a policy downgrade.',
              policy_inputs: {
                file_paths: ['.github/workflows/release.yml'],
              },
            },
            {
              id: 'unknown_tool',
              action_class: 'hold',
              summary: 'Unknown tool should fail closed.',
              commands: ['terraform plan'],
              rationale: 'Unknown tools must be denied.',
            },
            {
              id: 'gh_review',
              action_class: 'notify_human',
              summary: 'Review the current PR state.',
              commands: ['gh pr view 107 --json reviewDecision,url'],
              rationale: 'Known GH credential provenance should pass.',
              policy_inputs: {
                tools: ['gh'],
                network_targets: ['api.github.com'],
                secret_needs: [
                  {
                    credential_kind: 'github_token',
                    provenance_id: 'cred-gh-cli',
                  },
                ],
              },
            },
          ],
        }),
      },
    });

    expect(result).toMatchObject({
      mode: 'shadow',
      proposed_action_count: 4,
      policy_decision_count: 4,
      policy_blocked_action_count: 2,
      task_results: [
        expect.objectContaining({
          task_id: 'issue-107',
          policy_decision_count: 4,
          policy_blocked_action_count: 2,
          denied_action_count: 1,
          downgraded_action_count: 1,
        }),
      ],
    });

    expect(repository.getSnapshot().state.policy_decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_id: 'issue-107',
        action_kind: 'continue_worker',
        decision: 'allow',
      }),
      expect.objectContaining({
        task_id: 'issue-107',
        action_kind: 'workflow_gate',
        decision: 'downgrade',
      }),
      expect.objectContaining({
        task_id: 'issue-107',
        action_kind: 'unknown_tool',
        decision: 'deny',
      }),
      expect.objectContaining({
        task_id: 'issue-107',
        action_kind: 'gh_review',
        decision: 'allow',
      }),
    ]));

    expect(repository.getSnapshot().state.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action_kind: 'continue_worker',
        status: 'proposed',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'allow',
          }),
          policy_decision_id: expect.any(String),
        }),
      }),
      expect.objectContaining({
        action_kind: 'workflow_gate',
        status: 'blocked',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'downgrade',
          }),
        }),
      }),
      expect.objectContaining({
        action_kind: 'unknown_tool',
        status: 'blocked',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'deny',
          }),
        }),
      }),
      expect.objectContaining({
        action_kind: 'gh_review',
        status: 'proposed',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'allow',
          }),
        }),
      }),
    ]));

    expect(repository.listAuditEntries()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entity_kind: 'policy_decision',
        operation: 'upsert',
      }),
      expect.objectContaining({
        entity_kind: 'action',
        operation: 'policy_blocked',
      }),
    ]));
  });

  it('treats explicit review freeze as an advisory hold instead of a policy block', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'assist');
    seedCleanRuntimePreflight(repository);
    repository.upsertReviewRecord(createReviewRecord({
      review_id: 'review-issue-107-1',
      task_id: 'issue-107',
      issue_number: 107,
      pr_number: 107,
      status: 'claimed',
      trigger_kind: 'ready_for_review',
      target_branch: 'feat/107',
      target_head_sha: 'abc107',
      requested_by_session_name: 'worker-54',
      requested_by_session_id: 'worker-54',
      implementation_session_name: 'worker-54',
      implementation_session_id: 'worker-54',
      reviewer_session_name: 'worker-107-review',
      reviewer_session_id: 'worker-107-review',
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
      freeze_status: 'active',
      created_at: '2026-04-03T15:20:00.000Z',
      updated_at: '2026-04-03T15:21:00.000Z',
    }));

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'test-controller-policy',
      now: '2026-04-03T15:22:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-04-03T15:22:00.000Z',
          workers: [
            {
              session_name: 'worker-54',
              session_runtime_id: 'worker-54',
              issue_number: 107,
              branch_name: 'feat/107',
              pr_number: 107,
              lifecycle_state: 'idle',
              last_seen_at: '2026-04-03T15:21:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-04-03T15:22:00.000Z',
          prs: [
            {
              pr_number: 107,
              state: 'OPEN',
              head_branch: 'feat/107',
              head_sha: 'abc107',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/107',
            },
          ],
        }),
        resolveLifecycleReport: async () => ({
          top_status: 'continue',
          routing_decision: {
            action: 'continue_current_worker',
          },
          release_decision: {
            disposition: 'notify_human_ready',
          },
          actions: [
            {
              id: 'notify_human_ready',
              action_class: 'notify_human',
              summary: 'Notify the human that the PR appears ready.',
              commands: ['gh pr view 107 --json mergeable,reviewDecision,isDraft,url'],
              rationale: 'Human approval remains required even when the PR appears ready.',
            },
          ],
        }),
        ensureRuntimePreflights: () => repository.getSnapshot().state.runtime_preflights,
      },
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 1,
      executed_action_count: 0,
      blocked_action_count: 1,
      policy_blocked_action_count: 0,
      task_results: [
        expect.objectContaining({
          release_decision: expect.objectContaining({
            disposition: 'await_review',
            basis: ['review_pending'],
          }),
          assist_actions: [
            expect.objectContaining({
              action_kind: 'hold_review',
              status: 'blocked',
              policy_decision: 'allow',
              execution_reason: 'advisory_hold_non_executable',
            }),
          ],
        }),
      ],
    });
  });

  it('keeps policy-blocked actions out of assist execution', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'assist');
    seedCleanRuntimePreflight(repository);

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'test-controller-policy',
      now: '2026-03-30T10:12:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-30T10:12:00.000Z',
          workers: [
            {
              session_name: 'worker-54',
              session_runtime_id: 'worker-54',
              issue_number: 107,
              branch_name: 'feat/107',
              pr_number: 107,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-30T10:11:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-30T10:12:00.000Z',
          prs: [
            {
              pr_number: 107,
              state: 'OPEN',
              head_branch: 'feat/107',
              head_sha: 'abc107',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/107',
            },
          ],
        }),
        resolveLifecycleReport: async () => ({
          top_status: 'continue',
          routing_decision: {
            action: 'continue_current_worker',
          },
          release_decision: {
            disposition: 'notify_human_ready',
          },
          actions: [
            {
              id: 'continue_worker',
              action_class: 'continue_worker',
              summary: 'Continue the current worker owner.',
              commands: ['ao status -p my-project --json'],
              rationale: 'Ownership continuity is clear enough to continue the current worker.',
            },
            {
              id: 'workflow_gate',
              action_class: 'hold',
              summary: 'Workflow mutation should not execute.',
              commands: ['git status --short'],
              rationale: 'Policy downgrade should block assist execution.',
              policy_inputs: {
                file_paths: ['.github/workflows/release.yml'],
              },
            },
          ],
        }),
        ensureRuntimePreflights: () => repository.getSnapshot().state.runtime_preflights,
      },
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 2,
      executed_action_count: 1,
      blocked_action_count: 0,
      policy_blocked_action_count: 1,
      task_results: [
        expect.objectContaining({
          executed_action_count: 1,
          blocked_action_count: 0,
          policy_blocked_action_count: 1,
        }),
      ],
    });

    expect(repository.getSnapshot().state.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action_kind: 'continue_worker',
        status: 'executed',
      }),
      expect.objectContaining({
        action_kind: 'workflow_gate',
        status: 'blocked',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'downgrade',
          }),
        }),
      }),
    ]));
  });
});
