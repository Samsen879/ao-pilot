import { deriveReviewPosture } from '../review-contracts.js';
import { compareIsoDescending } from './time.js';

export function latestTaskReviewRecord(snapshot, taskId) {
  return [...(snapshot?.state?.review_records ?? [])]
    .filter((record) => record?.task_id === taskId)
    .sort((left, right) => {
      const byTimestamp = compareIsoDescending(left?.updated_at, right?.updated_at);
      if (byTimestamp !== 0) return byTimestamp;
      return String(right?.review_id ?? '').localeCompare(String(left?.review_id ?? ''));
    })[0] ?? null;
}

export function buildTaskReviewInspection(snapshot, taskId) {
  const reviewRecord = latestTaskReviewRecord(snapshot, taskId);
  if (!reviewRecord) return null;

  const posture = deriveReviewPosture(reviewRecord);
  return {
    review_id: reviewRecord.review_id,
    task_id: reviewRecord.task_id,
    issue_number: reviewRecord.issue_number ?? null,
    implementation_session_name: reviewRecord.implementation_session_name ?? null,
    reviewer_session_name: reviewRecord.reviewer_session_name ?? null,
    target_branch: reviewRecord.target_branch ?? null,
    target_head_sha: reviewRecord.target_head_sha ?? null,
    status: reviewRecord.status,
    verdict: reviewRecord.verdict,
    freeze_status: reviewRecord.freeze_status,
    posture: posture.posture,
    freeze_active: posture.freeze_active,
  };
}

export function resolveCurrentHeadSha(githubObservation, prNumber) {
  if (!Number.isInteger(Number(prNumber))) return null;
  return (githubObservation?.prs ?? []).find((pr) => pr?.pr_number === Number(prNumber))?.head_sha ?? null;
}
