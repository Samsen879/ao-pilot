import {
  REVIEW_BASELINE_CATEGORIES,
  REVIEW_RECORD_STATUSES,
  REVIEW_VERDICTS,
} from './state-contracts.js';

export const REVIEW_POSTURES = [
  'idle',
  'review_pending',
  'review_changes_required',
  'review_passed',
  'review_escalated',
];

export {
  REVIEW_BASELINE_CATEGORIES,
  REVIEW_RECORD_STATUSES,
  REVIEW_VERDICTS,
};

export function deriveReviewPosture(reviewRecord) {
  const status = reviewRecord?.status ?? null;

  if (status == null || status === 'cancelled') {
    return {
      posture: 'idle',
      freeze_active: false,
    };
  }

  if (status === 'open' || status === 'claimed') {
    return {
      posture: 'review_pending',
      freeze_active: true,
    };
  }

  if (status === 'changes_required') {
    return {
      posture: 'review_changes_required',
      freeze_active: false,
    };
  }

  if (status === 'passed') {
    return {
      posture: 'review_passed',
      freeze_active: false,
    };
  }

  if (status === 'escalated') {
    return {
      posture: 'review_escalated',
      freeze_active: true,
    };
  }

  return {
    posture: 'idle',
    freeze_active: false,
  };
}
