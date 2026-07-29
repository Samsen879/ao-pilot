import {
  createActionRecord,
  createCheckpointRecord,
  createControllerModeRecord,
  createControllerRunMetricRecord,
  createControllerCursorRecord,
  createCredentialProvenanceRecord,
  createDeliveryEventRecord,
  createExecutionAttemptMetricRecord,
  createHandoffClaimRecord,
  createHandoffDecisionRecord,
  createHandoffRequestRecord,
  createHandoffTransferRecord,
  createManagedTask,
  createObservationRecord,
  createOverrideRecord,
  createOwnershipLease,
  createPolicyDecisionRecord,
  createPrBinding,
  createReviewRecord,
  createRepoKnowledgeRecord,
  createRuntimePreflightRecord,
  createTaskSpecRecord,
} from '../state-contracts.js';

function persistedSummary(label, identityKey) {
  return (record) => `Persisted ${label} ${record?.[identityKey]}.`;
}

const COLLECTION_DESCRIPTORS = [
  {
    collectionKey: 'managed_tasks',
    identityKey: 'task_id',
    entityKind: 'managed_task',
    methodName: 'upsertManagedTask',
    normalize: createManagedTask,
    summary: persistedSummary('managed task', 'task_id'),
  },
  {
    collectionKey: 'pr_bindings',
    identityKey: 'binding_id',
    entityKind: 'pr_binding',
    methodName: 'upsertPrBinding',
    normalize: createPrBinding,
    summary: persistedSummary('PR binding', 'binding_id'),
  },
  {
    collectionKey: 'ownership_leases',
    identityKey: 'lease_id',
    entityKind: 'ownership_lease',
    methodName: 'upsertOwnershipLease',
    normalize: createOwnershipLease,
    summary: persistedSummary('ownership lease', 'lease_id'),
  },
  {
    collectionKey: 'controller_leases',
    identityKey: 'lease_id',
    entityKind: 'controller_lease',
    isolatedPersistence: true,
  },
  {
    collectionKey: 'actions',
    identityKey: 'action_id',
    entityKind: 'action',
    methodName: 'upsertAction',
    normalize: createActionRecord,
    summary: persistedSummary('action', 'action_id'),
  },
  {
    collectionKey: 'overrides',
    identityKey: 'override_id',
    entityKind: 'override',
    methodName: 'upsertOverride',
    normalize: createOverrideRecord,
    summary: persistedSummary('override', 'override_id'),
  },
  {
    collectionKey: 'controller_modes',
    identityKey: 'controller_id',
    entityKind: 'controller_mode',
    methodName: 'upsertControllerMode',
    normalize: createControllerModeRecord,
    summary: persistedSummary('controller mode', 'controller_id'),
  },
  {
    collectionKey: 'observations',
    identityKey: 'observation_id',
    entityKind: 'observation',
    methodName: 'upsertObservation',
    normalize: createObservationRecord,
    summary: persistedSummary('observation', 'observation_id'),
  },
  {
    collectionKey: 'delivery_events',
    identityKey: 'event_id',
    entityKind: 'delivery_event',
    methodName: 'upsertDeliveryEvent',
    normalize: createDeliveryEventRecord,
    summary: persistedSummary('delivery event', 'event_id'),
  },
  {
    collectionKey: 'controller_cursors',
    identityKey: 'cursor_id',
    entityKind: 'controller_cursor',
    methodName: 'upsertControllerCursor',
    normalize: createControllerCursorRecord,
    summary: persistedSummary('controller cursor', 'cursor_id'),
  },
  {
    collectionKey: 'policy_decisions',
    identityKey: 'decision_id',
    entityKind: 'policy_decision',
    methodName: 'upsertPolicyDecision',
    normalize: createPolicyDecisionRecord,
    summary: persistedSummary('policy decision', 'decision_id'),
  },
  {
    collectionKey: 'credential_provenances',
    identityKey: 'provenance_id',
    entityKind: 'credential_provenance',
    methodName: 'upsertCredentialProvenance',
    normalize: createCredentialProvenanceRecord,
    summary: persistedSummary('credential provenance', 'provenance_id'),
  },
  {
    collectionKey: 'task_specs',
    identityKey: 'task_id',
    entityKind: 'task_spec',
    methodName: 'upsertTaskSpec',
    normalize: createTaskSpecRecord,
    summary: persistedSummary('task spec', 'task_id'),
  },
  {
    collectionKey: 'runtime_preflights',
    identityKey: 'runtime_ref',
    entityKind: 'runtime_preflight',
    methodName: 'upsertRuntimePreflight',
    normalize: createRuntimePreflightRecord,
    summary: (record) => `Persisted runtime preflight ${record?.runtime_ref ?? record?.snapshot?.runtime_ref}.`,
  },
  {
    collectionKey: 'repo_knowledge',
    identityKey: 'project_id',
    entityKind: 'repo_knowledge',
    methodName: 'upsertRepoKnowledge',
    normalize: createRepoKnowledgeRecord,
    summary: (record) => `Persisted repo knowledge ${record?.project_id ?? record?.snapshot?.project_id}.`,
  },
  {
    collectionKey: 'review_records',
    identityKey: 'review_id',
    entityKind: 'review_record',
    methodName: 'upsertReviewRecord',
    normalize: createReviewRecord,
    summary: persistedSummary('review record', 'review_id'),
  },
  {
    collectionKey: 'checkpoints',
    identityKey: 'checkpoint_id',
    entityKind: 'checkpoint',
    methodName: 'upsertCheckpoint',
    normalize: createCheckpointRecord,
    summary: persistedSummary('checkpoint', 'checkpoint_id'),
  },
  {
    collectionKey: 'handoff_requests',
    identityKey: 'request_id',
    entityKind: 'handoff_request',
    methodName: 'upsertHandoffRequest',
    normalize: createHandoffRequestRecord,
    summary: persistedSummary('handoff request', 'request_id'),
  },
  {
    collectionKey: 'handoff_claims',
    identityKey: 'claim_id',
    entityKind: 'handoff_claim',
    methodName: 'upsertHandoffClaim',
    normalize: createHandoffClaimRecord,
    summary: persistedSummary('handoff claim', 'claim_id'),
  },
  {
    collectionKey: 'handoff_decisions',
    identityKey: 'decision_id',
    entityKind: 'handoff_decision',
    methodName: 'upsertHandoffDecision',
    normalize: createHandoffDecisionRecord,
    summary: persistedSummary('handoff decision', 'decision_id'),
  },
  {
    collectionKey: 'handoff_transfers',
    identityKey: 'transfer_id',
    entityKind: 'handoff_transfer',
    methodName: 'upsertHandoffTransfer',
    normalize: createHandoffTransferRecord,
    summary: persistedSummary('handoff transfer', 'transfer_id'),
  },
  {
    collectionKey: 'controller_run_metrics',
    identityKey: 'controller_run_metric_id',
    entityKind: 'controller_run_metric',
    methodName: 'upsertControllerRunMetric',
    normalize: createControllerRunMetricRecord,
    summary: persistedSummary('controller run metric', 'controller_run_metric_id'),
  },
  {
    collectionKey: 'execution_attempt_metrics',
    identityKey: 'execution_attempt_metric_id',
    entityKind: 'execution_attempt_metric',
    methodName: 'upsertExecutionAttemptMetric',
    normalize: createExecutionAttemptMetricRecord,
    summary: persistedSummary('execution attempt metric', 'execution_attempt_metric_id'),
  },
];

