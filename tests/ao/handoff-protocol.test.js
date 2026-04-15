import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createCheckpointStore } from '../../scripts/ao/lib/checkpoint-store.js';
import { createHandoffProtocol } from '../../scripts/ao/lib/handoff-protocol.js';
import {
  createManagedTask,
  createOwnershipLease,
  createPrBinding,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-handoff-protocol-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function seedHandoffTask(repository, {
  taskId = 'issue-117',
  issueNumber = 117,
  title = 'feat(ao): add successor handoff and authority transfer protocol',
  ownerSessionName = 'worker-58',
  ownerSessionId = 'worker-58',
} = {}) {
  repository.upsertManagedTask(createManagedTask({
    task_id: taskId,
    issue_number: issueNumber,
    title,
    branch_name: 'feat/117',
    worktree_path: '/tmp/worker-58',
    status: 'active',
    created_at: '2026-03-31T10:00:00.000Z',
    updated_at: '2026-03-31T10:00:00.000Z',
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: `binding-${taskId}-pr-${issueNumber}`,
    task_id: taskId,
    pr_number: issueNumber,
    branch_name: 'feat/117',
    base_branch: 'main',
    status: 'bound',
    created_at: '2026-03-31T10:00:00.000Z',
    updated_at: '2026-03-31T10:00:00.000Z',
  }));
  repository.upsertOwnershipLease(createOwnershipLease({
    lease_id: `ownership-${taskId}-${ownerSessionName}`,
    task_id: taskId,
    owner_session_name: ownerSessionName,
    owner_session_id: ownerSessionId,
    status: 'active',
    acquired_at: '2026-03-31T10:00:00.000Z',
    expires_at: '2026-03-31T10:20:00.000Z',
  }));
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
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
    cwd: repository.getSnapshot().paths.repoRoot,
    now: '2026-03-31T10:01:00.000Z',
    probes: {
      commandExists: () => true,
      pathExists: () => true,
      capability: () => true,
    },
  });

  const checkpoint = createCheckpointStore({
    repository,
    now: () => '2026-03-31T10:15:00.000Z',
  }).captureCheckpoint({
    taskId,
    controllerId: 'default',
    derivedTrigger: 'agent_exited',
    observedAt: '2026-03-31T10:15:00.000Z',
    actionIds: ['proposal-handoff'],
  });

  return {
    checkpoint,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao handoff protocol', () => {
  it('creates a durable handoff request with checkpoint and lease lineage', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    const { checkpoint } = seedHandoffTask(repository);

    const protocol = createHandoffProtocol({
      repository,
      now: () => '2026-03-31T10:30:00.000Z',
    });
    const request = protocol.requestHandoff({
      taskId: 'issue-117',
      requestedBySessionName: 'operator-1',
      requestedBySessionId: 'operator-1',
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'owner_stale',
    });

    expect(request).toMatchObject({
      task_id: 'issue-117',
      status: 'open',
      operator_session_name: 'operator-1',
      successor_session_name: 'worker-59',
      lineage: expect.objectContaining({
        checkpoint_id: checkpoint.checkpoint_id,
        checkpoint_state: 'valid',
        prior_ownership_lease_id: 'ownership-issue-117-worker-58',
        prior_owner_session_name: 'worker-58',
      }),
    });
    expect(repository.getSnapshot().state.handoff_requests).toEqual([
      expect.objectContaining({
        request_id: request.request_id,
        status: 'open',
      }),
    ]);
  });

  it('blocks unauthorized and duplicate claims and human-gates competing successors', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedHandoffTask(repository);

    const protocol = createHandoffProtocol({
      repository,
      now: () => '2026-03-31T10:30:00.000Z',
    });
    const explicitRequest = protocol.requestHandoff({
      taskId: 'issue-117',
      requestedBySessionName: 'operator-1',
      requestedBySessionId: 'operator-1',
      operatorSessionName: 'operator-1',
      operatorSessionId: 'operator-1',
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'owner_stale',
    });
    const unauthorizedClaim = protocol.claimHandoff({
      requestId: explicitRequest.request_id,
      successorSessionName: 'worker-60',
      successorSessionId: 'worker-60',
      reason: 'takeover_attempt',
    });

    expect(unauthorizedClaim).toMatchObject({
      request_id: explicitRequest.request_id,
      status: 'blocked',
      successor_session_name: 'worker-60',
      reason_codes: expect.arrayContaining(['successor_not_authorized']),
    });

    const openRequest = protocol.requestHandoff({
      taskId: 'issue-117',
      requestedBySessionName: 'operator-2',
      requestedBySessionId: 'operator-2',
      operatorSessionName: 'operator-2',
      operatorSessionId: 'operator-2',
      successorSessionName: null,
      successorSessionId: null,
      reason: 'open_successor_selection',
      allowDuplicateTaskRequest: true,
    });
    const firstClaim = protocol.claimHandoff({
      requestId: openRequest.request_id,
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'ready_to_continue',
    });
    const duplicateClaim = protocol.claimHandoff({
      requestId: openRequest.request_id,
      successorSessionName: 'worker-59',
      successorSessionId: 'worker-59',
      reason: 'duplicate_submission',
    });
    const competingClaim = protocol.claimHandoff({
      requestId: openRequest.request_id,
      successorSessionName: 'worker-60',
      successorSessionId: 'worker-60',
      reason: 'alternate_successor',
    });
    const inspection = protocol.inspectTaskHandoff({
      taskId: 'issue-117',
      requestId: openRequest.request_id,
    });

    expect(firstClaim).toMatchObject({
      status: 'pending',
      successor_session_name: 'worker-59',
    });
    expect(duplicateClaim).toMatchObject({
      status: 'blocked',
      reason_codes: expect.arrayContaining(['duplicate_successor_claim']),
    });
    expect(competingClaim).toMatchObject({
      status: 'pending',
      successor_session_name: 'worker-60',
    });
    expect(inspection).toMatchObject({
      task_id: 'issue-117',
      request_id: openRequest.request_id,
      top_status: 'ambiguous',
      reason_codes: expect.arrayContaining(['ambiguous_successor_selection']),
    });
  });
});
