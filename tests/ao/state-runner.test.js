import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createCheckpointStore } from '../../scripts/ao/lib/checkpoint-store.js';
import { createHandoffProtocol } from '../../scripts/ao/lib/handoff-protocol.js';
import {
  createActionRecord,
  createControllerLease,
  createControllerModeRecord,
  createControllerRunMetricRecord,
  createExecutionAttemptMetricRecord,
  createManagedTask,
  createOwnershipLease,
  createOverrideRecord,
  createPrBinding,
  createReviewRecord,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import { loadAoStateReport } from '../../scripts/ao/lib/state-runner.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-runner-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createClock(...values) {
  let index = 0;
  const fallback = values[values.length - 1];
  return () => {
    const value = values[index] ?? fallback;
    index += 1;
    return value;
  };
}

function createIdGenerator(prefix) {
  let index = 0;
  return () => {
    index += 1;
    return `${prefix}-${index}`;
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao state runner', () => {
  it('reports missing repo-local control-plane state without mutating the repo', async () => {
    const repoRoot = createTempRepo();

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 3,
    });

    expect(report).toMatchObject({
      schema_version: 'ao.state.v1alpha1',
      report_format: 'ao_state_report',
      project_id: PROJECT_ID,
      bootstrapped: false,
      summary: {
        managed_task_count: 0,
        pr_binding_count: 0,
        active_ownership_lease_count: 0,
        active_controller_lease_count: 0,
        action_count: 0,
        active_override_count: 0,
        controller_mode_count: 0,
        controller_modes: [],
        controller_run_metric_count: 0,
        execution_attempt_metric_count: 0,
        audit_entry_count: 0,
      },
    });
    expect(fs.existsSync(path.join(repoRoot, '.ao-control-plane'))).toBe(false);
  });

  it('summarizes bootstrapped durable state and recent audit entries', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-29T05:10:00.000Z',
        '2026-03-29T05:11:00.000Z',
        '2026-03-29T05:12:00.000Z',
        '2026-03-29T05:13:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'task-1',
      issue_number: 88,
      title: 'Durable AO control-plane state',
      branch_name: 'feat/88',
      worktree_path: '/tmp/worker-48',
      status: 'active',
      created_at: '2026-03-29T05:10:00.000Z',
      updated_at: '2026-03-29T05:10:00.000Z',
    }));
    repository.upsertOverride(createOverrideRecord({
      override_id: 'override-1',
      scope_kind: 'task',
      scope_id: 'task-1',
      override_kind: 'hold_autonomy',
      value: { enabled: true },
      status: 'active',
      created_at: '2026-03-29T05:11:00.000Z',
      expires_at: null,
      cleared_at: null,
      cleared_reason: null,
      created_by: 'operator',
    }));
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'observe',
      updated_at: '2026-03-29T05:12:00.000Z',
      updated_by: 'operator',
      reason: 'Phase-4 foundation is inspect-only.',
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-03-31T10:05:00.000Z',
    });

    expect(report.bootstrapped).toBe(true);
    expect(report.summary).toMatchObject({
      managed_task_count: 1,
      pr_binding_count: 0,
      active_ownership_lease_count: 0,
      active_controller_lease_count: 0,
      action_count: 0,
      active_override_count: 1,
      controller_mode_count: 1,
      controller_modes: ['default=observe'],
        audit_entry_count: 13,
    });
    expect(report.audit.recent_entries).toEqual([
      expect.objectContaining({
        entity_kind: 'override',
        entity_id: 'override-1',
      }),
      expect.objectContaining({
        entity_kind: 'controller_mode',
        entity_id: 'default',
      }),
    ]);
  });

  it('includes checkpoint inspection state in the operator-visible AO state report', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-30T10:00:00.000Z',
        '2026-03-30T10:01:00.000Z',
        '2026-03-30T10:02:00.000Z',
        '2026-03-30T10:03:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-110',
      issue_number: 110,
      title: 'feat(ao): add checkpoint schema and explicit resume',
      branch_name: 'feat/110',
      worktree_path: '/tmp/worker-57',
      status: 'active',
      created_at: '2026-03-30T10:00:00.000Z',
      updated_at: '2026-03-30T10:00:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-110-pr-110',
      task_id: 'issue-110',
      pr_number: 110,
      branch_name: 'feat/110',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-30T10:00:00.000Z',
      updated_at: '2026-03-30T10:00:00.000Z',
    }));
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'observe',
      updated_at: '2026-03-30T10:01:00.000Z',
      updated_by: 'operator',
      reason: 'Checkpoint inspection setup',
    }));
    repository.upsertTaskSpec(createTaskSpecRecord({
      task_id: 'issue-110',
      source_kind: 'github_issue',
      source_issue_number: 110,
      created_at: '2026-03-30T10:01:00.000Z',
      updated_at: '2026-03-30T10:01:00.000Z',
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        spec: {
          problem_type: 'issue_delivery',
          acceptance_contract: ['checkpoint-backed resume exists'],
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          human_gates: ['operator_resume'],
        },
      },
    }));
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: '2026-03-30T10:02:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:03:00.000Z',
    }).captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-03-30T10:03:00.000Z',
      actionIds: [],
    });

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-03-31T10:04:00.000Z',
    });

    expect(report.summary).toMatchObject({
      checkpoint_count: 1,
      valid_checkpoint_count: 1,
      stale_checkpoint_count: 0,
      invalid_checkpoint_count: 0,
    });
    expect(report.checkpoints.inspections).toEqual([
      expect.objectContaining({
        task_id: 'issue-110',
        state: 'valid',
      }),
    ]);
  });

  it('summarizes per-task continuity posture in the operator-visible AO state report', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-30T10:00:00.000Z',
        '2026-03-30T10:01:00.000Z',
        '2026-03-30T10:02:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-110',
      issue_number: 110,
      title: 'feat(ao): add checkpoint schema and explicit resume',
      branch_name: 'feat/110',
      worktree_path: '/tmp/worker-57',
      status: 'active',
      created_at: '2026-03-30T10:00:00.000Z',
      updated_at: '2026-03-30T10:00:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-110-pr-110',
      task_id: 'issue-110',
      pr_number: 110,
      branch_name: 'feat/110',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-30T10:00:00.000Z',
      updated_at: '2026-03-30T10:00:00.000Z',
    }));
    repository.upsertOwnershipLease(createOwnershipLease({
      lease_id: 'ownership-issue-110-worker-57',
      task_id: 'issue-110',
      owner_session_name: 'worker-57',
      owner_session_id: 'worker-57',
      status: 'active',
      acquired_at: '2026-03-30T10:00:00.000Z',
      expires_at: '2026-03-30T10:30:00.000Z',
      reason: 'task_enrolled',
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-03-31T10:04:00.000Z',
    });

    expect(report.continuity).toMatchObject({
      summary: {
        posture_counts: expect.objectContaining({
          active_owner: 1,
        }),
      },
      inspections: [
        expect.objectContaining({
          task_id: 'issue-110',
          posture: 'active_owner',
          recommended_action: 'continue_current_worker',
          owner_session_name: 'worker-57',
        }),
      ],
    });
  });

  it('includes successor handoff inspection state in the operator-visible AO state report', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-31T10:00:00.000Z',
        '2026-03-31T10:01:00.000Z',
        '2026-03-31T10:02:00.000Z',
        '2026-03-31T10:03:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-117',
      issue_number: 117,
      title: 'feat(ao): add successor handoff and authority transfer protocol',
      branch_name: 'feat/117',
      worktree_path: '/tmp/worker-58',
      status: 'active',
      created_at: '2026-03-31T10:00:00.000Z',
      updated_at: '2026-03-31T10:00:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-117-pr-117',
      task_id: 'issue-117',
      pr_number: 117,
      branch_name: 'feat/117',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-31T10:00:00.000Z',
      updated_at: '2026-03-31T10:00:00.000Z',
    }));
    repository.upsertTaskSpec(createTaskSpecRecord({
      task_id: 'issue-117',
      source_kind: 'github_issue',
      source_issue_number: 117,
      created_at: '2026-03-31T10:00:00.000Z',
      updated_at: '2026-03-31T10:00:00.000Z',
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        spec: {
          problem_type: 'issue_delivery',
          acceptance_contract: ['successor handoff protocol exists'],
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          human_gates: ['operator_handoff'],
        },
      },
    }));
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: '2026-03-31T10:01:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    createCheckpointStore({
      repository,
      now: () => '2026-03-31T10:02:00.000Z',
    }).captureCheckpoint({
      taskId: 'issue-117',
      controllerId: 'default',
      derivedTrigger: 'agent_exited',
      observedAt: '2026-03-31T10:02:00.000Z',
      actionIds: [],
    });

    const handoffProtocol = createHandoffProtocol({
      repository,
      now: () => '2026-03-31T10:03:00.000Z',
    });
    const request = handoffProtocol.requestHandoff({
      taskId: 'issue-117',
      requestedBySessionName: 'operator-1',
      requestedBySessionId: 'operator-1',
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'owner_stale',
    });
    const claim = handoffProtocol.claimHandoff({
      requestId: request.request_id,
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'continue_issue_117',
    });
    handoffProtocol.acceptHandoff({
      requestId: request.request_id,
      claimId: claim.claim_id,
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      reason: 'approved_successor',
      grantExpiresAt: '2026-04-30T10:20:00.000Z',
    });

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-03-31T10:04:00.000Z',
    });

    expect(report.summary).toMatchObject({
      handoff_request_count: 1,
      handoff_claim_count: 1,
      handoff_decision_count: 1,
      handoff_transfer_count: 0,
      active_handoff_count: 1,
    });
    expect(report.handoffs.inspections).toEqual([
      expect.objectContaining({
        task_id: 'issue-117',
        request_id: request.request_id,
        top_status: 'accepted',
      }),
    ]);
    expect(report.continuity).toMatchObject({
      summary: {
        posture_counts: expect.objectContaining({
          handoff_granted: 1,
        }),
      },
      inspections: [
        expect.objectContaining({
          task_id: 'issue-117',
          posture: 'handoff_granted',
          recommended_action: 'handoff_to_successor',
          successor_session_name: 'worker-59',
        }),
      ],
    });
  });

  it('classifies managed tasks into active, hold, ready-to-retire, and retired closeout states', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-04-01T10:00:00.000Z',
        '2026-04-01T10:01:00.000Z',
        '2026-04-01T10:02:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-120',
      issue_number: 120,
      title: 'feat(ao): closeout should retire stale managed tasks',
      branch_name: 'feat/120',
      worktree_path: '/tmp/worker-120',
      status: 'paused',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T10:00:00.000Z',
    }));
    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-121',
      issue_number: 121,
      title: 'feat(ao): pause keeps a task on hold while PR remains bound',
      branch_name: 'feat/121',
      worktree_path: '/tmp/worker-121',
      status: 'paused',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T10:00:00.000Z',
    }));
    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-122',
      issue_number: 122,
      title: 'feat(ao): active owner should remain active',
      branch_name: 'feat/122',
      worktree_path: '/tmp/worker-122',
      status: 'active',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T10:00:00.000Z',
    }));
    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-123',
      issue_number: 123,
      title: 'feat(ao): retired tasks stay retired in ao-state',
      branch_name: 'feat/123',
      worktree_path: '/tmp/worker-123',
      status: 'retired',
      created_at: '2026-04-01T10:00:00.000Z',
      updated_at: '2026-04-01T10:00:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-121-pr-121',
      task_id: 'issue-121',
      pr_number: 121,
      branch_name: 'feat/121',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-04-01T10:01:00.000Z',
      updated_at: '2026-04-01T10:01:00.000Z',
    }));
    repository.upsertOwnershipLease(createOwnershipLease({
      lease_id: 'ownership-issue-122-worker-122',
      task_id: 'issue-122',
      owner_session_name: 'worker-122',
      owner_session_id: 'worker-122',
      status: 'active',
      acquired_at: '2026-04-01T10:02:00.000Z',
      expires_at: '2026-04-01T10:32:00.000Z',
      reason: 'task_resumed',
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-04-01T10:03:00.000Z',
    });

    expect(report.tasks).toMatchObject({
      summary: {
        closeout_status_counts: {
          active: 1,
          hold: 1,
          ready_to_retire: 1,
          retired: 1,
        },
      },
      inspections: expect.arrayContaining([
        expect.objectContaining({
          task_id: 'issue-120',
          task_status: 'paused',
          closeout_status: 'ready_to_retire',
          recommended_action: 'retire_managed_task',
        }),
        expect.objectContaining({
          task_id: 'issue-121',
          task_status: 'paused',
          closeout_status: 'hold',
          recommended_action: 'hold',
        }),
        expect.objectContaining({
          task_id: 'issue-122',
          task_status: 'active',
          closeout_status: 'active',
          recommended_action: 'continue_management',
        }),
        expect.objectContaining({
          task_id: 'issue-123',
          task_status: 'retired',
          closeout_status: 'retired',
          recommended_action: 'none',
        }),
      ]),
    });
  });

  it('exposes review summary and per-task review inspections for review-frozen work', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-04-03T14:30:00.000Z',
        '2026-04-03T14:31:00.000Z',
        '2026-04-03T14:32:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-125',
      issue_number: 125,
      title: 'feat(ao): add independent reviewer gate',
      branch_name: 'task/125-reviewer-gate',
      worktree_path: '/tmp/worker-125-impl',
      status: 'active',
      created_at: '2026-04-03T14:30:00.000Z',
      updated_at: '2026-04-03T14:30:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-issue-125-pr-225',
      task_id: 'issue-125',
      pr_number: 225,
      branch_name: 'task/125-reviewer-gate',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-04-03T14:30:00.000Z',
      updated_at: '2026-04-03T14:30:00.000Z',
    }));
    repository.upsertOwnershipLease(createOwnershipLease({
      lease_id: 'ownership-issue-125-worker-125-impl',
      task_id: 'issue-125',
      owner_session_name: 'worker-125-impl',
      owner_session_id: 'session-125-impl',
      status: 'active',
      acquired_at: '2026-04-03T14:30:00.000Z',
      expires_at: '2026-04-03T15:00:00.000Z',
      reason: 'task_enrolled',
    }));
    repository.upsertReviewRecord(createReviewRecord({
      review_id: 'review-issue-125-1',
      task_id: 'issue-125',
      issue_number: 125,
      pr_number: 225,
      status: 'claimed',
      trigger_kind: 'ready_for_review',
      target_branch: 'task/125-reviewer-gate',
      target_head_sha: 'abc123',
      requested_by_session_name: 'worker-125-impl',
      requested_by_session_id: 'session-125-impl',
      implementation_session_name: 'worker-125-impl',
      implementation_session_id: 'session-125-impl',
      reviewer_session_name: 'worker-125-review',
      reviewer_session_id: 'session-125-review',
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
      freeze_status: 'active',
      created_at: '2026-04-03T14:31:00.000Z',
      updated_at: '2026-04-03T14:31:00.000Z',
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-04-03T14:32:00.000Z',
    });

    expect(report.reviews).toMatchObject({
      summary: {
        open_count: 0,
        claimed_count: 1,
        passed_count: 0,
        changes_required_count: 0,
        escalated_count: 0,
        freeze_active_count: 1,
      },
      inspections: [
        expect.objectContaining({
          task_id: 'issue-125',
          review_id: 'review-issue-125-1',
          status: 'claimed',
          posture: 'review_pending',
          reviewer_session_name: 'worker-125-review',
          target_head_sha: 'abc123',
          freeze_status: 'active',
          freeze_active: true,
          blocking_reason: 'independent_review_active',
        }),
      ],
    });
    expect(report.tasks.inspections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_id: 'issue-125',
        task_status: 'active',
        closeout_status: 'hold',
        recommended_action: 'hold',
        review_posture: 'review_pending',
        review_freeze_status: 'active',
        review_blocking_reason: 'independent_review_active',
      }),
    ]));
  });

  it('classifies historical debt into retained evidence, archive candidates, and cleanup candidates', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-04-02T10:00:00.000Z',
        '2026-04-02T10:01:00.000Z',
        '2026-04-02T10:02:00.000Z',
        '2026-04-02T10:03:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-130',
      issue_number: 130,
      title: 'feat(ao): closeout-ready task should become cleanup debt',
      branch_name: 'task/130-cleanup-ready',
      worktree_path: path.join(repoRoot, '.worktrees', 'task-130--cleanup-ready'),
      status: 'paused',
      created_at: '2026-04-02T10:00:00.000Z',
      updated_at: '2026-04-02T10:00:00.000Z',
    }));
    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-131',
      issue_number: 131,
      title: 'feat(ao): active task evidence should stay retained',
      branch_name: 'task/131-active-owner',
      worktree_path: path.join(repoRoot, '.worktrees', 'task-131--active-owner'),
      status: 'active',
      created_at: '2026-04-02T10:00:00.000Z',
      updated_at: '2026-04-02T10:00:00.000Z',
    }));
    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-132',
      issue_number: 132,
      title: 'feat(ao): retired task history should become an archive candidate',
      branch_name: 'task/132-retired-history',
      worktree_path: path.join(repoRoot, '.worktrees', 'task-132--retired-history'),
      status: 'retired',
      created_at: '2026-04-02T10:00:00.000Z',
      updated_at: '2026-04-02T10:00:00.000Z',
    }));
    repository.upsertOwnershipLease(createOwnershipLease({
      lease_id: 'ownership-issue-131-worker-131',
      task_id: 'issue-131',
      owner_session_name: 'worker-131',
      owner_session_id: 'worker-131',
      status: 'active',
      acquired_at: '2026-04-02T10:01:00.000Z',
      expires_at: '2026-04-02T10:31:00.000Z',
      reason: 'task_resumed',
    }));
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-worker-130',
      controller_id: 'default',
      holder_id: 'worker-130',
      holder_type: 'session',
      status: 'active',
      acquired_at: '2026-04-02T10:00:00.000Z',
      heartbeat_at: '2026-04-02T10:00:30.000Z',
      expires_at: '2026-04-02T10:04:00.000Z',
      runtime_kind: 'continuous',
      poll_interval_ms: 15000,
      shutdown_timeout_ms: 5000,
      metadata: {},
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
      now: '2026-04-02T11:00:00.000Z',
      repoInventory: {
        task_worktrees: [
          {
            worktree_name: 'task-130--cleanup-ready',
            worktree_path: path.join(repoRoot, '.worktrees', 'task-130--cleanup-ready'),
          },
          {
            worktree_name: 'task-131--active-owner',
            worktree_path: path.join(repoRoot, '.worktrees', 'task-131--active-owner'),
          },
          {
            worktree_name: 'task-999--orphaned-debt',
            worktree_path: path.join(repoRoot, '.worktrees', 'task-999--orphaned-debt'),
          },
        ],
        task_branches: [
          'task/130-cleanup-ready',
          'task/131-active-owner',
          'task/999-orphaned-debt',
        ],
        loose_artifacts: [
          'jest_err.txt',
          'phase4_full_sweep.txt',
        ],
      },
    });

    expect(report.debt).toMatchObject({
      summary: {
        category_counts: {
          keep_evidence: 2,
          archive_candidate: 1,
          cleanup_candidate: 8,
        },
      },
      inspections: expect.arrayContaining([
        expect.objectContaining({
          item_kind: 'task_worktree',
          item_ref: path.join(repoRoot, '.worktrees', 'task-130--cleanup-ready'),
          category: 'cleanup_candidate',
          recommended_action: 'remove_task_worktree',
          reason_codes: ['task_ready_to_retire'],
        }),
        expect.objectContaining({
          item_kind: 'task_branch',
          item_ref: 'task/131-active-owner',
          category: 'keep_evidence',
          recommended_action: 'retain_active_branch',
          reason_codes: ['task_still_active'],
        }),
        expect.objectContaining({
          item_kind: 'task_branch',
          item_ref: 'task/999-orphaned-debt',
          category: 'cleanup_candidate',
          recommended_action: 'delete_task_branch',
          reason_codes: ['orphaned_task_branch'],
        }),
        expect.objectContaining({
          item_kind: 'controller_lease',
          item_ref: 'controller-default-worker-130',
          category: 'cleanup_candidate',
          recommended_action: 'reclaim_stale_controller_lease',
          reason_codes: ['controller_lease_expired'],
        }),
        expect.objectContaining({
          item_kind: 'ownership_lease',
          item_ref: 'ownership-issue-131-worker-131',
          category: 'cleanup_candidate',
          recommended_action: 'release_stale_ownership_lease',
          reason_codes: ['ownership_lease_expired'],
        }),
        expect.objectContaining({
          item_kind: 'artifact',
          item_ref: 'jest_err.txt',
          category: 'cleanup_candidate',
          recommended_action: 'move_to_runs_or_delete',
          reason_codes: ['loose_temp_artifact'],
        }),
        expect.objectContaining({
          item_kind: 'managed_task',
          item_ref: 'issue-132',
          category: 'archive_candidate',
          recommended_action: 'archive_retired_task_history',
          reason_codes: ['retired_task_history'],
        }),
      ]),
    });
  });

  it('includes measurement summaries and recent traces in the operator-visible AO state report', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-31T12:00:00.000Z',
        '2026-03-31T12:01:00.000Z',
        '2026-03-31T12:02:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-118',
      issue_number: 118,
      title: 'feat(ao): add trace, cost, and failure taxonomy',
      branch_name: 'feat/118',
      worktree_path: '/tmp/worker-59',
      status: 'active',
      created_at: '2026-03-31T12:00:00.000Z',
      updated_at: '2026-03-31T12:00:00.000Z',
    }));
    repository.upsertControllerRunMetric(createControllerRunMetricRecord({
      controller_run_metric_id: 'controller-run-1',
      task_id: 'issue-118',
      issue_number: 118,
      pr_number: 128,
      controller_id: 'default',
      controller_mode: 'assist',
      trigger_kind: 'approved_and_green',
      lifecycle_top_status: 'continue',
      failure_class: 'policy_block',
      started_at: '2026-03-31T12:00:00.000Z',
      completed_at: '2026-03-31T12:00:03.000Z',
      duration_ms: 3000,
      observation_count: 2,
      delivery_event_count: 3,
      proposed_action_count: 2,
      executed_action_count: 1,
      blocked_action_count: 1,
      policy_decision_count: 2,
      policy_blocked_action_count: 1,
      denied_action_count: 1,
      downgraded_action_count: 0,
      action_class_counts: {
        continue_worker: 1,
        notify_human: 1,
      },
      intervention_counts: {
        human_gate: 0,
        override: 0,
        explicit_resume: 0,
        successor_handoff: 0,
        policy_block: 1,
        preflight_block: 0,
      },
      token_usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
      cost: {
        usd: null,
      },
    }));
    repository.upsertExecutionAttemptMetric(createExecutionAttemptMetricRecord({
      execution_attempt_metric_id: 'execution-attempt-1',
      attempt_kind: 'managed_task',
      task_id: 'issue-118',
      issue_number: 118,
      pr_number: 128,
      controller_id: null,
      owner_session_name: 'worker-59',
      owner_session_id: 'worker-59',
      action_id: null,
      action_kind: null,
      action_class: null,
      command: 'resume',
      status: 'active',
      retry_cause: 'explicit_resume',
      failure_class: 'none',
      reason: null,
      started_at: '2026-03-31T12:01:00.000Z',
      completed_at: null,
      duration_ms: null,
      intervention_counts: {
        human_gate: 0,
        override: 0,
        explicit_resume: 1,
        successor_handoff: 0,
        policy_block: 0,
        preflight_block: 0,
      },
      token_usage: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
      },
      cost: {
        usd: null,
      },
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 2,
    });

    expect(report.summary).toMatchObject({
      controller_run_metric_count: 1,
      execution_attempt_metric_count: 1,
    });
    expect(report.metrics.summary).toMatchObject({
      controller_run_count: 1,
      execution_attempt_count: 1,
      intervention_counts: expect.objectContaining({
        explicit_resume: 1,
        policy_block: 1,
      }),
      failure_class_counts: expect.objectContaining({
        none: 1,
        policy_block: 1,
      }),
    });
    expect(report.metrics.recent_traces).toMatchObject({
      controller_runs: [
        expect.objectContaining({
          controller_run_metric_id: 'controller-run-1',
          failure_class: 'policy_block',
        }),
      ],
      execution_attempts: [
        expect.objectContaining({
          execution_attempt_metric_id: 'execution-attempt-1',
          retry_cause: 'explicit_resume',
        }),
      ],
    });
  });

  it('surfaces recent assist action execution explanations in the operator-visible AO state report', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-04-01T12:00:00.000Z',
        '2026-04-01T12:01:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-119',
      issue_number: 119,
      title: 'feat(ao): stabilize assist execution contract',
      branch_name: 'feat/119',
      worktree_path: '/tmp/worker-60',
      status: 'active',
      created_at: '2026-04-01T12:00:00.000Z',
      updated_at: '2026-04-01T12:00:00.000Z',
    }));

    repository.upsertAction(createActionRecord({
      action_id: 'action-continue',
      task_id: 'issue-119',
      action_kind: 'continue_worker',
      status: 'executed',
      requested_by: 'assist_controller',
      reason: 'Continue the current worker owner.',
      created_at: '2026-04-01T12:00:00.000Z',
      updated_at: '2026-04-01T12:01:00.000Z',
      payload: {
        policy_decision_id: 'policy-119',
        policy: {
          decision: 'allow',
          policy_version: 'ao.policy.v1',
        },
        action_model: {
          action_kind: 'continue_worker',
          action_class: 'continue_worker',
          risk_class: 'class_a',
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
        },
        execution: {
          outcome: 'executed',
          reason: 'class_a_assist_execution',
          executed_at: '2026-04-01T12:01:00.000Z',
          executor: 'assist_controller',
        },
      },
    }));

    const report = await loadAoStateReport({
      repoRoot,
      projectId: PROJECT_ID,
      auditLimit: 5,
      now: '2026-04-01T12:02:00.000Z',
    });

    expect(report.actions).toMatchObject({
      recent: [
        expect.objectContaining({
          action_id: 'action-continue',
          action_kind: 'continue_worker',
          status: 'executed',
          risk_class: 'class_a',
          policy_decision: 'allow',
          model_executable: true,
          model_reason: 'class_a_allowlist',
          execution_reason: 'class_a_assist_execution',
          runtime_preflight_status: 'clean',
          idempotency_mode: 'action_status_gate',
          rollback_mode: 'audit_only',
        }),
      ],
    });
  });
});
