import { describe, expect, it } from '@jest/globals';

import {
  STATE_REPOSITORY_COLLECTIONS,
  STATE_REPOSITORY_UPSERT_COLLECTIONS,
  upsertRepositoryCollectionRecord,
} from '../../scripts/ao/lib/state-repository/collections.js';

const EXPECTED_COLLECTIONS = [
  ['managed_tasks', 'task_id', 'managed_task', 'upsertManagedTask', false],
  ['pr_bindings', 'binding_id', 'pr_binding', 'upsertPrBinding', false],
  ['ownership_leases', 'lease_id', 'ownership_lease', 'upsertOwnershipLease', false],
  ['controller_leases', 'lease_id', 'controller_lease', null, true],
  ['actions', 'action_id', 'action', 'upsertAction', false],
  ['overrides', 'override_id', 'override', 'upsertOverride', false],
  ['controller_modes', 'controller_id', 'controller_mode', 'upsertControllerMode', false],
  ['observations', 'observation_id', 'observation', 'upsertObservation', false],
  ['delivery_events', 'event_id', 'delivery_event', 'upsertDeliveryEvent', false],
  ['controller_cursors', 'cursor_id', 'controller_cursor', 'upsertControllerCursor', false],
  ['policy_decisions', 'decision_id', 'policy_decision', 'upsertPolicyDecision', false],
  ['credential_provenances', 'provenance_id', 'credential_provenance', 'upsertCredentialProvenance', false],
  ['task_specs', 'task_id', 'task_spec', 'upsertTaskSpec', false],
  ['runtime_preflights', 'runtime_ref', 'runtime_preflight', 'upsertRuntimePreflight', false],
  ['repo_knowledge', 'project_id', 'repo_knowledge', 'upsertRepoKnowledge', false],
  ['review_records', 'review_id', 'review_record', 'upsertReviewRecord', false],
  ['checkpoints', 'checkpoint_id', 'checkpoint', 'upsertCheckpoint', false],
  ['handoff_requests', 'request_id', 'handoff_request', 'upsertHandoffRequest', false],
  ['handoff_claims', 'claim_id', 'handoff_claim', 'upsertHandoffClaim', false],
  ['handoff_decisions', 'decision_id', 'handoff_decision', 'upsertHandoffDecision', false],
  ['handoff_transfers', 'transfer_id', 'handoff_transfer', 'upsertHandoffTransfer', false],
  ['controller_run_metrics', 'controller_run_metric_id', 'controller_run_metric', 'upsertControllerRunMetric', false],
  ['execution_attempt_metrics', 'execution_attempt_metric_id', 'execution_attempt_metric', 'upsertExecutionAttemptMetric', false],
];

describe('ao state repository collection descriptors', () => {
  it('pins the W11 collection vocabulary and isolated controller lease boundary', () => {
    expect(STATE_REPOSITORY_COLLECTIONS.map((descriptor) => [
      descriptor.collectionKey,
      descriptor.identityKey,
      descriptor.entityKind,
      descriptor.methodName ?? null,
      descriptor.isolatedPersistence === true,
    ])).toEqual(EXPECTED_COLLECTIONS);

    expect(STATE_REPOSITORY_UPSERT_COLLECTIONS.map((descriptor) => descriptor.collectionKey)).toEqual(
      EXPECTED_COLLECTIONS
        .filter(([, , , , isolatedPersistence]) => !isolatedPersistence)
        .map(([collectionKey]) => collectionKey),
    );
  });

  it('initializes only a missing or non-array target collection during generic upsert', () => {
    const descriptor = {
      collectionKey: 'records',
      identityKey: 'record_id',
      normalize: (record) => ({
        record_id: record.record_id.trim(),
        value: record.value,
      }),
    };
    const missingCollectionState = {};
    const nonArrayCollectionState = {
      records: { stale: true },
    };

    expect(upsertRepositoryCollectionRecord({
      state: missingCollectionState,
      descriptor,
      record: {
        record_id: ' record-1 ',
        value: 'first',
      },
    })).toEqual({
      record_id: 'record-1',
      value: 'first',
    });
    expect(missingCollectionState.records).toEqual([
      {
        record_id: 'record-1',
        value: 'first',
      },
    ]);

    upsertRepositoryCollectionRecord({
      state: nonArrayCollectionState,
      descriptor,
      record: {
        record_id: 'record-2',
        value: 'second',
      },
    });
    expect(nonArrayCollectionState.records).toEqual([
      {
        record_id: 'record-2',
        value: 'second',
      },
    ]);
  });

  it('keeps the repository state object required for generic upsert', () => {
    expect(() => upsertRepositoryCollectionRecord({
      descriptor: {
        collectionKey: 'records',
        identityKey: 'record_id',
        normalize: (record) => record,
      },
      record: {
        record_id: 'record-1',
      },
    })).toThrow('State object is required for upserting repository collection records');
  });
});