export const STATE_REPOSITORY_COLLECTIONS = Object.freeze(
  COLLECTION_DESCRIPTORS.map((descriptor) => Object.freeze({ ...descriptor })),
);

export const STATE_REPOSITORY_UPSERT_COLLECTIONS = Object.freeze(
  STATE_REPOSITORY_COLLECTIONS.filter((descriptor) => descriptor.isolatedPersistence !== true),
);

export function sortRepositoryCollectionByKey(items, key) {
  return [...(items ?? [])].sort((left, right) => String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? '')));
}

export function sortRepositoryStateCollections(state, {
  controllerLeases = null,
} = {}) {
  const nextState = { ...state };

  for (const descriptor of STATE_REPOSITORY_COLLECTIONS) {
    nextState[descriptor.collectionKey] = sortRepositoryCollectionByKey(
      nextState[descriptor.collectionKey],
      descriptor.identityKey,
    );
  }

  if (controllerLeases != null) {
    nextState.controller_leases = controllerLeases;
  }

  return nextState;
}

export function upsertRepositoryCollectionRecord({
  state,
  descriptor,
  record,
} = {}) {
  if (!state || typeof state !== 'object') {
    throw new Error('State object is required for upserting repository collection records');
  }

  const normalizedRecord = descriptor.normalize(record);
  if (!Array.isArray(state[descriptor.collectionKey])) {
    state[descriptor.collectionKey] = [];
  }

  const existingIndex = state[descriptor.collectionKey].findIndex(
    (entry) => entry?.[descriptor.identityKey] === normalizedRecord[descriptor.identityKey],
  );

  if (existingIndex >= 0) {
    state[descriptor.collectionKey][existingIndex] = normalizedRecord;
  } else {
    state[descriptor.collectionKey].push(normalizedRecord);
  }

  return normalizedRecord;
}

export function createRepositoryCollectionUpsertMethods(upsertCollectionRecord) {
  return Object.fromEntries(
    STATE_REPOSITORY_UPSERT_COLLECTIONS.map((descriptor) => [
      descriptor.methodName,
      (record) => upsertCollectionRecord({
        descriptor,
        record,
      }),
    ]),
  );
}
