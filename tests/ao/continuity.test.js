import { describe, expect, it } from '@jest/globals';

import {
  buildTaskContinuityReport,
  summarizeContinuityReports,
} from '../../scripts/ao/lib/continuity.js';

function createTask(overrides = {}) {
  return {
    task_id: 'issue-117',
    issue_number: 117,
    status: 'active',
    ...overrides,
  };
}

describe('continuity report builder', () => {
  it('maps clear ownership into an active-owner posture', () => {
    const report = buildTaskContinuityReport({
      task: createTask(),
      prBinding: { pr_number: 127 },
      reconciliationReport: {
        pr_assessments: [
          {
            pr_number: 127,
            ownership: {
              status: 'clear',
              owner_session: 'worker-58',
            },
          },
        ],
      },
    });

    expect(report).toMatchObject({
      posture: 'active_owner',
      recommended_action: 'continue_current_worker',
      owner_session_name: 'worker-58',
      reason_codes: ['ownership_clear'],
    });
  });

  it('maps stale ownership and a valid checkpoint into restore-ready posture', () => {
    const report = buildTaskContinuityReport({
      task: createTask(),
      prBinding: { pr_number: 127 },
      ownershipLeases: [
        {
          lease_id: 'ownership-issue-117-worker-58',
          task_id: 'issue-117',
          owner_session_name: 'worker-58',
          status: 'released',
          acquired_at: '2026-03-31T10:00:00.000Z',
        },
      ],
      checkpointInspection: {
        checkpoint_id: 'checkpoint-issue-117-abc',
        task_id: 'issue-117',
        state: 'valid',
      },
      reconciliationReport: {
        pr_assessments: [
          {
            pr_number: 127,
            ownership: {
              status: 'stale',
              owner_session: 'worker-58',
            },
          },
        ],
      },
    });

    expect(report).toMatchObject({
      posture: 'restore_ready',
      recommended_action: 'restore_existing_worker',
      owner_session_name: 'worker-58',
      checkpoint_state: 'valid',
      reason_codes: ['ownership_stale', 'valid_resume_checkpoint'],
    });
  });

  it('recognizes an accepted successor handoff as granted continuity', () => {
    const report = buildTaskContinuityReport({
      task: createTask(),
      prBinding: { pr_number: 127 },
      ownershipLeases: [
        {
          lease_id: 'ownership-issue-117-worker-58',
          task_id: 'issue-117',
          owner_session_name: 'worker-58',
          status: 'released',
          acquired_at: '2026-03-31T10:00:00.000Z',
        },
      ],
      checkpointInspection: {
        checkpoint_id: 'checkpoint-issue-117-abc',
        task_id: 'issue-117',
        state: 'valid',
      },
      handoffInspection: {
        request_id: 'handoff-issue-117-1',
        top_status: 'accepted',
        claims: [
          {
            claim_id: 'claim-1',
            successor_session_name: 'worker-59',
          },
        ],
        request: {
          selected_claim_id: 'claim-1',
        },
      },
      reconciliationReport: {
        pr_assessments: [
          {
            pr_number: 127,
            ownership: {
              status: 'orphaned',
              owner_session: null,
            },
          },
        ],
      },
    });

    expect(report).toMatchObject({
      posture: 'handoff_granted',
      recommended_action: 'handoff_to_successor',
      owner_session_name: 'worker-58',
      successor_session_name: 'worker-59',
      handoff_request_id: 'handoff-issue-117-1',
      reason_codes: ['ownership_orphaned', 'accepted_successor_handoff'],
    });
  });

  it('fails closed to ambiguous posture when continuity signals conflict', () => {
    const report = buildTaskContinuityReport({
      task: createTask(),
      ownershipLeases: [
        {
          lease_id: 'ownership-issue-117-worker-58',
          task_id: 'issue-117',
          owner_session_name: 'worker-58',
          status: 'active',
          acquired_at: '2026-03-31T10:00:00.000Z',
        },
        {
          lease_id: 'ownership-issue-117-worker-59',
          task_id: 'issue-117',
          owner_session_name: 'worker-59',
          status: 'active',
          acquired_at: '2026-03-31T10:01:00.000Z',
        },
      ],
    });

    expect(report).toMatchObject({
      posture: 'ambiguous',
      recommended_action: 'hold_for_human',
      reason_codes: ['conflicting_active_owner'],
    });
  });

  it('summarizes posture counts for operator-visible reports', () => {
    expect(summarizeContinuityReports([
      { posture: 'active_owner', recommended_action: 'continue_current_worker' },
      { posture: 'restore_ready', recommended_action: 'restore_existing_worker' },
      { posture: 'handoff_pending', recommended_action: 'handoff_to_successor' },
      { posture: 'handoff_pending', recommended_action: 'handoff_to_successor' },
      { posture: 'ambiguous', recommended_action: 'hold_for_human' },
    ])).toEqual({
      posture_counts: {
        active_owner: 1,
        restore_ready: 1,
        handoff_pending: 2,
        handoff_granted: 0,
        orphaned: 0,
        ambiguous: 1,
        retired: 0,
      },
      recommended_action_counts: {
        continue_current_worker: 1,
        restore_existing_worker: 1,
        handoff_to_successor: 2,
        hold_for_human: 1,
        no_action: 0,
      },
    });
  });
});
