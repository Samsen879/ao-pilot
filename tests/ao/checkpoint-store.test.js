import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createCheckpointStore } from '../../scripts/ao/lib/checkpoint-store.js';
import {
  createControllerModeRecord,
  createManagedTask,
  createPrBinding,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { resolveControlPlanePaths } from '../../scripts/ao/lib/state-migrations.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-checkpoint-store-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createRepository() {
  return createStateRepository({
    repoRoot: createTempRepo(),
    projectId: PROJECT_ID,
  });
}

function seedResumeSafeTask(repository, {
  taskId = 'issue-110',
  issueNumber = 110,
  branchName = 'feat/110',
  worktreePath = '/tmp/worker-57',
  prNumber = 110,
  now = '2026-03-30T10:00:00.000Z',
} = {}) {
  repository.upsertManagedTask(createManagedTask({
    task_id: taskId,
    issue_number: issueNumber,
    title: 'feat(ao): add checkpoint schema and explicit resume',
    branch_name: branchName,
    worktree_path: worktreePath,
    status: 'active',
    created_at: now,
    updated_at: now,
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: `binding-${taskId}-pr-${prNumber}`,
    task_id: taskId,
    pr_number: prNumber,
    branch_name: branchName,
    base_branch: 'main',
    status: 'bound',
    created_at: now,
    updated_at: now,
  }));
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: 'default',
    mode: 'observe',
    updated_at: now,
    updated_by: 'operator',
    reason: 'Checkpoint test setup',
  }));
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
    created_at: now,
    updated_at: now,
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Checkpoint-backed resume exists.'],
        runtime_ref: 'runtime.github_local',
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_resume'],
      },
    },
  }));
  repository.ensureRuntimePreflights({
    cwd: repository.getSnapshot().paths.repoRoot,
    now,
    probes: {
      commandExists: () => true,
      pathExists: () => true,
      capability: () => true,
    },
  });
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao checkpoint store', () => {
  it('persists a versioned checkpoint with task, verification, and execution references', () => {
    const repository = createRepository();
    seedResumeSafeTask(repository);
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:05:00.000Z',
    });

    const checkpoint = checkpointStore.captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      lifecycleTopStatus: null,
      observedAt: '2026-03-30T10:05:00.000Z',
      actionIds: ['proposal-issue-110-continue'],
    });

    expect(checkpoint).toMatchObject({
      task_id: 'issue-110',
      snapshot: {
        schema_version: 'ao.checkpoint.v1alpha1',
        format: 'ao_checkpoint',
        task_ref: {
          task_id: 'issue-110',
          issue_number: 110,
          branch_name: 'feat/110',
          worktree_path: '/tmp/worker-57',
          pr_binding: {
            pr_number: 110,
            branch_name: 'feat/110',
          },
        },
        verification_ref: {
          task_spec: {
            task_id: 'issue-110',
            state: 'valid',
            snapshot_schema_version: 'ao.task-spec.v1alpha1',
          },
          runtime_preflight: {
            runtime_ref: 'runtime.github_local',
            status: 'clean',
            snapshot_schema_version: 'ao.runtime-preflight.v1alpha1',
            replay_key: expect.stringMatching(/^runtime_preflight:/),
          },
        },
        execution_ref: {
          controller_id: 'default',
          controller_mode: 'observe',
          derived_trigger: 'manual',
          lifecycle_top_status: null,
          observed_at: '2026-03-30T10:05:00.000Z',
          action_ids: ['proposal-issue-110-continue'],
        },
      },
    });

    expect(checkpointStore.inspectCheckpoint({
      taskId: 'issue-110',
    })).toMatchObject({
      task_id: 'issue-110',
      checkpoint_id: checkpoint.checkpoint_id,
      state: 'valid',
      reason_codes: [],
    });
    expect(checkpointStore.inspectAllCheckpoints()).toEqual([
      expect.objectContaining({
        task_id: 'issue-110',
        state: 'valid',
      }),
    ]);
  });

  it('fails closed when the current durable task state has advanced past the checkpoint', () => {
    const repository = createRepository();
    seedResumeSafeTask(repository);
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:05:00.000Z',
    });

    checkpointStore.captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-03-30T10:05:00.000Z',
      actionIds: [],
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-110',
      issue_number: 110,
      title: 'feat(ao): add checkpoint schema and explicit resume',
      branch_name: 'feat/110',
      worktree_path: '/tmp/worker-57b',
      status: 'active',
      created_at: '2026-03-30T10:00:00.000Z',
      updated_at: '2026-03-30T10:06:00.000Z',
    }));

    expect(checkpointStore.inspectCheckpoint({
      taskId: 'issue-110',
    })).toMatchObject({
      state: 'stale',
      reason_codes: expect.arrayContaining(['managed_task_advanced']),
    });
    expect(() => checkpointStore.loadCheckpointForResume({
      taskId: 'issue-110',
    })).toThrow(/stale checkpoint/i);
  });

  it('detects mixed-version checkpoint state during inspection', () => {
    const repository = createRepository();
    seedResumeSafeTask(repository);
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:05:00.000Z',
    });

    const checkpoint = checkpointStore.captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-03-30T10:05:00.000Z',
      actionIds: [],
    });
    const paths = resolveControlPlanePaths({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
    });
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    state.checkpoints = state.checkpoints.map((record) => (
      record.checkpoint_id === checkpoint.checkpoint_id
        ? {
            ...record,
            snapshot: {
              ...record.snapshot,
              schema_version: 'ao.checkpoint.v0alpha9',
            },
          }
        : record
    ));
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    expect(checkpointStore.inspectCheckpoint({
      taskId: 'issue-110',
    })).toMatchObject({
      state: 'invalid',
      reason_codes: expect.arrayContaining(['checkpoint_mixed_version']),
    });
  });
});
