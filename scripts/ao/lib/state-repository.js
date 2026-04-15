import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  CONTROL_PLANE_LATEST_VERSION,
  createActionRecord,
  createCheckpointRecord,
  createControlPlaneAuditEntry,
  createControlPlaneSchema,
  createControllerLease,
  createControllerModeRecord,
  createControllerRunMetricRecord,
  createControllerCursorRecord,
  createCredentialProvenanceRecord,
  createDeliveryEventRecord,
  createEmptyControlPlaneState,
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
} from './state-contracts.js';
import { materializeRepoKnowledge } from './repo-knowledge.js';
import { runRuntimeBootstrapPreflight } from './runtime-preflight.js';
import { appendControlPlaneAuditEntry, readControlPlaneAuditEntries } from './state-audit.js';
import {
  bootstrapControlPlaneState,
  readControlPlaneSchema,
  readControlPlaneState,
  resolveControlPlanePaths,
} from './state-migrations.js';
import {
  readJsonFile,
  withFileLock,
  withFileLockSync,
  writeJsonFileAtomic,
} from './state-storage.js';

function resolveNow(clock) {
  if (typeof clock === 'function') return resolveNow(clock());
  if (typeof clock === 'string' && clock.trim() !== '') return clock.trim();
  return new Date().toISOString();
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function buildVirtualSchema(projectId) {
  return createControlPlaneSchema({
    project_id: projectId,
    current_version: 0,
    latest_version: CONTROL_PLANE_LATEST_VERSION,
    created_at: null,
    updated_at: null,
    applied_migrations: [],
  });
}

function buildVirtualState(projectId) {
  return createEmptyControlPlaneState({
    project_id: projectId,
    created_at: null,
    updated_at: null,
  });
}

function sortCollectionByKey(items, key) {
  return [...(items ?? [])].sort((left, right) => String(left?.[key] ?? '').localeCompare(String(right?.[key] ?? '')));
}

function normalizeRuntimeRefs(runtimeRefs) {
  if (!Array.isArray(runtimeRefs)) return [];
  return [...new Set(runtimeRefs
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function extractRuntimeRefsFromState(state) {
  return normalizeRuntimeRefs(
    (state?.task_specs ?? []).map((record) => record?.snapshot?.spec?.runtime_ref ?? null),
  );
}

function sanitizeArtifactToken(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }

  const normalized = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

export function createStateRepository({
  repoRoot,
  projectId,
  clock = () => new Date().toISOString(),
  auditIdGenerator = randomUUID,
} = {}) {
  const paths = resolveControlPlanePaths({
    repoRoot,
    projectId,
  });
  const controllerLeaseLockPath = `${paths.controllerLeasesPath}.lock`;

  function readControllerLeaseRecords() {
    const records = readJsonFile(paths.controllerLeasesPath);
    if (!Array.isArray(records)) return null;
    return sortCollectionByKey(
      records.map((record) => createControllerLease(record)),
      'lease_id',
    );
  }

  function readSnapshot() {
    const schema = readControlPlaneSchema({ schemaPath: paths.schemaPath });
    const state = readControlPlaneState({ statePath: paths.statePath });

    if (!schema || !state) {
      return {
        bootstrapped: false,
        schema: buildVirtualSchema(projectId),
        state: buildVirtualState(projectId),
        paths,
      };
    }

    const nextState = cloneJsonValue(state);
    nextState.managed_tasks = sortCollectionByKey(nextState.managed_tasks, 'task_id');
    nextState.pr_bindings = sortCollectionByKey(nextState.pr_bindings, 'binding_id');
    nextState.ownership_leases = sortCollectionByKey(nextState.ownership_leases, 'lease_id');
    nextState.controller_leases = sortCollectionByKey(nextState.controller_leases, 'lease_id');
    nextState.actions = sortCollectionByKey(nextState.actions, 'action_id');
    nextState.overrides = sortCollectionByKey(nextState.overrides, 'override_id');
    nextState.controller_modes = sortCollectionByKey(nextState.controller_modes, 'controller_id');
    nextState.observations = sortCollectionByKey(nextState.observations, 'observation_id');
    nextState.delivery_events = sortCollectionByKey(nextState.delivery_events, 'event_id');
    nextState.controller_cursors = sortCollectionByKey(nextState.controller_cursors, 'cursor_id');
    nextState.policy_decisions = sortCollectionByKey(nextState.policy_decisions, 'decision_id');
    nextState.credential_provenances = sortCollectionByKey(nextState.credential_provenances, 'provenance_id');
    nextState.task_specs = sortCollectionByKey(nextState.task_specs, 'task_id');
    nextState.runtime_preflights = sortCollectionByKey(nextState.runtime_preflights, 'runtime_ref');
    nextState.repo_knowledge = sortCollectionByKey(nextState.repo_knowledge, 'project_id');
    nextState.review_records = sortCollectionByKey(nextState.review_records, 'review_id');
    nextState.checkpoints = sortCollectionByKey(nextState.checkpoints, 'checkpoint_id');
    nextState.handoff_requests = sortCollectionByKey(nextState.handoff_requests, 'request_id');
    nextState.handoff_claims = sortCollectionByKey(nextState.handoff_claims, 'claim_id');
    nextState.handoff_decisions = sortCollectionByKey(nextState.handoff_decisions, 'decision_id');
    nextState.handoff_transfers = sortCollectionByKey(nextState.handoff_transfers, 'transfer_id');
    nextState.controller_run_metrics = sortCollectionByKey(
      nextState.controller_run_metrics,
      'controller_run_metric_id',
    );
    nextState.execution_attempt_metrics = sortCollectionByKey(
      nextState.execution_attempt_metrics,
      'execution_attempt_metric_id',
    );
    const isolatedControllerLeases = readControllerLeaseRecords();
    if (isolatedControllerLeases != null) {
      nextState.controller_leases = isolatedControllerLeases;
    }

    return {
      bootstrapped: true,
      schema,
      state: nextState,
      paths,
    };
  }

  function ensureBootstrapped() {
    bootstrapControlPlaneState({
      repoRoot,
      projectId,
      now: clock,
    });
  }

  function persistState({
    state,
    entityKind,
    entityId,
    summary,
    details,
  } = {}) {
    const recordedAt = resolveNow(clock);
    const nextState = cloneJsonValue(state);
    nextState.updated_at = recordedAt;
    writeJsonFileAtomic(paths.statePath, nextState);
    appendControlPlaneAuditEntry({
      auditPath: paths.auditPath,
      entry: createControlPlaneAuditEntry({
        audit_id: auditIdGenerator(),
        project_id: projectId,
        recorded_at: recordedAt,
        entity_kind: entityKind,
        entity_id: entityId,
        operation: 'upsert',
        actor: 'state_repository',
        summary,
        details,
      }),
    });
  }

  function persistControllerLeases({
    controllerLeases,
    entityId,
    summary,
    details,
  } = {}) {
    const recordedAt = resolveNow(clock);
    const nextControllerLeases = sortCollectionByKey(
      (controllerLeases ?? []).map((record) => createControllerLease(record)),
      'lease_id',
    );
    writeJsonFileAtomic(paths.controllerLeasesPath, nextControllerLeases);
    appendControlPlaneAuditEntry({
      auditPath: paths.auditPath,
      entry: createControlPlaneAuditEntry({
        audit_id: auditIdGenerator(),
        project_id: projectId,
        recorded_at: recordedAt,
        entity_kind: 'controller_lease',
        entity_id: entityId,
        operation: 'upsert',
        actor: 'state_repository',
        summary,
        details,
      }),
    });
  }

  async function mutateControllerLeasesAtomically({
    entityId,
    summary,
    timeoutMs = 1000,
    retryMs = 10,
    mutate,
  } = {}) {
    ensureBootstrapped();
    return withFileLock(controllerLeaseLockPath, async () => {
      const snapshot = readSnapshot();
      const nextState = cloneJsonValue(snapshot.state);

      function upsertControllerLeaseRecord(record) {
        const normalizedRecord = createControllerLease(record);
        const existingIndex = nextState.controller_leases.findIndex(
          (entry) => entry?.lease_id === normalizedRecord.lease_id,
        );
        if (existingIndex >= 0) {
          nextState.controller_leases[existingIndex] = normalizedRecord;
        } else {
          nextState.controller_leases.push(normalizedRecord);
        }
        return normalizedRecord;
      }

      function findControllerLeaseById(leaseId) {
        return nextState.controller_leases.find((entry) => entry?.lease_id === leaseId) ?? null;
      }

      function findActiveLeaseForController(controllerId) {
        return nextState.controller_leases.find((entry) => (
          entry?.controller_id === controllerId && entry?.status === 'active'
        )) ?? null;
      }

      const result = await mutate({
        snapshot,
        nextState,
        upsertControllerLease: upsertControllerLeaseRecord,
        findControllerLeaseById,
        findActiveLeaseForController,
      });

      persistControllerLeases({
        controllerLeases: nextState.controller_leases,
        entityId: result?.entityId ?? entityId,
        summary: result?.summary ?? summary,
        details: result?.details ?? nextState.controller_leases,
      });

      return result?.value ?? null;
    }, {
      timeoutMs,
      retryMs,
    });
  }

  function upsertCollectionRecord({
    collectionKey,
    identityKey,
    entityKind,
    record,
    normalize,
    summary,
  } = {}) {
    ensureBootstrapped();
    const snapshot = readSnapshot();
    const nextState = cloneJsonValue(snapshot.state);
    const normalizedRecord = normalize(record);
    const existingIndex = nextState[collectionKey].findIndex(
      (entry) => entry?.[identityKey] === normalizedRecord[identityKey],
    );

    if (existingIndex >= 0) {
      nextState[collectionKey][existingIndex] = normalizedRecord;
    } else {
      nextState[collectionKey].push(normalizedRecord);
    }

    persistState({
      state: nextState,
      entityKind,
      entityId: normalizedRecord[identityKey],
      summary,
      details: normalizedRecord,
    });

    return normalizedRecord;
  }

  return {
    getSnapshot() {
      return readSnapshot();
    },

    appendAuditEntry({
      entityKind,
      entityId,
      operation,
      actor,
      summary,
      details = {},
      recordedAt = null,
    } = {}) {
      ensureBootstrapped();
      appendControlPlaneAuditEntry({
        auditPath: paths.auditPath,
        entry: createControlPlaneAuditEntry({
          audit_id: auditIdGenerator(),
          project_id: projectId,
          recorded_at: resolveNow(recordedAt ?? clock),
          entity_kind: entityKind,
          entity_id: entityId,
          operation,
          actor,
          summary,
          details,
        }),
      });
    },

    listAuditEntries({ limit = null } = {}) {
      return readControlPlaneAuditEntries({
        auditPath: paths.auditPath,
        limit,
      });
    },

    upsertManagedTask(record) {
      return upsertCollectionRecord({
        collectionKey: 'managed_tasks',
        identityKey: 'task_id',
        entityKind: 'managed_task',
        record,
        normalize: createManagedTask,
        summary: `Persisted managed task ${record?.task_id}.`,
      });
    },

    upsertPrBinding(record) {
      return upsertCollectionRecord({
        collectionKey: 'pr_bindings',
        identityKey: 'binding_id',
        entityKind: 'pr_binding',
        record,
        normalize: createPrBinding,
        summary: `Persisted PR binding ${record?.binding_id}.`,
      });
    },

    upsertOwnershipLease(record) {
      return upsertCollectionRecord({
        collectionKey: 'ownership_leases',
        identityKey: 'lease_id',
        entityKind: 'ownership_lease',
        record,
        normalize: createOwnershipLease,
        summary: `Persisted ownership lease ${record?.lease_id}.`,
      });
    },

    upsertControllerLease(record) {
      ensureBootstrapped();
      return withFileLockSync(controllerLeaseLockPath, () => {
        const snapshot = readSnapshot();
        const nextState = cloneJsonValue(snapshot.state);
        const normalizedRecord = createControllerLease(record);
        const existingIndex = nextState.controller_leases.findIndex(
          (entry) => entry?.lease_id === normalizedRecord.lease_id,
        );

        if (existingIndex >= 0) {
          nextState.controller_leases[existingIndex] = normalizedRecord;
        } else {
          nextState.controller_leases.push(normalizedRecord);
        }

        persistControllerLeases({
          controllerLeases: nextState.controller_leases,
          entityId: normalizedRecord.lease_id,
          summary: `Persisted controller lease ${record?.lease_id}.`,
          details: normalizedRecord,
        });

        return normalizedRecord;
      });
    },

    mutateControllerLeasesAtomically,

    upsertAction(record) {
      return upsertCollectionRecord({
        collectionKey: 'actions',
        identityKey: 'action_id',
        entityKind: 'action',
        record,
        normalize: createActionRecord,
        summary: `Persisted action ${record?.action_id}.`,
      });
    },

    upsertOverride(record) {
      return upsertCollectionRecord({
        collectionKey: 'overrides',
        identityKey: 'override_id',
        entityKind: 'override',
        record,
        normalize: createOverrideRecord,
        summary: `Persisted override ${record?.override_id}.`,
      });
    },

    upsertControllerMode(record) {
      return upsertCollectionRecord({
        collectionKey: 'controller_modes',
        identityKey: 'controller_id',
        entityKind: 'controller_mode',
        record,
        normalize: createControllerModeRecord,
        summary: `Persisted controller mode ${record?.controller_id}.`,
      });
    },

    upsertObservation(record) {
      return upsertCollectionRecord({
        collectionKey: 'observations',
        identityKey: 'observation_id',
        entityKind: 'observation',
        record,
        normalize: createObservationRecord,
        summary: `Persisted observation ${record?.observation_id}.`,
      });
    },

    upsertDeliveryEvent(record) {
      return upsertCollectionRecord({
        collectionKey: 'delivery_events',
        identityKey: 'event_id',
        entityKind: 'delivery_event',
        record,
        normalize: createDeliveryEventRecord,
        summary: `Persisted delivery event ${record?.event_id}.`,
      });
    },

    upsertCredentialProvenance(record) {
      return upsertCollectionRecord({
        collectionKey: 'credential_provenances',
        identityKey: 'provenance_id',
        entityKind: 'credential_provenance',
        record,
        normalize: createCredentialProvenanceRecord,
        summary: `Persisted credential provenance ${record?.provenance_id}.`,
      });
    },

    upsertPolicyDecision(record) {
      return upsertCollectionRecord({
        collectionKey: 'policy_decisions',
        identityKey: 'decision_id',
        entityKind: 'policy_decision',
        record,
        normalize: createPolicyDecisionRecord,
        summary: `Persisted policy decision ${record?.decision_id}.`,
      });
    },

    upsertControllerCursor(record) {
      return upsertCollectionRecord({
        collectionKey: 'controller_cursors',
        identityKey: 'cursor_id',
        entityKind: 'controller_cursor',
        record,
        normalize: createControllerCursorRecord,
        summary: `Persisted controller cursor ${record?.cursor_id}.`,
      });
    },

    upsertTaskSpec(record) {
      return upsertCollectionRecord({
        collectionKey: 'task_specs',
        identityKey: 'task_id',
        entityKind: 'task_spec',
        record,
        normalize: createTaskSpecRecord,
        summary: `Persisted task spec ${record?.task_id}.`,
      });
    },

    upsertRuntimePreflight(record) {
      return upsertCollectionRecord({
        collectionKey: 'runtime_preflights',
        identityKey: 'runtime_ref',
        entityKind: 'runtime_preflight',
        record,
        normalize: createRuntimePreflightRecord,
        summary: `Persisted runtime preflight ${record?.runtime_ref ?? record?.snapshot?.runtime_ref}.`,
      });
    },

    upsertRepoKnowledge(record) {
      return upsertCollectionRecord({
        collectionKey: 'repo_knowledge',
        identityKey: 'project_id',
        entityKind: 'repo_knowledge',
        record,
        normalize: createRepoKnowledgeRecord,
        summary: `Persisted repo knowledge ${record?.project_id ?? record?.snapshot?.project_id}.`,
      });
    },

    upsertReviewRecord(record) {
      return upsertCollectionRecord({
        collectionKey: 'review_records',
        identityKey: 'review_id',
        entityKind: 'review_record',
        record,
        normalize: createReviewRecord,
        summary: `Persisted review record ${record?.review_id}.`,
      });
    },

    upsertHandoffRequest(record) {
      return upsertCollectionRecord({
        collectionKey: 'handoff_requests',
        identityKey: 'request_id',
        entityKind: 'handoff_request',
        record,
        normalize: createHandoffRequestRecord,
        summary: `Persisted handoff request ${record?.request_id}.`,
      });
    },

    upsertHandoffClaim(record) {
      return upsertCollectionRecord({
        collectionKey: 'handoff_claims',
        identityKey: 'claim_id',
        entityKind: 'handoff_claim',
        record,
        normalize: createHandoffClaimRecord,
        summary: `Persisted handoff claim ${record?.claim_id}.`,
      });
    },

    upsertHandoffDecision(record) {
      return upsertCollectionRecord({
        collectionKey: 'handoff_decisions',
        identityKey: 'decision_id',
        entityKind: 'handoff_decision',
        record,
        normalize: createHandoffDecisionRecord,
        summary: `Persisted handoff decision ${record?.decision_id}.`,
      });
    },

    upsertHandoffTransfer(record) {
      return upsertCollectionRecord({
        collectionKey: 'handoff_transfers',
        identityKey: 'transfer_id',
        entityKind: 'handoff_transfer',
        record,
        normalize: createHandoffTransferRecord,
        summary: `Persisted handoff transfer ${record?.transfer_id}.`,
      });
    },

    upsertControllerRunMetric(record) {
      return upsertCollectionRecord({
        collectionKey: 'controller_run_metrics',
        identityKey: 'controller_run_metric_id',
        entityKind: 'controller_run_metric',
        record,
        normalize: createControllerRunMetricRecord,
        summary: `Persisted controller run metric ${record?.controller_run_metric_id}.`,
      });
    },

    upsertExecutionAttemptMetric(record) {
      return upsertCollectionRecord({
        collectionKey: 'execution_attempt_metrics',
        identityKey: 'execution_attempt_metric_id',
        entityKind: 'execution_attempt_metric',
        record,
        normalize: createExecutionAttemptMetricRecord,
        summary: `Persisted execution attempt metric ${record?.execution_attempt_metric_id}.`,
      });
    },

    ensureRuntimePreflights({
      cwd = repoRoot,
      now = clock,
      runtimeRefs = null,
      probes = {},
    } = {}) {
      ensureBootstrapped();
      const timestamp = resolveNow(now);
      let snapshot = readSnapshot();
      const requestedRuntimeRefs = runtimeRefs == null
        ? extractRuntimeRefsFromState(snapshot.state)
        : normalizeRuntimeRefs(runtimeRefs);
      const ensuredRecords = [];

      for (const runtimeRef of requestedRuntimeRefs) {
        const preflightSnapshot = runRuntimeBootstrapPreflight({
          runtimeRef,
          cwd,
          now: timestamp,
          probes,
        });
        const normalizedRecord = createRuntimePreflightRecord({
          recorded_at: timestamp,
          snapshot: preflightSnapshot,
        });
        const existingRecord = (snapshot.state.runtime_preflights ?? []).find(
          (record) => record?.runtime_ref === normalizedRecord.runtime_ref,
        );

        if (existingRecord?.replay_key === normalizedRecord.replay_key) {
          ensuredRecords.push(existingRecord);
          continue;
        }

        const nextState = cloneJsonValue(snapshot.state);
        const existingIndex = nextState.runtime_preflights.findIndex(
          (record) => record?.runtime_ref === normalizedRecord.runtime_ref,
        );
        if (existingIndex >= 0) {
          nextState.runtime_preflights[existingIndex] = normalizedRecord;
        } else {
          nextState.runtime_preflights.push(normalizedRecord);
        }

        persistState({
          state: nextState,
          entityKind: 'runtime_preflight',
          entityId: normalizedRecord.runtime_ref,
        summary: `Persisted runtime preflight ${normalizedRecord.runtime_ref}.`,
          details: normalizedRecord,
        });
        snapshot = {
          ...snapshot,
          state: nextState,
        };
        ensuredRecords.push(normalizedRecord);
      }

      return sortCollectionByKey(ensuredRecords, 'runtime_ref');
    },

    ensureRepoKnowledge({
      now = clock,
    } = {}) {
      ensureBootstrapped();
      const timestamp = resolveNow(now);
      const snapshot = readSnapshot();
      const repoKnowledgeSnapshot = materializeRepoKnowledge({
        repoRoot,
        projectId,
        now: timestamp,
      });
      const normalizedRecord = createRepoKnowledgeRecord({
        recorded_at: timestamp,
        snapshot: repoKnowledgeSnapshot,
      });
      const existingRecord = (snapshot.state.repo_knowledge ?? []).find(
        (record) => record?.project_id === normalizedRecord.project_id,
      );

      if (existingRecord?.replay_key === normalizedRecord.replay_key) {
        return existingRecord;
      }

      const nextState = cloneJsonValue(snapshot.state);
      const existingIndex = nextState.repo_knowledge.findIndex(
        (record) => record?.project_id === normalizedRecord.project_id,
      );
      if (existingIndex >= 0) {
        nextState.repo_knowledge[existingIndex] = normalizedRecord;
      } else {
        nextState.repo_knowledge.push(normalizedRecord);
      }

      persistState({
        state: nextState,
        entityKind: 'repo_knowledge',
        entityId: normalizedRecord.project_id,
        summary: `Persisted repo knowledge ${normalizedRecord.project_id}.`,
        details: normalizedRecord,
      });

      return normalizedRecord;
    },

    upsertCheckpoint(record) {
      return upsertCollectionRecord({
        collectionKey: 'checkpoints',
        identityKey: 'checkpoint_id',
        entityKind: 'checkpoint',
        record,
        normalize: createCheckpointRecord,
        summary: `Persisted checkpoint ${record?.checkpoint_id}.`,
      });
    },

    persistEvalScorecardArtifact({
      scorecard,
      baselineName = null,
      recordedAt = clock,
    } = {}) {
      ensureBootstrapped();
      const timestamp = resolveNow(recordedAt);
      const scorecardId = sanitizeArtifactToken(scorecard?.scorecard_id, 'scorecard_id');
      const scorecardPath = path.join(paths.evalScorecardRoot, `${scorecardId}.json`);
      const operatorScorecardPath = path.join(paths.operatorEvalScorecardRoot, `${scorecardId}.json`);

      writeJsonFileAtomic(scorecardPath, scorecard);
      writeJsonFileAtomic(paths.latestEvalScorecardPath, scorecard);
      writeJsonFileAtomic(operatorScorecardPath, scorecard);
      writeJsonFileAtomic(paths.operatorLatestEvalScorecardPath, scorecard);

      appendControlPlaneAuditEntry({
        auditPath: paths.auditPath,
        entry: createControlPlaneAuditEntry({
          audit_id: auditIdGenerator(),
          project_id: projectId,
          recorded_at: timestamp,
          entity_kind: 'eval_scorecard',
          entity_id: scorecardId,
          operation: 'write',
          actor: 'state_repository',
          summary: `Persisted eval scorecard ${scorecardId}.`,
          details: {
            scorecard_path: scorecardPath,
            operator_scorecard_path: operatorScorecardPath,
          },
        }),
      });

      let baselinePath = null;
      let operatorBaselinePath = null;
      if (baselineName != null) {
        const normalizedBaselineName = sanitizeArtifactToken(baselineName, 'baselineName');
        baselinePath = path.join(paths.evalBaselineRoot, `${normalizedBaselineName}.json`);
        operatorBaselinePath = path.join(paths.operatorEvalBaselineRoot, `${normalizedBaselineName}.json`);
        writeJsonFileAtomic(baselinePath, scorecard);
        writeJsonFileAtomic(operatorBaselinePath, scorecard);
        appendControlPlaneAuditEntry({
          auditPath: paths.auditPath,
          entry: createControlPlaneAuditEntry({
            audit_id: auditIdGenerator(),
            project_id: projectId,
            recorded_at: timestamp,
            entity_kind: 'eval_baseline',
            entity_id: normalizedBaselineName,
            operation: 'write',
            actor: 'state_repository',
            summary: `Persisted eval baseline ${normalizedBaselineName}.`,
            details: {
              baseline_path: baselinePath,
              operator_baseline_path: operatorBaselinePath,
              scorecard_id: scorecardId,
            },
          }),
        });
      }

      return {
        scorecard_path: scorecardPath,
        operator_scorecard_path: operatorScorecardPath,
        baseline_path: baselinePath,
        operator_baseline_path: operatorBaselinePath,
      };
    },

    readEvalScorecardArtifact({
      scorecardId,
    } = {}) {
      const normalizedScorecardId = sanitizeArtifactToken(scorecardId, 'scorecardId');
      return readJsonFile(path.join(paths.evalScorecardRoot, `${normalizedScorecardId}.json`));
    },

    readEvalBaselineArtifact({
      baselineName,
    } = {}) {
      const normalizedBaselineName = sanitizeArtifactToken(baselineName, 'baselineName');
      return readJsonFile(path.join(paths.evalBaselineRoot, `${normalizedBaselineName}.json`));
    },
  };
}
