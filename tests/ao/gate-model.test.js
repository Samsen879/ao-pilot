import { describe, expect, it } from '@jest/globals';
import {
  GATE_NAMES,
  GATE_STATES,
  GATE_BLOCKER_CODES,
  createGate,
  createGateSnapshot,
  collectGateBlockerCodes,
} from '../../scripts/ao/lib/gate-model.js';

describe('gate model', () => {
  it('freezes the shared gate vocabulary for reconciliation and lifecycle', () => {
    expect(GATE_NAMES).toEqual([
      'ownership',
      'review',
      'ci',
      'mergeability',
      'release',
    ]);
    expect(GATE_STATES).toEqual([
      'open',
      'pending',
      'blocked',
      'ambiguous',
      'not_applicable',
    ]);
    expect(GATE_BLOCKER_CODES).toEqual(expect.arrayContaining([
      'orphan_open_pr',
      'review_blocked',
      'ci_blocked',
      'merge_conflict_blocked',
    ]));
  });

  it('creates normalized gate snapshots and collects blocker codes deterministically', () => {
    const reviewGate = createGate({
      name: 'review',
      state: 'pending',
      reason_codes: ['review_pending'],
    });
    const snapshot = createGateSnapshot({
      ownership: {
        state: 'open',
      },
      review: reviewGate,
      ci: {
        state: 'blocked',
        blocker_codes: ['ci_blocked'],
      },
      mergeability: {
        state: 'ambiguous',
        reason_codes: ['mergeability_unknown'],
      },
      release: {
        state: 'blocked',
        blocker_codes: ['ci_blocked'],
        reason_codes: ['ci_pending'],
      },
    });

    expect(snapshot.review).toEqual({
      name: 'review',
      state: 'pending',
      blocker_codes: [],
      reason_codes: ['review_pending'],
    });
    expect(snapshot.release).toEqual({
      name: 'release',
      state: 'blocked',
      blocker_codes: ['ci_blocked'],
      reason_codes: ['ci_pending'],
    });
    expect(collectGateBlockerCodes(snapshot)).toEqual(['ci_blocked']);
  });
});
