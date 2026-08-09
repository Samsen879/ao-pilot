import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  createActionRecord,
  createControllerLease,
  createControllerModeRecord,
  createCredentialProvenanceRecord,
  createDeliveryEventRecord,
  createManagedTask,
  createOverrideRecord,
  createOwnershipLease,
  createPolicyDecisionRecord,
  createPrBinding,
  createReviewRecord,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import {
  buildCurrentProcessMetadata,
  withFileLock,
  writeJsonFileAtomic,
} from '../../scripts/ao/lib/state-storage.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-state-repository-'));
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

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao state repository', () => {
  it('returns a virtual empty snapshot before bootstrap without mutating the repo', () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });

    const snapshot = repository.getSnapshot();

    expect(snapshot.bootstrapped).toBe(false);
    expect(snapshot.state).toMatchObject({
      project_id: PROJECT_ID,
      managed_tasks: [],
      pr_bindings: [],
      ownership_leases: [],
      controller_leases: [],
      actions: [],
      overrides: [],
      controller_modes: [],
      delivery_events: [],
      policy_decisions: [],
      credential_provenances: [],
      task_specs: [],
      runtime_preflights: [],
      review_records: [],
    });
    expect(repository.listAuditEntries()).toEqual([]);
    expect(fs.existsSync(path.join(repoRoot, '.ao-control-plane'))).toBe(false);
  });

  it('writes and reads durable control-plane records for every foundation collection', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-29T04:50:00.000Z',
        '2026-03-29T04:51:00.000Z',
        '2026-03-29T04:52:00.000Z',
        '2026-03-29T04:53:00.000Z',
        '2026-03-29T04:54:00.000Z',
        '2026-03-29T04:55:00.000Z',
        '2026-03-29T04:56:00.000Z',
        '2026-03-29T04:57:00.000Z',
        '2026-03-29T04:58:00.000Z',
        '2026-03-29T04:59:00.000Z',
        '2026-03-29T05:00:00.000Z',
        '2026-03-29T05:01:00.000Z',
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
      created_at: '2026-03-29T04:50:00.000Z',
      updated_at: '2026-03-29T04:50:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: 'binding-1',
      task_id: 'task-1',
      pr_number: 101,
      branch_name: 'feat/88',
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-29T04:51:00.000Z',
      updated_at: '2026-03-29T04:51:00.000Z',
    }));
    repository.upsertOwnershipLease(createOwnershipLease({
      lease_id: 'ownership-1',
      task_id: 'task-1',
      owner_session_name: 'worker-48',
      owner_session_id: 'session-48',
      status: 'active',
      acquired_at: '2026-03-29T04:52:00.000Z',
      expires_at: '2026-03-29T05:12:00.000Z',
    }));
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-1',
      controller_id: 'default',
      holder_id: 'ao-orchestrator',
      holder_type: 'session',
      status: 'active',
      acquired_at: '2026-03-29T04:53:00.000Z',
      expires_at: '2026-03-29T05:13:00.000Z',
    }));
    repository.upsertAction(createActionRecord({
      action_id: 'action-1',
      task_id: 'task-1',
      action_kind: 'notify_human_ready',
      status: 'proposed',
      requested_by: 'lifecycle',
      reason: 'Release posture is ready for operator review.',
      created_at: '2026-03-29T04:54:00.000Z',
      updated_at: '2026-03-29T04:54:00.000Z',
      payload: { pr_number: 101 },
    }));
    repository.upsertOverride(createOverrideRecord({
      override_id: 'override-1',
      scope_kind: 'task',
      scope_id: 'task-1',
      override_kind: 'hold_autonomy',
      value: { enabled: true },
      status: 'active',
      created_at: '2026-03-29T04:55:00.000Z',
      expires_at: null,
      cleared_at: null,
      cleared_reason: null,
      created_by: 'operator',
    }));
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'observe',
      updated_at: '2026-03-29T04:56:00.000Z',
      updated_by: 'operator',
      reason: 'Phase-4 foundation is inspect-only.',
    }));
    repository.upsertTaskSpec(createTaskSpecRecord({
      task_id: 'task-1',
      source_kind: 'github_issue',
      source_issue_number: 88,
      created_at: '2026-03-29T04:57:00.000Z',
      updated_at: '2026-03-29T04:57:00.000Z',
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        valid: true,
        findings: [],
        spec: {
          problem_type: 'issue_delivery',
          acceptance_contract: ['fixture-backed tests exist'],
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          human_gates: ['operator_enroll'],
        },
      },
    }));
    repository.upsertDeliveryEvent(createDeliveryEventRecord({
      event_id: 'delivery-1',
      task_id: 'task-1',
      pr_number: 101,
      source_kind: 'github_poll',
      event_family: 'review_comment',
      event_type: 'review_comment_state',
      dedupe_key: 'github_poll:review_comment:101:review-1',
      lifecycle_trigger: 'bugbot_comments',
      controller_action_hint: 'hold_review',
      observed_at: '2026-03-29T04:58:00.000Z',
      recorded_at: '2026-03-29T04:58:00.000Z',
      lineage: {
        source_observation_id: 'obs-1',
        source_cursor: 'cursor-1',
      },
      payload: {
        head_sha: 'abc123',
        review_id: 'review-1',
      },
    }));
    repository.upsertCredentialProvenance(createCredentialProvenanceRecord({
      provenance_id: 'cred-gh-cli',
      credential_kind: 'github_token',
      source_kind: 'gh_cli_auth',
      scope: 'github.com',
      created_at: '2026-03-29T04:59:00.000Z',
      updated_at: '2026-03-29T04:59:00.000Z',
    }));
    repository.upsertPolicyDecision(createPolicyDecisionRecord({
      decision_id: 'policy-1',
      task_id: 'task-1',
      action_id: 'action-1',
      action_kind: 'notify_human_ready',
      subject_kind: 'action',
      decision: 'allow',
      policy_version: 'ao.policy.v1',
      input_fingerprint: 'fingerprint-1',
      recorded_at: '2026-03-29T05:00:00.000Z',
      summary: 'Allow low-risk GitHub inspection.',
      findings: [],
      input: {
        tools: ['gh'],
      },
      result: {
        decision: 'allow',
      },
    }));

    const snapshot = repository.getSnapshot();
    const auditEntries = repository.listAuditEntries();

    expect(snapshot.bootstrapped).toBe(true);
    expect(snapshot.state).toMatchObject({
      managed_tasks: [expect.objectContaining({ task_id: 'task-1', status: 'active' })],
      pr_bindings: [expect.objectContaining({ binding_id: 'binding-1', pr_number: 101 })],
      ownership_leases: [expect.objectContaining({ lease_id: 'ownership-1', status: 'active' })],
      controller_leases: [expect.objectContaining({ lease_id: 'controller-1', status: 'active' })],
      actions: [expect.objectContaining({ action_id: 'action-1', action_kind: 'notify_human_ready' })],
      overrides: [expect.objectContaining({ override_id: 'override-1', override_kind: 'hold_autonomy' })],
      controller_modes: [expect.objectContaining({ controller_id: 'default', mode: 'observe' })],
      delivery_events: [expect.objectContaining({ event_id: 'delivery-1', event_family: 'review_comment' })],
      credential_provenances: [expect.objectContaining({ provenance_id: 'cred-gh-cli', credential_kind: 'github_token' })],
      policy_decisions: [expect.objectContaining({ decision_id: 'policy-1', decision: 'allow' })],
      task_specs: [expect.objectContaining({ task_id: 'task-1', state: 'valid' })],
    });
    expect(auditEntries.map((entry) => `${entry.entity_kind}:${entry.operation}:${entry.entity_id}`)).toEqual([
      'schema:bootstrap:v1',
      'schema:migrate:v2',
      'schema:migrate:v3',
      'schema:migrate:v4',
      'schema:migrate:v5',
      'schema:migrate:v6',
      'schema:migrate:v7',
        'schema:migrate:v8',
        'schema:migrate:v9',
        'schema:migrate:v10',
        'schema:migrate:v11',
        'managed_task:upsert:task-1',
      'pr_binding:upsert:binding-1',
      'ownership_lease:upsert:ownership-1',
      'controller_lease:upsert:controller-1',
      'action:upsert:action-1',
      'override:upsert:override-1',
      'controller_mode:upsert:default',
      'task_spec:upsert:task-1',
      'delivery_event:upsert:delivery-1',
      'credential_provenance:upsert:cred-gh-cli',
      'policy_decision:upsert:policy-1',
    ]);
  });

  it('writes and reads durable review records with append-only audit history', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-04-03T14:20:00.000Z',
        '2026-04-03T14:21:00.000Z',
      ),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertReviewRecord(createReviewRecord({
      review_id: 'review-1',
      task_id: 'task-1',
      issue_number: 88,
      pr_number: 101,
      status: 'open',
      trigger_kind: 'ready_for_review',
      target_branch: 'feat/88',
      target_head_sha: 'abc123',
      requested_by_session_name: 'worker-48',
      requested_by_session_id: 'session-48',
      implementation_session_name: 'worker-48',
      implementation_session_id: 'session-48',
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
      freeze_status: 'active',
      created_at: '2026-04-03T14:20:00.000Z',
      updated_at: '2026-04-03T14:20:00.000Z',
    }));

    expect(repository.getSnapshot().state.review_records).toEqual([
      expect.objectContaining({
        review_id: 'review-1',
        task_id: 'task-1',
        status: 'open',
        target_head_sha: 'abc123',
      }),
    ]);
    expect(repository.listAuditEntries().at(-1)).toMatchObject({
      entity_kind: 'review_record',
      operation: 'upsert',
      entity_id: 'review-1',
    });
  });

  it('keeps state upserts idempotent while audit log writes remain append-only', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      clock: createClock(
        '2026-03-29T05:00:00.000Z',
        '2026-03-29T05:01:00.000Z',
        '2026-03-29T05:02:00.000Z',
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
      created_at: '2026-03-29T05:00:00.000Z',
      updated_at: '2026-03-29T05:00:00.000Z',
    }));
    const beforeAudit = repository.listAuditEntries();

    repository.upsertManagedTask(createManagedTask({
      task_id: 'task-1',
      issue_number: 88,
      title: 'Durable AO control-plane state',
      branch_name: 'feat/88',
      worktree_path: '/tmp/worker-48',
      status: 'paused',
      created_at: '2026-03-29T05:00:00.000Z',
      updated_at: '2026-03-29T05:02:00.000Z',
    }));
    const afterAudit = repository.listAuditEntries();

    expect(repository.getSnapshot().state.managed_tasks).toEqual([
      expect.objectContaining({
        task_id: 'task-1',
        status: 'paused',
        updated_at: '2026-03-29T05:02:00.000Z',
      }),
    ]);
    expect(afterAudit).toHaveLength(beforeAudit.length + 1);
    expect(afterAudit.slice(0, beforeAudit.length)).toEqual(beforeAudit);
    expect(afterAudit.at(-1)).toMatchObject({
      entity_kind: 'managed_task',
      operation: 'upsert',
      entity_id: 'task-1',
    });
  });

  it('persists controller runtime heartbeat fields for operator inspection', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
      clock: createClock('2026-03-29T06:00:00.000Z', '2026-03-29T06:01:00.000Z'),
      auditIdGenerator: createIdGenerator('audit'),
    });

    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-worker-62',
      controller_id: 'default',
      holder_id: 'worker-62',
      holder_type: 'session',
      status: 'active',
      acquired_at: '2026-03-29T06:00:00.000Z',
      heartbeat_at: '2026-03-29T06:00:30.000Z',
      expires_at: '2026-03-29T06:01:30.000Z',
      lease_timeout_ms: 90000,
      runtime_kind: 'continuous',
      poll_interval_ms: 15000,
      shutdown_timeout_ms: 5000,
      last_run_started_at: '2026-03-29T06:00:20.000Z',
      last_run_completed_at: '2026-03-29T06:00:25.000Z',
      last_run_status: 'completed',
    }));

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-worker-62',
        controller_id: 'default',
        holder_id: 'worker-62',
        status: 'active',
        heartbeat_at: '2026-03-29T06:00:30.000Z',
        expires_at: '2026-03-29T06:01:30.000Z',
        lease_timeout_ms: 90000,
        runtime_kind: 'continuous',
        poll_interval_ms: 15000,
        shutdown_timeout_ms: 5000,
        last_run_started_at: '2026-03-29T06:00:20.000Z',
        last_run_completed_at: '2026-03-29T06:00:25.000Z',
        last_run_status: 'completed',
      }),
    ]);
  });

  it('serializes controller lease acquisition so contenders cannot both win leadership', async () => {
    const repoRoot = createTempRepo();
    const repositoryA = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const repositoryB = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const releaseFirstWriter = createDeferred();

    const firstWriter = repositoryA.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-a',
      summary: 'Persisted controller lease controller-default-holder-a.',
      mutate: async ({ findActiveLeaseForController, upsertControllerLease }) => {
        expect(findActiveLeaseForController('default')).toBeNull();
        const lease = upsertControllerLease(createControllerLease({
          lease_id: 'controller-default-holder-a',
          controller_id: 'default',
          holder_id: 'holder-a',
          holder_type: 'session',
          status: 'active',
          acquired_at: '2026-03-29T06:00:00.000Z',
          heartbeat_at: '2026-03-29T06:00:00.000Z',
          expires_at: '2026-03-29T06:05:00.000Z',
          lease_timeout_ms: 300000,
          runtime_kind: 'continuous',
        }));
        await releaseFirstWriter.promise;
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const secondWriter = repositoryB.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-b',
      summary: 'Persisted controller lease controller-default-holder-b.',
      mutate: async ({ findActiveLeaseForController, upsertControllerLease }) => {
        const activeLease = findActiveLeaseForController('default');
        if (activeLease) {
          throw new Error(`Controller default already has an active lease held by ${activeLease.holder_id}.`);
        }
        const lease = upsertControllerLease(createControllerLease({
          lease_id: 'controller-default-holder-b',
          controller_id: 'default',
          holder_id: 'holder-b',
          holder_type: 'session',
          status: 'active',
          acquired_at: '2026-03-29T06:00:01.000Z',
          heartbeat_at: '2026-03-29T06:00:01.000Z',
          expires_at: '2026-03-29T06:05:01.000Z',
          lease_timeout_ms: 300000,
          runtime_kind: 'continuous',
        }));
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    });

    releaseFirstWriter.resolve();

    await expect(firstWriter).resolves.toEqual(expect.objectContaining({
      holder_id: 'holder-a',
      status: 'active',
    }));
    await expect(secondWriter).rejects.toThrow(/active lease held by holder-a/i);
    expect(repositoryA.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-holder-a',
        holder_id: 'holder-a',
        status: 'active',
      }),
    ]);
  });

  it('preserves the latest controller lease heartbeat when a stale ordinary state write lands afterward', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });

    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-holder-a-incarnation-a',
      controller_id: 'default',
      holder_id: 'holder-a',
      holder_type: 'session',
      incarnation_id: 'incarnation-a',
      status: 'active',
      acquired_at: '2026-03-29T06:00:00.000Z',
      heartbeat_at: '2026-03-29T06:00:00.000Z',
      expires_at: '2026-03-29T06:05:00.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
    }));

    const staleState = repository.getSnapshot().state;

    await repository.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-a-incarnation-a',
      summary: 'Renew controller lease heartbeat.',
      mutate: async ({ findControllerLeaseById, upsertControllerLease }) => {
        const lease = upsertControllerLease(createControllerLease({
          ...findControllerLeaseById('controller-default-holder-a-incarnation-a'),
          heartbeat_at: '2026-03-29T06:02:00.000Z',
          expires_at: '2026-03-29T06:07:00.000Z',
          last_run_status: 'running',
        }));
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    });

    const staleNextState = JSON.parse(JSON.stringify(staleState));
    staleNextState.managed_tasks.push(createManagedTask({
      task_id: 'task-1',
      issue_number: 125,
      title: 'controller stale snapshot write',
      branch_name: 'feat/125',
      worktree_path: '/tmp/worker-62',
      status: 'active',
      created_at: '2026-03-29T06:03:00.000Z',
      updated_at: '2026-03-29T06:03:00.000Z',
    }));
    writeJsonFileAtomic(repository.getSnapshot().paths.statePath, staleNextState);

    const snapshot = repository.getSnapshot().state;
    expect(snapshot.managed_tasks).toEqual([
      expect.objectContaining({
        task_id: 'task-1',
      }),
    ]);
    expect(snapshot.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-holder-a-incarnation-a',
        incarnation_id: 'incarnation-a',
        heartbeat_at: '2026-03-29T06:02:00.000Z',
        expires_at: '2026-03-29T06:07:00.000Z',
      }),
    ]);
  });
  it('recovers an orphaned controller lease lock before mutating controller leadership', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const snapshot = repository.getSnapshot();
    const lockPath = `${snapshot.paths.controllerLeasesPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 999999,
      acquired_at: '2026-03-29T05:00:00.000Z',
    })}\n`, 'utf8');

    await expect(repository.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-a-incarnation-a',
      summary: 'Recover stale controller lease lock.',
      mutate: async ({ upsertControllerLease }) => {
        const lease = upsertControllerLease(createControllerLease({
          lease_id: 'controller-default-holder-a-incarnation-a',
          controller_id: 'default',
          holder_id: 'holder-a',
          holder_type: 'session',
          incarnation_id: 'incarnation-a',
          status: 'active',
          acquired_at: '2026-03-29T06:00:00.000Z',
          heartbeat_at: '2026-03-29T06:00:00.000Z',
          expires_at: '2026-03-29T06:05:00.000Z',
          lease_timeout_ms: 300000,
          runtime_kind: 'continuous',
        }));
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    })).resolves.toEqual(expect.objectContaining({
      lease_id: 'controller-default-holder-a-incarnation-a',
      status: 'active',
    }));

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-holder-a-incarnation-a',
        status: 'active',
      }),
    ]);
  });

  it('does not delete a newly replaced live lock while recovering a stale controller lease lock', async () => {
    const repoRoot = createTempRepo();
    const lockPath = path.join(repoRoot, 'controller-leases.json.lock');
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: 999999,
      acquired_at: '2026-03-29T05:00:00.000Z',
    })}\n`, 'utf8');

    const liveLockMetadata = {
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      ...buildCurrentProcessMetadata({
        startedAt: new Date().toISOString(),
      }),
    };

    await expect(withFileLock(lockPath, async () => 'acquired', {
      timeoutMs: 40,
      retryMs: 5,
      beforeStaleLockUnlink: () => {
        fs.writeFileSync(lockPath, `${JSON.stringify(liveLockMetadata)}\n`, 'utf8');
      },
    })).rejects.toThrow(/Timed out acquiring file lock/i);

    expect(JSON.parse(fs.readFileSync(lockPath, 'utf8'))).toEqual(liveLockMetadata);
  });

  it('recovers a legacy tokenless controller lease lock after stale age even when the pid is still live', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const snapshot = repository.getSnapshot();
    const lockPath = `${snapshot.paths.controllerLeasesPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      acquired_at: '2026-03-29T05:00:00.000Z',
    })}\n`, 'utf8');

    await expect(repository.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-a-incarnation-a',
      summary: 'Recover legacy tokenless controller lease lock.',
      timeoutMs: 60,
      retryMs: 5,
      mutate: async ({ upsertControllerLease }) => {
        const lease = upsertControllerLease(createControllerLease({
          lease_id: 'controller-default-holder-a-incarnation-a',
          controller_id: 'default',
          holder_id: 'holder-a',
          holder_type: 'session',
          incarnation_id: 'incarnation-a',
          status: 'active',
          acquired_at: '2026-03-29T06:00:00.000Z',
          heartbeat_at: '2026-03-29T06:00:00.000Z',
          expires_at: '2026-03-29T06:05:00.000Z',
          lease_timeout_ms: 300000,
          runtime_kind: 'continuous',
        }));
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    })).resolves.toEqual(expect.objectContaining({
      lease_id: 'controller-default-holder-a-incarnation-a',
      status: 'active',
    }));

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('recovers a pid-reused controller lease lock when the recorded process identity token mismatches', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    const snapshot = repository.getSnapshot();
    const lockPath = `${snapshot.paths.controllerLeasesPath}.lock`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${JSON.stringify({
      pid: process.pid,
      process_started_at: '2026-03-29T05:00:00.000Z',
      process_start_token: 'stale-process-token',
      acquired_at: '2026-03-29T05:00:00.000Z',
    })}\n`, 'utf8');

    await expect(repository.mutateControllerLeasesAtomically({
      entityId: 'controller-default-holder-a-incarnation-a',
      summary: 'Recover pid-reused controller lease lock.',
      mutate: async ({ upsertControllerLease }) => {
        const lease = upsertControllerLease(createControllerLease({
          lease_id: 'controller-default-holder-a-incarnation-a',
          controller_id: 'default',
          holder_id: 'holder-a',
          holder_type: 'session',
          incarnation_id: 'incarnation-a',
          status: 'active',
          acquired_at: '2026-03-29T06:00:00.000Z',
          heartbeat_at: '2026-03-29T06:00:00.000Z',
          expires_at: '2026-03-29T06:05:00.000Z',
          lease_timeout_ms: 300000,
          runtime_kind: 'continuous',
        }));
        return {
          value: lease,
          entityId: lease.lease_id,
          summary: `Persisted controller lease ${lease.lease_id}.`,
          details: lease,
        };
      },
    })).resolves.toEqual(expect.objectContaining({
      lease_id: 'controller-default-holder-a-incarnation-a',
      status: 'active',
    }));

    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
