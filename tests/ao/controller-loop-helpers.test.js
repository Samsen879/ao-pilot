import {
  deriveLifecycleTriggerForTask,
  isDeliveryEventCurrentForPr,
  resolveTaskRuntimePreflight,
  uniquePrNumbers,
} from '../../scripts/ao/lib/controller-loop/delivery-triggers.js';
import { resolveHeartbeatIntervalMs } from '../../scripts/ao/lib/controller-loop/lease-helpers.js';
import { ensureStopRequestedAt } from '../../scripts/ao/lib/controller-loop/shutdown.js';
import { addMilliseconds } from '../../scripts/ao/lib/controller-loop/time.js';

describe('ao controller loop helpers', () => {
  it('derives triggers from current delivery events before stale PR status', () => {
    const trigger = deriveLifecycleTriggerForTask({
      matchedAoWorkers: [
        {
          freshness: {
            status: 'fresh',
          },
        },
      ],
      matchedPrs: [
        {
          pr_number: 42,
          head_sha: 'new-head',
          review_status: 'changes_requested',
          ci_status: 'failing',
          mergeability: 'mergeable',
          is_draft: false,
        },
      ],
      deliveryEvents: [
        {
          event_id: 'old-check',
          pr_number: 42,
          event_family: 'check',
          lifecycle_trigger: 'ci_failed',
          observed_at: '2026-06-19T00:00:00.000Z',
          payload: {
            head_sha: 'old-head',
          },
        },
        {
          event_id: 'review-comment',
          pr_number: 42,
          event_family: 'review_comment',
          lifecycle_trigger: 'changes_requested',
          observed_at: '2026-06-19T00:01:00.000Z',
          payload: {
            commit_oid: 'new-head',
          },
        },
      ],
    });

    expect(trigger).toBe('changes_requested');
  });

  it('derives a bounded heartbeat interval from the lease timeout', () => {
    expect(resolveHeartbeatIntervalMs(null, 60)).toBe(25);
    expect(resolveHeartbeatIntervalMs(null, 6000)).toBe(1000);
    expect(resolveHeartbeatIntervalMs(250, 6000)).toBe(250);
  });

  it('keeps a stable stop request timestamp for non-extensible signals', () => {
    const controller = new AbortController();
    controller.abort();
    Object.preventExtensions(controller.signal);

    const requestedAt = ensureStopRequestedAt(controller.signal);

    expect(typeof requestedAt).toBe('string');
    expect(requestedAt).not.toBe('');
    expect(ensureStopRequestedAt(controller.signal)).toBe(requestedAt);
  });

  it('ignores nullish delivery trigger inputs', () => {
    expect(uniquePrNumbers([
      null,
      { status: 'bound', pr_number: 3 },
      undefined,
      { status: 'ignored', pr_number: 2 },
    ], [
      undefined,
      { pr_number: 1 },
      null,
    ])).toEqual([1, 3]);

    expect(resolveTaskRuntimePreflight(null, null)).toEqual({
      taskSpec: null,
      runtimeRef: null,
      runtimePreflight: null,
    });

    expect(isDeliveryEventCurrentForPr(null, {})).toBe(false);
    expect(deriveLifecycleTriggerForTask({
      matchedAoWorkers: [
        { freshness: { status: 'fresh' } },
        null,
      ],
      matchedPrs: [
        null,
        {
          review_status: 'approved',
          ci_status: 'passing',
          mergeability: 'mergeable',
          is_draft: false,
        },
      ],
      deliveryEvents: [
        null,
      ],
    })).toBe('approved_and_green');
    expect(deriveLifecycleTriggerForTask({
      matchedAoWorkers: [
        { freshness: { status: 'fresh' } },
      ],
      matchedPrs: null,
      deliveryEvents: null,
    })).toBe('manual');
  });

  it('rejects null timestamps before date arithmetic', () => {
    expect(() => addMilliseconds(null, 1000)).toThrow('Invalid timestamp: null');
  });
});
