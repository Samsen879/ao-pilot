import { describe, expect, it } from '@jest/globals';

import {
  CONTINUITY_POSTURES,
  CONTINUITY_RECOMMENDED_ACTIONS,
  CONTINUITY_REPORT_FORMAT,
  CONTINUITY_SCHEMA_VERSION,
  createContinuityInspection,
} from '../../scripts/ao/lib/continuity-contracts.js';

describe('continuity contracts', () => {
  it('creates a normalized continuity inspection payload', () => {
    expect(createContinuityInspection({
      taskId: 'issue-117',
      issueNumber: 117,
      prNumber: 127,
      taskStatus: 'active',
      posture: 'handoff_granted',
      recommendedAction: 'handoff_to_successor',
      ownerSessionName: 'worker-58',
      successorSessionName: 'worker-59',
      checkpointId: 'checkpoint-issue-117-abc',
      checkpointState: 'valid',
      handoffRequestId: 'handoff-issue-117-1',
      reasonCodes: ['ownership_orphaned', 'accepted_successor_handoff', 'ownership_orphaned'],
    })).toEqual({
      schema_version: CONTINUITY_SCHEMA_VERSION,
      report_format: CONTINUITY_REPORT_FORMAT,
      task_id: 'issue-117',
      issue_number: 117,
      pr_number: 127,
      task_status: 'active',
      posture: 'handoff_granted',
      recommended_action: 'handoff_to_successor',
      owner_session_name: 'worker-58',
      successor_session_name: 'worker-59',
      checkpoint_id: 'checkpoint-issue-117-abc',
      checkpoint_state: 'valid',
      handoff_request_id: 'handoff-issue-117-1',
      reason_codes: ['ownership_orphaned', 'accepted_successor_handoff'],
    });
  });

  it('keeps the supported posture and action vocabularies explicit', () => {
    expect(CONTINUITY_POSTURES).toEqual([
      'active_owner',
      'restore_ready',
      'handoff_pending',
      'handoff_granted',
      'orphaned',
      'ambiguous',
      'retired',
    ]);
    expect(CONTINUITY_RECOMMENDED_ACTIONS).toEqual([
      'continue_current_worker',
      'restore_existing_worker',
      'handoff_to_successor',
      'hold_for_human',
      'no_action',
    ]);
  });

  it('fails closed on unsupported posture or action values', () => {
    expect(() => createContinuityInspection({
      taskId: 'issue-117',
      posture: 'bogus',
      recommendedAction: 'handoff_to_successor',
    })).toThrow(/Unsupported continuity posture/i);

    expect(() => createContinuityInspection({
      taskId: 'issue-117',
      posture: 'active_owner',
      recommendedAction: 'bogus',
    })).toThrow(/Unsupported continuity action/i);
  });
});
