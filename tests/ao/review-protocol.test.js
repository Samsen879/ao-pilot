import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createReviewProtocol } from '../../scripts/ao/lib/review-protocol.js';
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-review-protocol-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function seedReviewTask(repository, {
  taskId = 'issue-125',
  issueNumber = 125,
  title = 'feat(ao): add independent reviewer gate',
  ownerSessionName = 'worker-125-impl',
  ownerSessionId = 'session-125-impl',
  branchName = 'task/125-reviewer-gate',
  prNumber = 225,
} = {}) {
  repository.upsertManagedTask(createManagedTask({
    task_id: taskId,
    issue_number: issueNumber,
    title,
    branch_name: branchName,
    worktree_path: `/tmp/${ownerSessionName}`,
    status: 'active',
    created_at: '2026-04-03T14:30:00.000Z',
    updated_at: '2026-04-03T14:30:00.000Z',
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: `binding-${taskId}-pr-${prNumber}`,
    task_id: taskId,
    pr_number: prNumber,
    branch_name: branchName,
    base_branch: 'main',
    status: 'bound',
    created_at: '2026-04-03T14:30:00.000Z',
    updated_at: '2026-04-03T14:30:00.000Z',
  }));
  repository.upsertOwnershipLease(createOwnershipLease({
    lease_id: `ownership-${taskId}-${ownerSessionName}`,
    task_id: taskId,
    owner_session_name: ownerSessionName,
    owner_session_id: ownerSessionId,
    status: 'active',
    acquired_at: '2026-04-03T14:30:00.000Z',
    expires_at: '2026-04-03T14:50:00.000Z',
  }));
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
    created_at: '2026-04-03T14:30:00.000Z',
    updated_at: '2026-04-03T14:30:00.000Z',
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['independent review gate exists'],
        runtime_ref: 'runtime.github_local',
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_review'],
      },
    },
  }));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao review protocol', () => {
  it('creates one active review request per task with a required baseline and derived pending posture', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedReviewTask(repository);

    const protocol = createReviewProtocol({
      repository,
      now: () => '2026-04-03T14:35:00.000Z',
    });

    expect(() => protocol.requestReview({
      taskId: 'issue-125',
      requestedBySessionName: 'worker-125-impl',
      requestedBySessionId: 'session-125-impl',
      implementationSessionName: 'worker-125-impl',
      implementationSessionId: 'session-125-impl',
      targetHeadSha: 'abc123',
      verificationBaseline: [],
    })).toThrow(/verification_baseline/i);

    const review = protocol.requestReview({
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
      task_id: 'issue-125',
      status: 'open',
      target_head_sha: 'abc123',
      freeze_status: 'active',
    });
    expect(protocol.inspectTaskReview({
      taskId: 'issue-125',
    })).toMatchObject({
      task_id: 'issue-125',
      posture: 'review_pending',
      freeze_active: true,
      status: 'open',
    });

    expect(() => protocol.requestReview({
      taskId: 'issue-125',
      requestedBySessionName: 'worker-125-impl',
      requestedBySessionId: 'session-125-impl',
      implementationSessionName: 'worker-125-impl',
      implementationSessionId: 'session-125-impl',
      targetHeadSha: 'abc124',
      verificationBaseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
    })).toThrow(/active review/i);
  });

  it('fails closed on same-session reviewer claims and requires baseline execution evidence for pass', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedReviewTask(repository);

    const protocol = createReviewProtocol({
      repository,
      now: () => '2026-04-03T14:40:00.000Z',
    });
    const review = protocol.requestReview({
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
        {
          category: 'control_plane_sanity',
          commands: ['node scripts/ao-state.js --json'],
        },
      ],
    });

    expect(() => protocol.claimReview({
      reviewId: review.review_id,
      reviewerSessionName: 'worker-125-impl',
      reviewerSessionId: 'session-125-impl',
    })).toThrow(/independent reviewer/i);

    const claim = protocol.claimReview({
      reviewId: review.review_id,
      reviewerSessionName: 'worker-125-review',
      reviewerSessionId: 'session-125-review',
    });
    expect(claim).toMatchObject({
      review_id: review.review_id,
      status: 'claimed',
      reviewer_session_name: 'worker-125-review',
    });

    expect(() => protocol.recordVerdict({
      reviewId: review.review_id,
      verdict: 'pass',
      findingsSummary: [],
      baselineExecution: null,
    })).toThrow(/baseline execution/i);

    const verdict = protocol.recordVerdict({
      reviewId: review.review_id,
      verdict: 'pass',
      findingsSummary: [],
      baselineExecution: {
        status: 'attested',
        summary: 'Required baseline commands were executed by the reviewer.',
        recorded_at: '2026-04-03T14:41:00.000Z',
        attested_by_session_name: 'worker-125-review',
        attested_by_session_id: 'session-125-review',
        commands_run: ['git status --short', 'node scripts/ao-state.js --json'],
      },
    });
    expect(verdict).toMatchObject({
      status: 'passed',
      verdict: 'pass',
      freeze_status: 'released',
    });
    expect(protocol.inspectTaskReview({
      taskId: 'issue-125',
    })).toMatchObject({
      posture: 'review_passed',
      freeze_active: false,
      verdict: 'pass',
    });
  });

  it('cancels stale review records when the target SHA drifts and returns changes_required posture', () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedReviewTask(repository);

    const protocol = createReviewProtocol({
      repository,
      now: () => '2026-04-03T14:45:00.000Z',
    });
    const review = protocol.requestReview({
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

    const cancelled = protocol.cancelIfTargetDrifted({
      taskId: 'issue-125',
      targetHeadSha: 'abc999',
    });
    expect(cancelled).toMatchObject({
      review_id: review.review_id,
      status: 'cancelled',
      target_head_sha: 'abc123',
    });

    const newReview = protocol.requestReview({
      taskId: 'issue-125',
      requestedBySessionName: 'worker-125-impl',
      requestedBySessionId: 'session-125-impl',
      implementationSessionName: 'worker-125-impl',
      implementationSessionId: 'session-125-impl',
      targetHeadSha: 'abc999',
      verificationBaseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
    });
    const claimed = protocol.claimReview({
      reviewId: newReview.review_id,
      reviewerSessionName: 'worker-125-review',
      reviewerSessionId: 'session-125-review',
    });
    const returned = protocol.recordVerdict({
      reviewId: claimed.review_id,
      verdict: 'changes_required',
      findingsSummary: ['missing regression coverage'],
      baselineExecution: {
        status: 'attested',
        summary: 'Reviewer executed the required baseline.',
        recorded_at: '2026-04-03T14:46:00.000Z',
        attested_by_session_name: 'worker-125-review',
        attested_by_session_id: 'session-125-review',
        commands_run: ['git status --short'],
      },
    });

    expect(returned).toMatchObject({
      status: 'changes_required',
      verdict: 'changes_required',
      freeze_status: 'released',
    });
    expect(protocol.inspectTaskReview({
      taskId: 'issue-125',
    })).toMatchObject({
      posture: 'review_changes_required',
      freeze_active: false,
      verdict: 'changes_required',
    });
  });
});
