import { deriveReviewPosture } from './review-contracts.js';
import { createReviewRecord } from './state-contracts.js';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function sanitizeToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_');
}

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function sortByUpdatedAtDescending(items = []) {
  return [...items].sort((left, right) => {
    const byTimestamp = compareIsoDescending(left?.updated_at, right?.updated_at);
    if (byTimestamp !== 0) return byTimestamp;
    return String(right?.review_id ?? '').localeCompare(String(left?.review_id ?? ''));
  });
}

function resolveTask(snapshot, {
  taskId = null,
  issueNumber = null,
} = {}) {
  const normalizedIssueNumber = issueNumber == null ? null : Number(issueNumber);
  return (snapshot?.state?.managed_tasks ?? []).find((task) => (
    (taskId && task?.task_id === taskId)
      || (normalizedIssueNumber != null && task?.issue_number === normalizedIssueNumber)
  )) ?? null;
}

function resolveActivePrBinding(snapshot, taskId) {
  return (snapshot?.state?.pr_bindings ?? []).find((binding) => (
    binding?.task_id === taskId && binding?.status === 'bound'
  )) ?? null;
}

function resolveLatestReviewForTask(snapshot, taskId) {
  return sortByUpdatedAtDescending(
    (snapshot?.state?.review_records ?? []).filter((record) => record?.task_id === taskId),
  )[0] ?? null;
}

function buildReviewId(snapshot, taskId, timestamp) {
  const count = (snapshot?.state?.review_records ?? []).filter((record) => record?.task_id === taskId).length + 1;
  return `review-${sanitizeToken(taskId)}-${sanitizeToken(timestamp)}-${count}`;
}

function assertTaskExists(snapshot, identity) {
  const task = resolveTask(snapshot, identity);
  if (!task) {
    throw new Error(`Missing managed task for ${identity.taskId ?? identity.issueNumber}`);
  }
  return task;
}

function assertNoActiveReview(snapshot, taskId) {
  const activeReview = (snapshot?.state?.review_records ?? []).find((record) => (
    record?.task_id === taskId && ['open', 'claimed'].includes(record?.status)
  ));
  if (activeReview) {
    throw new Error(`Active review already exists for ${taskId}`);
  }
}

function resolveReviewOrThrow(snapshot, {
  reviewId = null,
  taskId = null,
  issueNumber = null,
} = {}) {
  if (reviewId) {
    const review = (snapshot?.state?.review_records ?? []).find((record) => record?.review_id === reviewId) ?? null;
    if (!review) {
      throw new Error('Missing review record');
    }
    return review;
  }

  const task = assertTaskExists(snapshot, { taskId, issueNumber });
  const review = resolveLatestReviewForTask(snapshot, task.task_id);
  if (!review) {
    throw new Error(`Missing review record for ${task.task_id}`);
  }
  return review;
}

function createUpdatedReviewRecord(existingReview, overrides) {
  return createReviewRecord({
    ...existingReview,
    ...overrides,
  });
}

export function createReviewProtocol({
  repository,
  now = () => new Date().toISOString(),
} = {}) {
  function resolveSnapshot() {
    return repository.getSnapshot();
  }

  return {
    requestReview({
      taskId = null,
      issueNumber = null,
      requestedBySessionName,
      requestedBySessionId = null,
      implementationSessionName,
      implementationSessionId = null,
      targetHeadSha,
      verificationBaseline,
      targetBranch = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const task = assertTaskExists(snapshot, { taskId, issueNumber });
      assertNoActiveReview(snapshot, task.task_id);
      const activeBinding = resolveActivePrBinding(snapshot, task.task_id);

      const review = createReviewRecord({
        review_id: buildReviewId(snapshot, task.task_id, timestamp),
        task_id: task.task_id,
        issue_number: task.issue_number ?? null,
        pr_number: activeBinding?.pr_number ?? null,
        status: 'open',
        trigger_kind: 'ready_for_review',
        target_branch: targetBranch ?? task.branch_name,
        target_head_sha: targetHeadSha,
        requested_by_session_name: requestedBySessionName,
        requested_by_session_id: requestedBySessionId,
        implementation_session_name: implementationSessionName,
        implementation_session_id: implementationSessionId,
        verification_baseline: verificationBaseline,
        findings_summary: [],
        verdict: null,
        baseline_execution: null,
        freeze_status: 'active',
        created_at: timestamp,
        updated_at: timestamp,
      });

      return repository.upsertReviewRecord(review);
    },

    claimReview({
      reviewId = null,
      taskId = null,
      issueNumber = null,
      reviewerSessionName,
      reviewerSessionId = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const review = resolveReviewOrThrow(snapshot, {
        reviewId,
        taskId,
        issueNumber,
      });

      if (review.implementation_session_name === reviewerSessionName) {
        throw new Error('Independent reviewer session required.');
      }
      if (!['open', 'claimed'].includes(review.status)) {
        throw new Error(`Review ${review.review_id} is not claimable.`);
      }

      return repository.upsertReviewRecord(createUpdatedReviewRecord(review, {
        status: 'claimed',
        reviewer_session_name: reviewerSessionName,
        reviewer_session_id: reviewerSessionId,
        updated_at: timestamp,
      }));
    },

    recordVerdict({
      reviewId = null,
      taskId = null,
      issueNumber = null,
      verdict,
      findingsSummary = [],
      baselineExecution = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const review = resolveReviewOrThrow(snapshot, {
        reviewId,
        taskId,
        issueNumber,
      });

      if (!['claimed', 'open'].includes(review.status)) {
        throw new Error(`Review ${review.review_id} is not active.`);
      }
      if (verdict === 'pass' && baselineExecution == null) {
        throw new Error('Pass verdict requires baseline execution evidence.');
      }

      const nextStatus = verdict === 'pass'
        ? 'passed'
        : verdict === 'changes_required'
          ? 'changes_required'
          : 'escalated';
      const freezeStatus = verdict === 'escalate_human' ? 'active' : 'released';

      return repository.upsertReviewRecord(createUpdatedReviewRecord(review, {
        status: nextStatus,
        verdict,
        findings_summary: findingsSummary,
        baseline_execution: baselineExecution,
        freeze_status: freezeStatus,
        updated_at: timestamp,
      }));
    },

    cancelIfTargetDrifted({
      taskId = null,
      issueNumber = null,
      targetHeadSha,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const review = resolveReviewOrThrow(snapshot, {
        taskId,
        issueNumber,
      });

      if (review.target_head_sha === targetHeadSha || !['open', 'claimed'].includes(review.status)) {
        return review;
      }

      return repository.upsertReviewRecord(createUpdatedReviewRecord(review, {
        status: 'cancelled',
        freeze_status: 'released',
        updated_at: timestamp,
      }));
    },

    inspectTaskReview({
      taskId = null,
      issueNumber = null,
      reviewId = null,
    } = {}) {
      const snapshot = resolveSnapshot();
      const review = resolveReviewOrThrow(snapshot, {
        reviewId,
        taskId,
        issueNumber,
      });
      const posture = deriveReviewPosture(review);

      return {
        task_id: review.task_id,
        review_id: review.review_id,
        status: review.status,
        verdict: review.verdict,
        reviewer_session_name: review.reviewer_session_name,
        target_head_sha: review.target_head_sha,
        freeze_status: review.freeze_status,
        posture: posture.posture,
        freeze_active: posture.freeze_active,
      };
    },
  };
}
