import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CONTROL_PLANE_LATEST_VERSION,
  createControlPlaneAuditEntry,
  createControlPlaneSchema,
  createControllerLease,
  createEmptyControlPlaneState,
  createRepoKnowledgeRecord,
  createRuntimePreflightRecord,
} from './state-contracts.js';
import {
  createControllerLeaseAuthority,
  readControllerLeaseAuthorityFile,
} from './controller-lease-authority.js';
import { materializeRepoKnowledge } from './repo-knowledge.js';
import { runRuntimeBootstrapPreflight } from './runtime-preflight.js';
import {
  createRepositoryCollectionUpsertMethods,
  sortRepositoryCollectionByKey,
  sortRepositoryStateCollections,
  upsertRepositoryCollectionRecord,
} from './state-repository/collections.js';
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
  const stateWriteLockPath = paths.stateWriteLockPath;

  function readControllerLeaseRecords() {
    return readControllerLeaseAuthorityFile(paths.controllerLeasesPath).records;
  }

  function readSnapshot() {
    const schema = readControlPlaneSchema({ schemaPath: paths.schemaPath });
    const state = readControlPlaneState({ statePath: paths.statePath });

    if (!schema && !state) {
      if (fs.existsSync(paths.controllerLeasesPath)) {
        const isolatedControllerLeases = readControllerLeaseRecords();
        return {
          bootstrapped: false,
          schema: buildVirtualSchema(projectId),
          state: sortRepositoryStateCollections(buildVirtualState(projectId), {
            controllerLeases: isolatedControllerLeases,
          }),
          paths,
        };
      }
      if (fs.existsSync(paths.stateRoot)) {
        throw new Error('Incomplete control-plane state evidence: orphaned state root has no schema.json or state.json');
      }
      return {
        bootstrapped: false,
        schema: buildVirtualSchema(projectId),
        state: buildVirtualState(projectId),
        paths,
      };
    }

    if (!schema || !state) {
      throw new Error('Incomplete control-plane state evidence: schema.json and state.json are both required');
    }

    if (Number(schema.current_version ?? 0) < CONTROL_PLANE_LATEST_VERSION) {
      bootstrapControlPlaneState({ repoRoot, projectId, now: clock });
      return readSnapshot();
    }

    const isolatedControllerLeases = readControllerLeaseRecords();
    const nextState = sortRepositoryStateCollections(cloneJsonValue(state), {
      controllerLeases: isolatedControllerLeases,
    });

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
    delete nextState.controller_leases;
    nextState.updated_at = recordedAt;
    withFileLockSync(stateWriteLockPath, () => {
      writeJsonFileAtomic(paths.statePath, nextState);
    });
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
    const nextControllerLeases = sortRepositoryCollectionByKey(
      (controllerLeases ?? []).map((record) => createControllerLease(record)),
      'lease_id',
    );
    writeJsonFileAtomic(
      paths.controllerLeasesPath,
      createControllerLeaseAuthority(nextControllerLeases),
    );
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
    descriptor,
    record,
  } = {}) {
    ensureBootstrapped();
    const snapshot = readSnapshot();
    const nextState = cloneJsonValue(snapshot.state);
    const normalizedRecord = upsertRepositoryCollectionRecord({
      state: nextState,
      descriptor,
      record,
    });

    persistState({
      state: nextState,
      entityKind: descriptor.entityKind,
      entityId: normalizedRecord[descriptor.identityKey],
      summary: descriptor.summary(record, normalizedRecord),
      details: normalizedRecord,
    });

    return normalizedRecord;
  }

  const collectionUpsertMethods = createRepositoryCollectionUpsertMethods(upsertCollectionRecord);

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

    ...collectionUpsertMethods,

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

      return sortRepositoryCollectionByKey(ensuredRecords, 'runtime_ref');
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
