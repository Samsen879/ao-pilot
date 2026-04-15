import { describe, expect, it } from '@jest/globals';

import { createReviewRecord } from '../../scripts/ao/lib/state-contracts.js';
import {
  REVIEW_BASELINE_CATEGORIES,
  REVIEW_POSTURES,
  REVIEW_RECORD_STATUSES,
  REVIEW_VERDICTS,
  deriveReviewPosture,
} from '../../scripts/ao/lib/review-contracts.js';

const NOW = '2026-04-03T14:10:00.000Z';

describe('ao review contracts', () => {
  it('exports the first-release review enums and posture vocabulary', () => {
    expect(REVIEW_RECORD_STATUSES).toEqual([
      'open',
      'claimed',
      'passed',
      'changes_required',
      'escalated',
      'cancelled',
    ]);
    expect(REVIEW_VERDICTS).toEqual([
      'pass',
      'changes_required',
      'escalate_human',
    ]);
    expect(REVIEW_POSTURES).toEqual([
      'idle',
      'review_pending',
      'review_changes_required',
      'review_passed',
      'review_escalated',
    ]);
    expect(REVIEW_BASELINE_CATEGORIES).toEqual([
      'workspace_sanity',
      'control_plane_sanity',
      'scoped_verification',
      'pr_readonly',
    ]);
  });

  it('creates a durable review record with a structured verification baseline', () => {
    expect(createReviewRecord({
      review_id: 'review-1',
      task_id: 'issue-125',
      issue_number: 125,
      pr_number: 402,
      status: 'open',
      trigger_kind: 'ready_for_review',
      target_branch: 'task/125-reviewer-gate',
      target_head_sha: 'abc123def456',
      requested_by_session_name: 'worker-125-impl',
      requested_by_session_id: 'session-125-impl',
      implementation_session_name: 'worker-125-impl',
      implementation_session_id: 'session-125-impl',
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
        {
          category: 'control_plane_sanity',
          commands: ['node scripts/ao-state.js --json'],
        },
        {
          category: 'scoped_verification',
          commands: ['npm test -- --runInBand tests/ao/review-protocol.test.js'],
        },
        {
          category: 'pr_readonly',
          commands: ['gh pr view 402 --json reviewDecision,url'],
        },
      ],
      findings_summary: [],
      verdict: null,
      baseline_execution: null,
      freeze_status: 'active',
      created_at: NOW,
      updated_at: NOW,
    })).toEqual({
      schema_version: 'ao.review-record.v1alpha1',
      format: 'ao_review_record',
      review_id: 'review-1',
      task_id: 'issue-125',
      issue_number: 125,
      pr_number: 402,
      status: 'open',
      trigger_kind: 'ready_for_review',
      target_branch: 'task/125-reviewer-gate',
      target_head_sha: 'abc123def456',
      requested_by_session_name: 'worker-125-impl',
      requested_by_session_id: 'session-125-impl',
      implementation_session_name: 'worker-125-impl',
      implementation_session_id: 'session-125-impl',
      reviewer_session_name: null,
      reviewer_session_id: null,
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
        {
          category: 'control_plane_sanity',
          commands: ['node scripts/ao-state.js --json'],
        },
        {
          category: 'scoped_verification',
          commands: ['npm test -- --runInBand tests/ao/review-protocol.test.js'],
        },
        {
          category: 'pr_readonly',
          commands: ['gh pr view 402 --json reviewDecision,url'],
        },
      ],
      findings_summary: [],
      verdict: null,
      baseline_execution: null,
      freeze_status: 'active',
      created_at: NOW,
      updated_at: NOW,
      metadata: {},
    });
  });

  it('derives task review posture from the latest review record status', () => {
    expect(deriveReviewPosture(null)).toEqual({
      posture: 'idle',
      freeze_active: false,
    });

    expect(deriveReviewPosture({
      status: 'open',
      reviewer_session_name: null,
      verdict: null,
    })).toEqual({
      posture: 'review_pending',
      freeze_active: true,
    });

    expect(deriveReviewPosture({
      status: 'claimed',
      reviewer_session_name: 'worker-125-review',
      verdict: null,
    })).toEqual({
      posture: 'review_pending',
      freeze_active: true,
    });

    expect(deriveReviewPosture({
      status: 'changes_required',
      reviewer_session_name: 'worker-125-review',
      verdict: 'changes_required',
    })).toEqual({
      posture: 'review_changes_required',
      freeze_active: false,
    });

    expect(deriveReviewPosture({
      status: 'passed',
      reviewer_session_name: 'worker-125-review',
      verdict: 'pass',
    })).toEqual({
      posture: 'review_passed',
      freeze_active: false,
    });

    expect(deriveReviewPosture({
      status: 'escalated',
      reviewer_session_name: 'worker-125-review',
      verdict: 'escalate_human',
    })).toEqual({
      posture: 'review_escalated',
      freeze_active: true,
    });
  });
});
