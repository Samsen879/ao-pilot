import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
  buildAssistActionModel,
  executeAssistActions,
} from '../../scripts/ao/lib/action-executor.js';
import {
  createActionRecord,
  createManagedTask,
  createOverrideRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-action-executor-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

function seedActiveTask(repository) {
  repository.upsertManagedTask(createManagedTask({
    task_id: 'issue-90',
    issue_number: 90,
    title: 'Assist-mode Class A executor and override controls',
    branch_name: 'feat/90',
    worktree_path: '/tmp/worker-90',
    status: 'active',
    created_at: '2026-03-29T07:10:00.000Z',
    updated_at: '2026-03-29T07:10:00.000Z',
  }));
}

function buildExecutableActionModel(repository, {
  actionKind,
  actionClass,
  summary,
  commands = [],
  derivedTrigger = 'approved_and_green',
} = {}) {
  return buildAssistActionModel({
    controllerId: 'default',
    task: repository.getSnapshot().state.managed_tasks[0],
    prNumber: 101,
    derivedTrigger,
    lifecycleTopStatus: 'continue',
    runtimeRef: 'runtime.github_local',
    runtimePreflight: {
      runtime_ref: 'runtime.github_local',
      status: 'clean',
      replay_key: 'runtime_preflight:clean',
    },
    action: {
      id: actionKind,
      action_class: actionClass,
      summary,
      commands,
      rationale: 'Focused action-executor test fixture.',
    },
  });
}

function seedAllowedAction(repository, {
  actionId,
  actionKind,
  actionClass,
  summary,
  commands = [],
  releaseDecision = null,
  externalEffectAuthorization = actionKind === 'auto_merge_ready_pr' && releaseDecision?.expected_head_sha
    ? {
        status: 'authorized',
        effect_kind: 'github_pull_request_merge',
        expected_head_sha: releaseDecision.expected_head_sha,
        authorized_by: 'test-release-owner',
        authorized_at: '2026-03-29T07:10:30.000Z',
        authorization_id: 'authorization-test-1',
      }
    : null,
} = {}) {
  const actionModel = buildExecutableActionModel(repository, {
    actionKind,
    actionClass,
    summary,
    commands,
  });
  repository.upsertAction(createActionRecord({
    action_id: actionId,
    task_id: 'issue-90',
    action_kind: actionKind,
    status: 'proposed',
    requested_by: 'assist_controller',
    reason: summary,
    created_at: '2026-03-29T07:11:00.000Z',
    updated_at: '2026-03-29T07:11:00.000Z',
    payload: {
      action_model: actionModel,
      ...(releaseDecision == null ? {} : { release_decision: releaseDecision }),
      ...(externalEffectAuthorization == null ? {} : {
        external_effect_authorization: externalEffectAuthorization,
      }),
      policy_decision_id: 'policy-1',
      policy: {
        decision: 'allow',
        policy_version: 'ao.policy.v1',
      },
    },
  }));
  return actionModel;
}

function createAllowedMergeRepository({ expectedHeadSha = 'head-1' } = {}) {
  const repository = createStateRepository({
    repoRoot: createTempRepo(),
    projectId: PROJECT_ID,
    auditIdGenerator: createIdGenerator('audit'),
  });
  seedActiveTask(repository);
  seedAllowedAction(repository, {
    actionId: 'action-merge',
    actionKind: 'auto_merge_ready_pr',
    actionClass: 'merge_pr',
    summary: 'Merge the release-ready AO-managed PR.',
    releaseDecision: {
      disposition: 'auto_merge_ready_pr',
      expected_head_sha: expectedHeadSha,
    },
  });
  return repository;
}

function buildFreshPr({
  state = 'OPEN',
  headRefOid = 'head-1',
  reviewDecision = 'APPROVED',
  mergeStateStatus = 'CLEAN',
  statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
} = {}) {
  return {
    number: 101,
    state,
    headRefOid,
    reviewDecision,
    mergeStateStatus,
    isDraft: false,
    statusCheckRollup,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao action executor', () => {
  it('builds typed assist action models with risk classes and preconditions', () => {
    const notifyModel = buildAssistActionModel({
      controllerId: 'default',
      task: {
        task_id: 'issue-90',
        status: 'active',
      },
      prNumber: 101,
      derivedTrigger: 'approved_and_green',
      lifecycleTopStatus: 'continue',
      runtimeRef: 'runtime.github_local',
      runtimePreflight: {
        runtime_ref: 'runtime.github_local',
        status: 'clean',
        replay_key: 'runtime_preflight:clean',
      },
      action: {
        id: 'notify_human_ready',
        action_class: 'notify_human',
        summary: 'Notify the human that the PR appears ready.',
        commands: ['gh pr view 101 --json mergeable,reviewDecision,isDraft,url'],
        rationale: 'Human approval remains required even when the PR appears ready.',
      },
    });

    expect(notifyModel).toMatchObject({
      action_kind: 'notify_human_ready',
      action_class: 'notify_human',
      risk_class: 'class_a',
      runtime_preflight: {
        runtime_ref: 'runtime.github_local',
        status: 'clean',
      },
      phase4_assist: {
        executable: true,
        reason: 'class_a_allowlist',
      },
      execution_contract: {
        automation_boundary: 'class_a_only',
        durable_policy_required: true,
        runtime_preflight_required: true,
        runtime_preflight_status: 'clean',
        idempotency_mode: 'action_status_gate',
        rollback_mode: 'audit_only',
        executable: true,
        reason: 'class_a_allowlist',
        blocking_precondition_codes: [],
      },
    });
    expect(notifyModel.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'task_active',
        satisfied: true,
      }),
      expect.objectContaining({
        code: 'pr_scope_required',
        satisfied: true,
      }),
    ]));

    const mergeModel = buildAssistActionModel({
      controllerId: 'default',
      task: { task_id: 'issue-90', status: 'active' },
      prNumber: 101,
      runtimeRef: 'runtime.github_local',
      runtimePreflight: { runtime_ref: 'runtime.github_local', status: 'clean' },
      action: {
        id: 'auto_merge_ready_pr',
        action_class: 'merge_pr',
        summary: 'Merge one exact approved head.',
      },
    });
    expect(mergeModel).toMatchObject({
      risk_class: 'irreversible_remote_effect',
      execution_contract: {
        automation_boundary: 'explicit_irreversible_remote_authorization',
        reason: 'explicit_irreversible_remote_authorization_gate',
        rollback_mode: 'irreversible',
        remote_effect: {
          kind: 'github_pull_request_merge',
          reversibility: 'irreversible',
          explicit_authorization_required: true,
          exact_head_required: true,
        },
      },
    });

    const missingPreflightModel = buildAssistActionModel({
      controllerId: 'default',
      task: {
        task_id: 'issue-90',
        status: 'active',
      },
      derivedTrigger: 'manual',
      lifecycleTopStatus: 'continue',
      runtimeRef: 'runtime.github_local',
      runtimePreflight: {
        runtime_ref: 'runtime.github_local',
        status: 'missing_dependency',
        replay_key: 'runtime_preflight:missing',
      },
      action: {
        id: 'continue_worker',
        action_class: 'continue_worker',
        summary: 'Continue the current worker owner.',
        commands: ['ao status -p my-project --json'],
        rationale: 'Ownership continuity is clear enough to continue the current worker.',
      },
    });

    expect(missingPreflightModel).toMatchObject({
      action_kind: 'continue_worker',
      runtime_preflight: {
        runtime_ref: 'runtime.github_local',
        status: 'missing_dependency',
      },
      phase4_assist: {
        executable: false,
        reason: 'runtime_preflight_clean',
      },
      execution_contract: {
        runtime_preflight_status: 'missing_dependency',
        idempotency_mode: 'action_status_gate',
        rollback_mode: 'audit_only',
        executable: false,
        reason: 'runtime_preflight_clean',
        blocking_precondition_codes: ['runtime_preflight_clean'],
      },
    });
    expect(missingPreflightModel.preconditions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime_preflight_clean',
        satisfied: false,
      }),
    ]));

    const restoreModel = buildAssistActionModel({
      controllerId: 'default',
      task: {
        task_id: 'issue-90',
        status: 'active',
      },
      prNumber: 101,
      derivedTrigger: 'agent_exited',
      lifecycleTopStatus: 'human_gate',
      action: {
        id: 'restore_worker',
        action_class: 'restore_worker',
        summary: 'Restore the previously identified worker.',
        commands: ['ao status -p my-project --json'],
        rationale: 'The prior owner is still identifiable, but continuity is stale.',
      },
    });

    expect(restoreModel).toMatchObject({
      action_kind: 'restore_worker',
      risk_class: 'class_c',
      phase4_assist: {
        executable: false,
        reason: 'runtime_ownership_change_forbidden',
      },
      execution_contract: {
        automation_boundary: 'class_a_only',
        durable_policy_required: true,
        runtime_preflight_required: true,
        runtime_preflight_status: 'missing',
        idempotency_mode: 'action_status_gate',
        rollback_mode: 'manual_only',
        executable: false,
        reason: 'runtime_ownership_change_forbidden',
        blocking_precondition_codes: ['runtime_preflight_clean'],
      },
    });
  });

  it('executes only class A actions and writes explicit execution audit entries', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);

    const actionModel = buildAssistActionModel({
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      prNumber: 101,
      derivedTrigger: 'manual',
      lifecycleTopStatus: 'continue',
      runtimeRef: 'runtime.github_local',
      runtimePreflight: {
        runtime_ref: 'runtime.github_local',
        status: 'clean',
        replay_key: 'runtime_preflight:clean',
      },
      action: {
        id: 'continue_worker',
        action_class: 'continue_worker',
        summary: 'Continue the current worker owner.',
        commands: ['ao status -p my-project --json'],
        rationale: 'Ownership continuity is clear enough to continue the current worker.',
      },
    });

    repository.upsertAction(createActionRecord({
      action_id: 'action-1',
      task_id: 'issue-90',
      action_kind: 'continue_worker',
      status: 'proposed',
      requested_by: 'shadow_controller',
      reason: 'Continue the current worker owner.',
      created_at: '2026-03-29T07:11:00.000Z',
      updated_at: '2026-03-29T07:11:00.000Z',
      payload: {
        action_model: actionModel,
        policy_decision_id: 'policy-1',
        policy: {
          decision: 'allow',
          policy_version: 'ao.policy.v1',
        },
      },
    }));

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-1'],
      now: '2026-03-29T07:12:00.000Z',
    });

    expect(result).toEqual({
      executedActionIds: ['action-1'],
      blockedActionIds: [],
    });

    expect(repository.getSnapshot().state.actions).toEqual([
      expect.objectContaining({
        action_id: 'action-1',
        status: 'executed',
        payload: expect.objectContaining({
          execution: expect.objectContaining({
            outcome: 'executed',
            executed_at: '2026-03-29T07:12:00.000Z',
            executor: 'assist_controller',
          }),
        }),
      }),
    ]);
    expect(repository.getSnapshot().state.execution_attempt_metrics).toEqual([
      expect.objectContaining({
        attempt_kind: 'assist_action',
        task_id: 'issue-90',
        action_id: 'action-1',
        action_kind: 'continue_worker',
        action_class: 'continue_worker',
        status: 'executed',
        failure_class: 'none',
        retry_cause: 'none',
        intervention_counts: expect.objectContaining({
          human_gate: 0,
          override: 0,
          explicit_resume: 0,
          successor_handoff: 0,
          policy_block: 0,
          preflight_block: 0,
        }),
        token_usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
        },
        cost: {
          usd: null,
        },
      }),
    ]);

    expect(repository.listAuditEntries().filter((entry) => (
      entry.entity_kind === 'action' && entry.entity_id === 'action-1'
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'executed',
        actor: 'assist_controller',
      }),
    ]));
  });

  it('blocks assist execution when durable policy attribution is missing', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);

    const actionModel = buildAssistActionModel({
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      prNumber: 101,
      derivedTrigger: 'manual',
      lifecycleTopStatus: 'continue',
      runtimeRef: 'runtime.github_local',
      runtimePreflight: {
        runtime_ref: 'runtime.github_local',
        status: 'clean',
        replay_key: 'runtime_preflight:clean',
      },
      action: {
        id: 'continue_worker',
        action_class: 'continue_worker',
        summary: 'Continue the current worker owner.',
        commands: ['ao status -p my-project --json'],
        rationale: 'Ownership continuity is clear enough to continue the current worker.',
      },
    });

    repository.upsertAction(createActionRecord({
      action_id: 'action-1',
      task_id: 'issue-90',
      action_kind: 'continue_worker',
      status: 'proposed',
      requested_by: 'shadow_controller',
      reason: 'Continue the current worker owner.',
      created_at: '2026-03-29T07:11:00.000Z',
      updated_at: '2026-03-29T07:11:00.000Z',
      payload: {
        action_model: actionModel,
      },
    }));

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-1'],
      now: '2026-03-29T07:12:00.000Z',
    });

    expect(result).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-1'],
    });

    expect(repository.getSnapshot().state.actions).toEqual([
      expect.objectContaining({
        action_id: 'action-1',
        status: 'blocked',
        payload: expect.objectContaining({
          execution: expect.objectContaining({
            outcome: 'blocked',
            reason: 'policy_allow_required',
          }),
        }),
      }),
    ]);
    expect(repository.getSnapshot().state.execution_attempt_metrics).toEqual([
      expect.objectContaining({
        attempt_kind: 'assist_action',
        action_id: 'action-1',
        status: 'blocked',
        failure_class: 'policy_block',
        intervention_counts: expect.objectContaining({
          policy_block: 1,
        }),
      }),
    ]);
  });

  it('honors active autonomy-hold overrides without executing class A actions', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);

    repository.upsertOverride(createOverrideRecord({
      override_id: 'override-1',
      scope_kind: 'task',
      scope_id: 'issue-90',
      override_kind: 'hold_autonomy',
      value: { enabled: true },
      status: 'active',
      created_at: '2026-03-29T07:11:00.000Z',
      expires_at: null,
      cleared_at: null,
      cleared_reason: null,
      created_by: 'operator',
    }));

    const actionModel = buildAssistActionModel({
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      prNumber: 101,
      derivedTrigger: 'approved_and_green',
      lifecycleTopStatus: 'continue',
      runtimeRef: 'runtime.github_local',
      runtimePreflight: {
        runtime_ref: 'runtime.github_local',
        status: 'clean',
        replay_key: 'runtime_preflight:clean',
      },
      action: {
        id: 'notify_human_ready',
        action_class: 'notify_human',
        summary: 'Notify the human that the PR appears ready.',
        commands: ['gh pr view 101 --json mergeable,reviewDecision,isDraft,url'],
        rationale: 'Human approval remains required even when the PR appears ready.',
      },
    });

    repository.upsertAction(createActionRecord({
      action_id: 'action-1',
      task_id: 'issue-90',
      action_kind: 'notify_human_ready',
      status: 'proposed',
      requested_by: 'shadow_controller',
      reason: 'Notify the human that the PR appears ready.',
      created_at: '2026-03-29T07:11:00.000Z',
      updated_at: '2026-03-29T07:11:00.000Z',
      payload: {
        action_model: actionModel,
        policy_decision_id: 'policy-1',
        policy: {
          decision: 'allow',
          policy_version: 'ao.policy.v1',
        },
      },
    }));

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-1'],
      now: '2026-03-29T07:12:00.000Z',
    });

    expect(result).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-1'],
    });

    expect(repository.getSnapshot().state.actions).toEqual([
      expect.objectContaining({
        action_id: 'action-1',
        status: 'proposed',
        payload: expect.objectContaining({
          execution: expect.objectContaining({
            outcome: 'blocked',
            reason: 'override_hold_autonomy',
          }),
        }),
      }),
    ]);
    expect(repository.getSnapshot().state.execution_attempt_metrics).toEqual([
      expect.objectContaining({
        attempt_kind: 'assist_action',
        action_id: 'action-1',
        status: 'blocked',
        failure_class: 'override',
        intervention_counts: expect.objectContaining({
          override: 1,
        }),
      }),
    ]);

    expect(repository.listAuditEntries().filter((entry) => (
      entry.entity_kind === 'action' && entry.entity_id === 'action-1'
    ))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'execution_blocked',
        actor: 'assist_controller',
      }),
    ]));
  });

  it('performs guarded auto-merge through an injected runner and records an external-effect receipt', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-merge',
      actionKind: 'auto_merge_ready_pr',
      actionClass: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      commands: ['gh pr merge 101 --squash --delete-branch'],
      releaseDecision: {
        disposition: 'auto_merge_ready_pr',
        expected_head_sha: 'head-1',
      },
    });

    const calls = [];
    let viewCount = 0;
    const commandRunner = async ({ command, args, cwd }) => {
      calls.push([command, ...args, `cwd=${cwd}`]);
      expect(repository.getSnapshot().state.actions[0]).toMatchObject({
        status: 'proposed',
        payload: {
          execution: {
            outcome: 'effect_attempted',
            effect: {
              status: 'attempted',
              kind: 'auto_merge',
            },
          },
        },
      });
      if (args[1] === 'view') {
        viewCount += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            number: 101,
            state: viewCount === 1 ? 'OPEN' : 'MERGED',
            headRefOid: 'head-1',
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

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
      commandCwd: '/tmp/my-project',
    });

    expect(result).toEqual({
      executedActionIds: ['action-merge'],
      blockedActionIds: [],
    });
    expect(calls).toEqual([
      ['gh', 'pr', 'view', '101', '--json', 'number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url', 'cwd=/tmp/my-project'],
      ['gh', 'pr', 'merge', '101', '--squash', '--delete-branch', '--match-head-commit', 'head-1', 'cwd=/tmp/my-project'],
      ['gh', 'pr', 'view', '101', '--json', 'number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url', 'cwd=/tmp/my-project'],
    ]);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'executed',
      payload: {
        execution: {
          outcome: 'executed',
          reason: 'auto_merge_completed',
          effect: {
            status: 'succeeded',
            kind: 'auto_merge',
            retryable: false,
            receipt: {
              reason: 'auto_merge_completed',
              command_receipts: [
                expect.objectContaining({ command: 'gh', status: 0, cwd: '/tmp/my-project' }),
                expect.objectContaining({ command: 'gh', status: 0, cwd: '/tmp/my-project' }),
                expect.objectContaining({ command: 'gh', status: 0, cwd: '/tmp/my-project' }),
              ],
            },
          },
        },
      },
    });
  });

  it('keeps an ambiguous merge failure in-flight and refuses automatic replay', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-merge',
      actionKind: 'auto_merge_ready_pr',
      actionClass: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      releaseDecision: {
        disposition: 'auto_merge_ready_pr',
        expected_head_sha: 'head-1',
      },
    });

    let mergeAttempts = 0;
    let merged = false;
    let commandCalls = 0;
    const commandRunner = async ({ args }) => {
      commandCalls += 1;
      if (args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify({
            state: merged ? 'MERGED' : 'OPEN',
            headRefOid: 'head-1',
            reviewDecision: 'APPROVED',
            mergeStateStatus: 'CLEAN',
            isDraft: false,
            statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
          }),
          stderr: '',
        };
      }
      mergeAttempts += 1;
      if (mergeAttempts === 1) return { status: 1, stdout: '', stderr: 'temporary failure' };
      merged = true;
      return { status: 0, stdout: '', stderr: '' };
    };

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_attempted',
          reason: 'auto_merge_command_unconfirmed',
          effect: {
            status: 'attempted',
            kind: 'auto_merge',
            retryable: false,
          },
        },
      },
    });
    expect(commandCalls).toBe(3);
    expect(mergeAttempts).toBe(1);

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:13:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(commandCalls).toBe(3);
    expect(mergeAttempts).toBe(1);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_attempted',
          effect: { status: 'attempted', retryable: false },
        },
      },
    });
  });

  it('accepts an ambiguous merge command only after live exact-head confirmation', async () => {
    const repository = createAllowedMergeRepository();
    let merged = false;
    const commandRunner = jest.fn(async ({ args }) => {
      if (args[1] === 'view') {
        return {
          status: 0,
          stdout: JSON.stringify(buildFreshPr({ state: merged ? 'MERGED' : 'OPEN' })),
          stderr: '',
        };
      }
      merged = true;
      return { status: 1, stdout: '', stderr: 'transport timed out after dispatch' };
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: ['action-merge'],
      blockedActionIds: [],
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'executed',
      payload: {
        execution: {
          reason: 'auto_merge_confirmed_after_command_failure',
          effect: {
            status: 'succeeded',
            receipt: {
              result: {
                confirmed_state: 'MERGED',
                confirmed_head_sha: 'head-1',
                merge_command_status: 1,
              },
            },
          },
        },
      },
    });
  });

  it('fails closed before invoking the runner when auto-merge lacks an exact approved head', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-merge',
      actionKind: 'auto_merge_ready_pr',
      actionClass: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      releaseDecision: { disposition: 'auto_merge_ready_pr' },
    });

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner: async () => {
        throw new Error('runner must not be called without expected_head_sha');
      },
    });

    expect(result).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'blocked',
      payload: {
        execution: {
          outcome: 'blocked',
          reason: 'auto_merge_expected_head_missing',
          effect: null,
        },
      },
    });
  });

  it('requires an explicitly injected command runner and performs no live merge by default', async () => {
    const repository = createAllowedMergeRepository();

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'blocked',
          reason: 'auto_merge_command_runner_missing',
          effect: null,
        },
      },
    });
  });

  it('requires durable explicit authorization bound to the exact head for an irreversible merge', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-merge',
      actionKind: 'auto_merge_ready_pr',
      actionClass: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      releaseDecision: {
        disposition: 'auto_merge_ready_pr',
        expected_head_sha: 'head-1',
      },
      externalEffectAuthorization: null,
    });
    const commandRunner = jest.fn();

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'blocked',
          reason: 'auto_merge_explicit_authorization_required',
          effect: null,
        },
      },
    });
  });

  it('rejects an irreversible merge authorization bound to another head', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-merge',
      actionKind: 'auto_merge_ready_pr',
      actionClass: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      releaseDecision: {
        disposition: 'auto_merge_ready_pr',
        expected_head_sha: 'head-1',
      },
      externalEffectAuthorization: {
        status: 'authorized',
        effect_kind: 'github_pull_request_merge',
        expected_head_sha: 'head-older',
        authorized_by: 'test-release-owner',
        authorized_at: '2026-03-29T07:10:30.000Z',
      },
    });
    const commandRunner = jest.fn();

    await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: { execution: { reason: 'auto_merge_authorization_head_mismatch' } },
    });
  });

  it('accepts the public command runner object contract and preserves command intent in receipts', async () => {
    const repository = createAllowedMergeRepository();
    let viewCount = 0;
    const commandRunner = {
      run: jest.fn((command, args, options) => {
        if (args[1] === 'view') {
          viewCount += 1;
          return {
            status: 0,
            signal: null,
            stdout: JSON.stringify(buildFreshPr({
              state: viewCount === 1 ? 'OPEN' : 'MERGED',
              statusCheckRollup: [
                { state: 'SUCCESS' },
                { status: 'COMPLETED', conclusion: 'SUCCESS' },
              ],
            })),
            stderr: '',
          };
        }
        return { status: 0, signal: null, stdout: '', stderr: '' };
      }),
    };

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
      commandCwd: '/tmp/public-runner-project',
    })).toEqual({
      executedActionIds: ['action-merge'],
      blockedActionIds: [],
    });
    expect(commandRunner.run).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['pr', 'merge', '101', '--squash', '--delete-branch', '--match-head-commit', 'head-1'],
      { cwd: '/tmp/public-runner-project' },
    );
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      payload: {
        execution: {
          effect: {
            status: 'succeeded',
            delivery_semantics: 'at_least_once_with_durable_inflight_claim',
            receipt: {
              command_receipts: [
                expect.objectContaining({ command: 'gh', args: expect.any(Array), cwd: '/tmp/public-runner-project' }),
                expect.objectContaining({
                  command: 'gh',
                  args: expect.arrayContaining(['--match-head-commit', 'head-1']),
                  cwd: '/tmp/public-runner-project',
                }),
                expect.objectContaining({ command: 'gh', args: expect.any(Array), cwd: '/tmp/public-runner-project' }),
              ],
            },
          },
        },
      },
    });
  });

  it.each([
    ['StatusContext FAILURE', [{ state: 'FAILURE' }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['StatusContext ERROR', [{ state: 'ERROR' }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['StatusContext PENDING', [{ state: 'PENDING' }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['StatusContext EXPECTED', [{ state: 'EXPECTED' }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['CheckRun failure', [{ status: 'COMPLETED', conclusion: 'FAILURE' }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['unknown check state', [{ status: 'COMPLETED', conclusion: null }], 'CLEAN', 'auto_merge_ci_not_passing'],
    ['UNSTABLE merge state', [{ state: 'SUCCESS' }], 'UNSTABLE', 'auto_merge_not_mergeable'],
  ])('fails closed for %s', async (_label, statusCheckRollup, mergeStateStatus, expectedReason) => {
    const repository = createAllowedMergeRepository();
    const commandRunner = jest.fn(async ({ args }) => {
      if (args[1] !== 'view') throw new Error('merge must not run');
      return {
        status: 0,
        stdout: JSON.stringify(buildFreshPr({ statusCheckRollup, mergeStateStatus })),
        stderr: '',
      };
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      payload: { execution: { reason: expectedReason } },
    });
  });

  it('does not accept an already-MERGED PR unless its live head exactly matches the approved head', async () => {
    const repository = createAllowedMergeRepository();
    const commandRunner = jest.fn(async () => ({
      status: 0,
      stdout: JSON.stringify(buildFreshPr({ state: 'MERGED', headRefOid: 'unexpected-head' })),
      stderr: '',
    }));

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'blocked',
      payload: { execution: { reason: 'auto_merge_head_mismatch' } },
    });
  });

  it('accepts an already-MERGED PR only after a live exact-head read and does not invoke merge again', async () => {
    const repository = createAllowedMergeRepository();
    const commandRunner = jest.fn(async () => ({
      status: 0,
      stdout: JSON.stringify(buildFreshPr({ state: 'MERGED' })),
      stderr: '',
    }));

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: ['action-merge'],
      blockedActionIds: [],
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner.mock.calls[0][0].args.slice(0, 2)).toEqual(['pr', 'view']);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      payload: {
        execution: {
          reason: 'auto_merge_already_merged',
          details: {
            head_sha: 'head-1',
            authorization: { status: 'authorized', expected_head_sha: 'head-1' },
          },
        },
      },
    });
  });

  it('re-reads an already-merged stderr result and confirms the exact live head before success', async () => {
    const repository = createAllowedMergeRepository();
    let call = 0;
    const commandRunner = jest.fn(async ({ args }) => {
      call += 1;
      if (call === 1) return { status: 0, stdout: JSON.stringify(buildFreshPr()), stderr: '' };
      if (args[1] === 'merge') return { status: 1, stdout: '', stderr: 'Pull request is already merged' };
      return { status: 0, stdout: JSON.stringify(buildFreshPr({ state: 'MERGED' })), stderr: '' };
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: ['action-merge'],
      blockedActionIds: [],
    });
    expect(commandRunner).toHaveBeenCalledTimes(3);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      payload: { execution: { reason: 'auto_merge_already_merged' } },
    });
  });

  it('fails closed when an already-merged stderr result re-reads a different head', async () => {
    const repository = createAllowedMergeRepository();
    let call = 0;
    const commandRunner = jest.fn(async ({ args }) => {
      call += 1;
      if (call === 1) return { status: 0, stdout: JSON.stringify(buildFreshPr()), stderr: '' };
      if (args[1] === 'merge') return { status: 1, stdout: '', stderr: 'already merged' };
      return {
        status: 0,
        stdout: JSON.stringify(buildFreshPr({ state: 'MERGED', headRefOid: 'different-head' })),
        stderr: '',
      };
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_attempted',
          reason: 'auto_merge_confirmation_head_mismatch',
          effect: { status: 'attempted', retryable: false },
        },
      },
    });
  });

  it.each([
    ['signal termination', { status: 0, signal: 'SIGTERM', stdout: '{}', stderr: '' }],
    ['non-numeric status', { status: '0', signal: null, stdout: '{}', stderr: '' }],
  ])('treats %s as command failure', async (_label, commandResult) => {
    const repository = createAllowedMergeRepository();
    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner: async () => commandResult,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: { execution: { reason: 'auto_merge_pr_view_failed' } },
    });
  });

  it('does not replay a durable unconfirmed in-flight effect claim', async () => {
    const repository = createAllowedMergeRepository();
    const existing = repository.getSnapshot().state.actions[0];
    repository.upsertAction(createActionRecord({
      ...existing,
      payload: {
        ...existing.payload,
        execution: {
          outcome: 'effect_attempted',
          reason: 'auto_merge_attempted',
          effect: {
            status: 'attempted',
            kind: 'auto_merge',
            attempt_id: 'action-merge@2026-03-29T07:11:30.000Z',
            delivery_semantics: 'at_least_once_with_durable_inflight_claim',
          },
        },
      },
    }));
    const commandRunner = jest.fn();

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-merge'],
      now: '2026-03-29T07:12:00.000Z',
      commandRunner,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-merge'],
    });
    expect(commandRunner).not.toHaveBeenCalled();
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_attempted',
          effect: { attempt_id: 'action-merge@2026-03-29T07:11:30.000Z' },
        },
      },
    });
  });

  it('records a blocked-notification intent but keeps the action proposed when no transport is configured', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-notify',
      actionKind: 'notify_human_blocked',
      actionClass: 'notify_human',
      summary: 'AO is blocked and needs human input.',
      commands: [],
    });

    const result = await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-notify'],
      now: '2026-03-29T07:12:00.000Z',
      blockedNotificationTransport: null,
    });

    expect(result).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-notify'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'blocked',
          reason: 'blocked_notification_transport_missing',
          effect: {
            status: 'durable_only',
            kind: 'blocked_notification',
            intent: {
              format: 'ao_blocked_notification_intent',
              project_id: PROJECT_ID,
              dedupe_key: `${PROJECT_ID}:pr-101`,
            },
            receipt: {
              status: 'not_configured',
              transport: null,
            },
          },
        },
      },
    });
  });

  it('keeps a failed blocked-notification effect proposed and retries the same intent', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-notify',
      actionKind: 'notify_human_blocked',
      actionClass: 'notify_human',
      summary: 'AO is blocked and needs human input.',
    });

    const intents = [];
    const blockedNotificationTransport = {
      async sendBlockedNotification(intent) {
        intents.push(intent);
        return intents.length === 1
          ? { status: 'failed', transport: 'fake', attempts: 1, reason: 'temporary' }
          : {
              status: 'succeeded',
              transport: 'fake',
              attempts: 1,
              delivery_semantics: 'at_least_once',
              idempotency_key: intent.delivery_id,
            };
      },
    };

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-notify'],
      now: '2026-03-29T07:12:00.000Z',
      blockedNotificationTransport,
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-notify'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_failed',
          reason: 'blocked_notification_transport_failed',
          effect: {
            status: 'failed',
            retryable: true,
          },
        },
      },
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-notify'],
      now: '2026-03-29T07:13:00.000Z',
      blockedNotificationTransport,
    })).toEqual({
      executedActionIds: ['action-notify'],
      blockedActionIds: [],
    });
    expect(intents).toHaveLength(2);
    expect(intents[0].dedupe_key).toBe(intents[1].dedupe_key);
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'executed',
      payload: {
        execution: {
          effect: {
            status: 'succeeded',
            receipt: { transport: 'fake' },
          },
        },
      },
    });
  });

  it('does not confirm a notification when the provider returns success without delivery receipt evidence', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      auditIdGenerator: createIdGenerator('audit'),
    });
    seedActiveTask(repository);
    seedAllowedAction(repository, {
      actionId: 'action-notify',
      actionKind: 'notify_human_blocked',
      actionClass: 'notify_human',
      summary: 'AO is blocked and needs human input.',
    });

    expect(await executeAssistActions({
      repository,
      controllerId: 'default',
      task: repository.getSnapshot().state.managed_tasks[0],
      actionIds: ['action-notify'],
      now: '2026-03-29T07:12:00.000Z',
      blockedNotificationTransport: {
        async sendBlockedNotification() {
          return { status: 'succeeded', transport: 'receipt-free', attempts: 1 };
        },
      },
    })).toEqual({
      executedActionIds: [],
      blockedActionIds: ['action-notify'],
    });
    expect(repository.getSnapshot().state.actions[0]).toMatchObject({
      status: 'proposed',
      payload: {
        execution: {
          outcome: 'effect_failed',
          reason: 'blocked_notification_transport_failed',
          effect: {
            status: 'failed',
            receipt: {
              status: 'succeeded',
              transport: 'receipt-free',
              delivery_semantics: 'unknown',
              idempotency_key: null,
            },
          },
        },
      },
    });
  });
});
