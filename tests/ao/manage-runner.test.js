import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createCheckpointStore } from '../../scripts/ao/lib/checkpoint-store.js';
import { createHandoffProtocol } from '../../scripts/ao/lib/handoff-protocol.js';
import { createReviewProtocol } from '../../scripts/ao/lib/review-protocol.js';
import { resolveControlPlanePaths } from '../../scripts/ao/lib/state-migrations.js';
import {
  runManageCommand,
  runManagedTaskMetadataScan,
} from '../../scripts/ao/lib/manage-runner.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-manage-runner-'));
  fs.mkdirSync(path.join(repoRoot, '.git'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function readState(repoRoot) {
  const paths = resolveControlPlanePaths({
    repoRoot,
    projectId: PROJECT_ID,
  });
  return JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao manage runner', () => {
  it('fails closed when historical scan evidence is missing', () => {
    const repoRoot = createTempRepo();

    expect(() => runManagedTaskMetadataScan({ repoRoot, projectId: PROJECT_ID }))
      .toThrow('schema.json and state.json are both required');
  });

  it.each([
    ['schema_version', 'ao.control-plane.schema.v2', 'schema envelope version'],
    ['format', 'ao_control_plane_schema_future', 'schema envelope format'],
  ])('fails closed on unsupported schema envelope %s evidence', (field, value, expectedError) => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({ repoRoot, projectId: PROJECT_ID });
    repository.upsertManagedTask({
      task_id: 'schema-envelope-evidence',
      title: 'Schema envelope evidence',
      status: 'active',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:00:00.000Z',
    });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const schema = JSON.parse(fs.readFileSync(paths.schemaPath, 'utf8'));
    schema[field] = value;
    fs.writeFileSync(paths.schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');

    expect(() => runManagedTaskMetadataScan({ repoRoot, projectId: PROJECT_ID }))
      .toThrow(expectedError);
  });

  it('fails closed on an unsupported state envelope format', () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({ repoRoot, projectId: PROJECT_ID });
    repository.upsertManagedTask({
      task_id: 'state-envelope-evidence',
      title: 'State envelope evidence',
      status: 'active',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:00:00.000Z',
    });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    state.format = 'ao_control_plane_state_future';
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    expect(() => runManagedTaskMetadataScan({ repoRoot, projectId: PROJECT_ID }))
      .toThrow('state envelope format');
  });

  it('scans historical metadata deterministically without promoting or deleting it', () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({ repoRoot, projectId: PROJECT_ID });
    repository.upsertManagedTask({
      task_id: 'compatible-task',
      title: 'Compatible metadata',
      status: 'active',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:00:00.000Z',
      metadata: { note: 'preserve' },
    });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const state = readState(repoRoot);
    state.managed_tasks.push({
      task_id: 'historical-task',
      issue_number: 28,
      title: 'Historical shadow metadata',
      branch_name: null,
      worktree_path: null,
      status: 'paused',
      created_at: '2026-03-29T06:00:00.000Z',
      updated_at: '2026-03-29T06:00:00.000Z',
      metadata: { parent_task_id: 'issue-9', note: 'do not delete' },
    });
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    const before = fs.readFileSync(paths.statePath, 'utf8');

    const first = runManagedTaskMetadataScan({ repoRoot, projectId: PROJECT_ID });
    const second = runManagedTaskMetadataScan({ repoRoot, projectId: PROJECT_ID });
    const relative = runManagedTaskMetadataScan({
      repoRoot: path.relative(process.cwd(), repoRoot),
      projectId: PROJECT_ID,
    });

    expect(second).toEqual(first);
    expect(relative).toEqual(first);
    expect(first).toMatchObject({
      command: 'scan-metadata',
      status: 'blocked',
      source_artifact: '.ao-control-plane/my-project/state.json',
      scanned_task_count: 2,
      finding_count: 1,
      findings: [expect.objectContaining({
        task_id: 'historical-task',
        offending_key: 'parent_task_id',
      })],
    });
    expect(fs.readFileSync(paths.statePath, 'utf8')).toBe(before);
  });

  it('enrolls a managed task with durable PR, branch, worktree, and ownership bindings', async () => {
    const repoRoot = createTempRepo();

    const result = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50',
      prNumber: 109,
      ownerSessionName: 'worker-50',
      ownerSessionId: 'worker-50',
      now: '2026-03-29T06:20:00.000Z',
    });

    expect(result.task).toMatchObject({
      task_id: 'issue-89',
      issue_number: 89,
      status: 'active',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50',
    });
    expect(result.prBinding).toMatchObject({
      task_id: 'issue-89',
      pr_number: 109,
      status: 'bound',
    });
    expect(result.ownershipLease).toMatchObject({
      task_id: 'issue-89',
      owner_session_name: 'worker-50',
      status: 'active',
    });
    expect(result.continuity).toMatchObject({
      posture: 'active_owner',
      recommended_action: 'continue_current_worker',
      owner_session_name: 'worker-50',
      reason_codes: ['ownership_clear'],
    });
    expect(result.taskSpec).toMatchObject({
      task_id: 'issue-89',
      state: 'invalid',
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        valid: false,
      },
    });

    const state = readState(repoRoot);
    expect(state.managed_tasks).toHaveLength(1);
    expect(state.pr_bindings).toHaveLength(1);
    expect(state.ownership_leases).toHaveLength(1);
    expect(state.task_specs).toHaveLength(1);
  });

  it('persists a valid task spec when enroll receives issue/template input', async () => {
    const repoRoot = createTempRepo();

    const result = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 105,
      title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
      branchName: 'feat/105',
      worktreePath: '/tmp/worker-52',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- fixture-backed tests exist',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_enroll',
      ].join('\n'),
      now: '2026-03-29T06:20:00.000Z',
    });

    expect(result.taskSpec).toMatchObject({
      task_id: 'issue-105',
      state: 'valid',
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        valid: true,
      },
    });
  });

  it('adopts a paused task back into active management and refreshes its bindings', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branchName: 'feat/issue-89',
      worktreePath: '/tmp/worker-50',
      now: '2026-03-29T06:20:00.000Z',
    });
    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'unmanage',
      issueNumber: 89,
      now: '2026-03-29T06:21:00.000Z',
      reason: 'operator_pause',
    });

    const result = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'adopt',
      issueNumber: 89,
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50b',
      prNumber: 110,
      ownerSessionName: 'worker-50',
      ownerSessionId: 'worker-50',
      now: '2026-03-29T06:22:00.000Z',
    });

    expect(result.task).toMatchObject({
      task_id: 'issue-89',
      status: 'active',
      branch_name: 'feat/89',
      worktree_path: '/tmp/worker-50b',
    });
    expect(result.prBinding).toMatchObject({
      pr_number: 110,
      status: 'bound',
    });
    expect(result.ownershipLease).toMatchObject({
      owner_session_name: 'worker-50',
      status: 'active',
    });
  });

  it('resumes a paused task from an explicit checkpoint instead of treating it as a new enrollment', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 110,
      title: 'feat(ao): add checkpoint schema and explicit resume',
      branchName: 'feat/110',
      worktreePath: '/tmp/worker-57',
      prNumber: 120,
      ownerSessionName: 'worker-57',
      ownerSessionId: 'worker-57',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- checkpoint-backed resume exists',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_resume',
      ].join('\n'),
      now: '2026-03-30T10:00:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: '2026-03-30T10:01:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:02:00.000Z',
    });
    const checkpoint = checkpointStore.captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-03-30T10:02:00.000Z',
      actionIds: ['proposal-issue-110-continue'],
    });

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'unmanage',
      issueNumber: 110,
      now: '2026-03-30T10:03:00.000Z',
      reason: 'worker_exited',
    });

    const result = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'resume',
      issueNumber: 110,
      ownerSessionName: 'worker-57',
      ownerSessionId: 'worker-57',
      now: '2026-03-30T10:04:00.000Z',
    });

    expect(result.task).toMatchObject({
      task_id: 'issue-110',
      status: 'active',
      branch_name: 'feat/110',
      worktree_path: '/tmp/worker-57',
      metadata: expect.objectContaining({
        resume: expect.objectContaining({
          last_resume_checkpoint_id: checkpoint.checkpoint_id,
          resume_kind: 'explicit_checkpoint',
          resumed_at: '2026-03-30T10:04:00.000Z',
        }),
      }),
    });
    expect(result.prBinding).toMatchObject({
      pr_number: 120,
      status: 'bound',
    });
    expect(result.ownershipLease).toMatchObject({
      owner_session_name: 'worker-57',
      status: 'active',
    });
    expect(result.resume).toMatchObject({
      checkpoint_id: checkpoint.checkpoint_id,
      state: 'valid',
    });

    const state = readState(repoRoot);
    expect(state.execution_attempt_metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attempt_kind: 'managed_task',
        task_id: 'issue-110',
        owner_session_name: 'worker-57',
        command: 'enroll',
        status: 'paused',
        failure_class: 'worker_exit',
        retry_cause: 'none',
      }),
      expect.objectContaining({
        attempt_kind: 'managed_task',
        task_id: 'issue-110',
        owner_session_name: 'worker-57',
        command: 'resume',
        status: 'active',
        failure_class: 'none',
        retry_cause: 'explicit_resume',
        intervention_counts: expect.objectContaining({
          explicit_resume: 1,
          successor_handoff: 0,
        }),
      }),
    ]));
  });

  it('fails closed when explicit resume sees a stale checkpoint', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 110,
      title: 'feat(ao): add checkpoint schema and explicit resume',
      branchName: 'feat/110',
      worktreePath: '/tmp/worker-57',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- checkpoint-backed resume exists',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_resume',
      ].join('\n'),
      now: '2026-03-30T10:00:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: '2026-03-30T10:01:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => '2026-03-30T10:02:00.000Z',
    });
    checkpointStore.captureCheckpoint({
      taskId: 'issue-110',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-03-30T10:02:00.000Z',
      actionIds: [],
    });

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'adopt',
      issueNumber: 110,
      branchName: 'feat/110b',
      worktreePath: '/tmp/worker-57b',
      now: '2026-03-30T10:03:00.000Z',
    });

    await expect(runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'resume',
      issueNumber: 110,
      ownerSessionName: 'worker-57',
      ownerSessionId: 'worker-57',
      now: '2026-03-30T10:04:00.000Z',
    })).rejects.toThrow(/stale checkpoint/i);
  });

  it('surfaces review_pending posture when an active task is frozen behind an independent review request', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 125,
      title: 'feat(ao): add independent reviewer gate',
      branchName: 'task/125-reviewer-gate',
      worktreePath: '/tmp/worker-125-impl',
      prNumber: 225,
      ownerSessionName: 'worker-125-impl',
      ownerSessionId: 'session-125-impl',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- independent review gate exists',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_review',
      ].join('\n'),
      now: '2026-04-03T14:30:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const review = createReviewProtocol({
      repository,
      now: () => '2026-04-03T14:35:00.000Z',
    }).requestReview({
      taskId: 'issue-125',
      requestedBySessionName: 'worker-125-impl',
      requestedBySessionId: 'session-125-impl',
      implementationSessionName: 'worker-125-impl',
      implementationSessionId: 'session-125-impl',
      targetHeadSha: 'abc123',
      verificationBaseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
    });

    expect(review).toMatchObject({
      status: 'open',
      freeze_status: 'active',
    });

    const inspection = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'adopt',
      issueNumber: 125,
      branchName: 'task/125-reviewer-gate',
      worktreePath: '/tmp/worker-125-impl',
      prNumber: 225,
      ownerSessionName: 'worker-125-impl',
      ownerSessionId: 'session-125-impl',
      now: '2026-04-03T14:36:00.000Z',
    });

    expect(inspection.continuity).toMatchObject({
      posture: 'active_owner',
      recommended_action: 'continue_current_worker',
    });
    expect(inspection.review).toMatchObject({
      review_id: review.review_id,
      task_id: 'issue-125',
      status: 'open',
      posture: 'review_pending',
      freeze_status: 'active',
      freeze_active: true,
      blocking_reason: 'independent_review_active',
      target_head_sha: 'abc123',
    });

    const inspectRepository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    expect(inspectRepository.getSnapshot().state.review_records).toEqual([
      expect.objectContaining({
        task_id: 'issue-125',
        status: 'open',
      }),
    ]);
  });

  it('fails closed on resume while an independent review freeze is active', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 126,
      title: 'feat(ao): freeze implementation while reviewer owns the slice',
      branchName: 'task/126-review-freeze',
      worktreePath: '/tmp/worker-126-impl',
      prNumber: 226,
      ownerSessionName: 'worker-126-impl',
      ownerSessionId: 'session-126-impl',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- review freeze blocks implementation resume',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_review',
      ].join('\n'),
      now: '2026-04-03T15:00:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: '2026-04-03T15:01:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    createCheckpointStore({
      repository,
      now: () => '2026-04-03T15:02:00.000Z',
    }).captureCheckpoint({
      taskId: 'issue-126',
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: '2026-04-03T15:02:00.000Z',
      actionIds: [],
    });

    createReviewProtocol({
      repository,
      now: () => '2026-04-03T15:03:00.000Z',
    }).requestReview({
      taskId: 'issue-126',
      requestedBySessionName: 'worker-126-impl',
      requestedBySessionId: 'session-126-impl',
      implementationSessionName: 'worker-126-impl',
      implementationSessionId: 'session-126-impl',
      targetHeadSha: 'def126',
      verificationBaseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
    });

    await expect(runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'resume',
      issueNumber: 126,
      ownerSessionName: 'worker-126-impl',
      ownerSessionId: 'session-126-impl',
      now: '2026-04-03T15:04:00.000Z',
    })).rejects.toThrow(/independent review is active/i);

    const state = readState(repoRoot);
    expect(state.managed_tasks).toEqual([
      expect.objectContaining({
        task_id: 'issue-126',
        status: 'active',
      }),
    ]);
    expect(state.ownership_leases).toEqual([
      expect.objectContaining({
        task_id: 'issue-126',
        owner_session_name: 'worker-126-impl',
        status: 'active',
      }),
    ]);
  });

  it('blocks successor resume until an accepted handoff grant exists', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 117,
      title: 'feat(ao): add successor handoff and authority transfer protocol',
      branchName: 'feat/117',
      worktreePath: '/tmp/worker-58',
      prNumber: 127,
      ownerSessionName: 'worker-58',
      ownerSessionId: 'worker-58',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- successor handoff protocol exists',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_handoff',
      ].join('\n'),
      now: '2026-03-31T10:00:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
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
      actionIds: ['proposal-issue-117-handoff'],
    });

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'unmanage',
      issueNumber: 117,
      now: '2026-03-31T10:03:00.000Z',
      reason: 'worker_stale',
    });

    await expect(runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'resume',
      issueNumber: 117,
      ownerSessionName: 'worker-59',
      ownerSessionId: 'worker-59',
      now: '2026-03-31T10:04:00.000Z',
    })).rejects.toThrow(/accepted handoff/i);
  });

  it('transfers ownership to the accepted successor during resume', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 117,
      title: 'feat(ao): add successor handoff and authority transfer protocol',
      branchName: 'feat/117',
      worktreePath: '/tmp/worker-58',
      prNumber: 127,
      ownerSessionName: 'worker-58',
      ownerSessionId: 'worker-58',
      taskSpecBody: [
        '## Problem Type',
        'issue_delivery',
        '',
        '## Acceptance Contract',
        '- successor handoff protocol exists',
        '',
        '## Runtime Ref',
        'runtime.github_local',
        '',
        '## Policy Ref',
        'policy.operator_gated',
        '',
        '## Human Gates',
        '- operator_handoff',
      ].join('\n'),
      now: '2026-03-31T10:00:00.000Z',
    });

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
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
      actionIds: ['proposal-issue-117-handoff'],
    });

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'unmanage',
      issueNumber: 117,
      now: '2026-03-31T10:03:00.000Z',
      reason: 'worker_stale',
    });

    const handoffProtocol = createHandoffProtocol({
      repository,
      now: () => '2026-03-31T10:04:00.000Z',
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
      reason: 'resume_as_successor',
    });
    handoffProtocol.acceptHandoff({
      requestId: request.request_id,
      claimId: claim.claim_id,
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      reason: 'approved_successor',
      grantExpiresAt: '2026-03-31T10:20:00.000Z',
    });

    const result = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'resume',
      issueNumber: 117,
      ownerSessionName: 'worker-59',
      ownerSessionId: 'worker-59',
      now: '2026-03-31T10:05:00.000Z',
    });

    expect(result.ownershipLease).toMatchObject({
      task_id: 'issue-117',
      owner_session_name: 'worker-59',
      status: 'active',
    });
    expect(result.handoffTransfer).toMatchObject({
      request_id: request.request_id,
      claim_id: claim.claim_id,
      successor_session_name: 'worker-59',
      checkpoint_id: expect.stringMatching(/^checkpoint-issue-117-/),
    });
    expect(result.continuity).toMatchObject({
      posture: 'active_owner',
      recommended_action: 'continue_current_worker',
      owner_session_name: 'worker-59',
      successor_session_name: 'worker-59',
      reason_codes: ['ownership_clear'],
    });

    const state = readState(repoRoot);
    expect(state.handoff_requests).toEqual([
      expect.objectContaining({
        request_id: request.request_id,
        status: 'completed',
      }),
    ]);
    expect(state.handoff_transfers).toEqual([
      expect.objectContaining({
        request_id: request.request_id,
        successor_session_name: 'worker-59',
      }),
    ]);
    expect(state.execution_attempt_metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attempt_kind: 'managed_task',
        task_id: 'issue-117',
        owner_session_name: 'worker-58',
        command: 'enroll',
        status: 'paused',
        failure_class: 'worker_exit',
      }),
      expect.objectContaining({
        attempt_kind: 'managed_task',
        task_id: 'issue-117',
        owner_session_name: 'worker-59',
        command: 'resume',
        status: 'active',
        retry_cause: 'successor_handoff',
        intervention_counts: expect.objectContaining({
          explicit_resume: 0,
          successor_handoff: 1,
        }),
      }),
    ]));
  });

  it('unmanages and retires a task without deleting its durable bindings', async () => {
    const repoRoot = createTempRepo();

    await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'enroll',
      issueNumber: 89,
      title: 'Managed-task enrollment and shadow controller loop',
      branchName: 'feat/89',
      worktreePath: '/tmp/worker-50',
      prNumber: 109,
      ownerSessionName: 'worker-50',
      ownerSessionId: 'worker-50',
      now: '2026-03-29T06:20:00.000Z',
    });

    const unmanaged = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'unmanage',
      issueNumber: 89,
      now: '2026-03-29T06:21:00.000Z',
      reason: 'operator_pause',
    });
    const retired = await runManageCommand({
      repoRoot,
      projectId: PROJECT_ID,
      command: 'retire',
      issueNumber: 89,
      now: '2026-03-29T06:22:00.000Z',
      reason: 'work_complete',
    });

    expect(unmanaged.task).toMatchObject({
      task_id: 'issue-89',
      status: 'paused',
    });
    expect(unmanaged.releasedOwnershipLeaseIds).toEqual(['ownership-issue-89-worker-50']);
    expect(retired.task).toMatchObject({
      task_id: 'issue-89',
      status: 'retired',
    });
    expect(retired.releasedPrBindingIds).toEqual(['binding-issue-89-pr-109']);

    const state = readState(repoRoot);
    expect(state.managed_tasks[0].status).toBe('retired');
    expect(state.pr_bindings[0].status).toBe('released');
    expect(state.ownership_leases[0].status).toBe('released');
  });
});
