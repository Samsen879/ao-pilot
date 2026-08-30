import { createHash, randomUUID } from 'node:crypto';
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
import {
  COMPLETION_DELIVERY_STATUSES,
  COMPLETION_RECORD_SCHEMA_VERSION,
  completionRecordId,
  normalizeCompletionRecord,
} from './completion-record-contracts.js';
import { materializeRepoKnowledge } from './repo-knowledge.js';
import { runRuntimeBootstrapPreflight } from './runtime-preflight.js';
import {
  STATE_REPOSITORY_COLLECTIONS,
  createRepositoryCollectionUpsertMethods,
  sortRepositoryCollectionByKey,
  sortRepositoryStateCollections,
  upsertRepositoryCollectionRecord,
} from './state-repository/collections.js';
import {
  assertTaskRelationGraphWrite,
  createTaskRelation,
  TASK_RELATION_KINDS,
} from './task-relations.js';
import {
  inspectTaskGraph,
  terminalEvidenceFromManagedTasks,
} from './task-graph.js';
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

const STATE_MUTATION_JOURNAL_SCHEMA_VERSION = 'ao.state-mutation-journal.v1';

function digestJsonValue(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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

function normalizeRelationId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Invalid relationId');
  }
  return value.trim();
}

const TASK_RELATION_COLLECTION = STATE_REPOSITORY_COLLECTIONS.find(
  (descriptor) => descriptor.collectionKey === 'task_relations',
);
const COMPLETION_RECORD_COLLECTION = STATE_REPOSITORY_COLLECTIONS.find(
  (descriptor) => descriptor.collectionKey === 'completion_records',
);

function compareCanonicalStrings(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function normalizeStoredTaskRelations(state) {
  if (!Array.isArray(state?.task_relations)) {
    throw new Error('Invalid durable task_relations collection');
  }
  const taskIds = new Set((state.managed_tasks ?? []).map((task) => task?.task_id));
  const normalizedRelations = [];
  const relationIds = new Set();
  for (const relation of state.task_relations) {
    const normalizedRelation = createTaskRelation(relation);
    if (relationIds.has(normalizedRelation.relation_id)) {
      throw new Error(`Duplicate durable task relation ${normalizedRelation.relation_id}`);
    }
    assertTaskRelationGraphWrite({
      relation: normalizedRelation,
      taskIds,
      existingRelations: normalizedRelations,
    });
    normalizedRelations.push(normalizedRelation);
    relationIds.add(normalizedRelation.relation_id);
  }
  return normalizedRelations;
}

function normalizeStoredCompletionRecords(state) {
  if (!Array.isArray(state?.completion_records)) {
    throw new Error('Missing or malformed durable completion_records collection');
  }
  const observedVersions = [...new Set(state.completion_records.map((record) => {
    if (typeof record?.schema_version !== 'string' || record.schema_version.trim() === '') {
      throw new Error('Missing Completion Record schema_version');
    }
    return record.schema_version;
  }))];
  if (observedVersions.length > 1) {
    throw new Error('Mixed Completion Record schema versions are unsupported');
  }
  if (observedVersions.some((version) => version !== COMPLETION_RECORD_SCHEMA_VERSION)) {
    throw new Error(`Unsupported Completion Record schema: ${observedVersions[0]}`);
  }

  const normalizedRecords = state.completion_records.map(normalizeCompletionRecord);
  const recordIds = new Set();
  const childTaskIds = new Set();
  const managedTaskIds = new Set((state.managed_tasks ?? []).map((task) => task?.task_id));
  for (const record of normalizedRecords) {
    if (recordIds.has(record.record_id) || childTaskIds.has(record.child_task_id)) {
      throw new Error(`Duplicate durable Completion Record identity ${record.record_id}`);
    }
    recordIds.add(record.record_id);
    childTaskIds.add(record.child_task_id);
    if (!managedTaskIds.has(record.child_task_id)) {
      throw new Error(`Durable Completion Record references unknown managed child ${record.child_task_id}`);
    }
  }
  return normalizedRecords.sort((left, right) => (
    compareCanonicalStrings(left.record_id, right.record_id)
  ));
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

  function recoverPendingStateMutation({ stateLockHeld = false } = {}) {
    if (!fs.existsSync(paths.stateMutationJournalPath)) return;
    const recover = () => {
      const journal = readJsonFile(paths.stateMutationJournalPath);
      if (journal == null) return;
      if (
        journal?.schema_version !== STATE_MUTATION_JOURNAL_SCHEMA_VERSION
        || journal.project_id !== projectId
        || journal.next_state == null
        || journal.next_state_digest !== digestJsonValue(journal.next_state)
        || typeof journal.prior_state_digest !== 'string'
        || journal.audit_entry?.project_id !== projectId
      ) {
        throw new Error('Malformed state mutation recovery journal');
      }
      const normalizedAuditEntry = createControlPlaneAuditEntry(journal.audit_entry);
      if (JSON.stringify(normalizedAuditEntry) !== JSON.stringify(journal.audit_entry)) {
        throw new Error('Malformed state mutation recovery journal audit evidence');
      }
      const currentState = readJsonFile(paths.statePath);
      const currentDigest = digestJsonValue(currentState);
      if (currentDigest === journal.prior_state_digest) {
        writeJsonFileAtomic(paths.statePath, journal.next_state);
      } else if (currentDigest !== journal.next_state_digest) {
        throw new Error('State mutation recovery journal conflicts with durable state');
      }
      let auditEntries;
      try {
        auditEntries = readControlPlaneAuditEntries({ auditPath: paths.auditPath });
      } catch (error) {
        const auditText = fs.readFileSync(paths.auditPath, 'utf8');
        if (auditText.endsWith('\n')) throw error;
        const completeLines = auditText.split('\n');
        completeLines.pop();
        auditEntries = completeLines.filter(Boolean).map((line) => JSON.parse(line));
        const repairedText = auditEntries.length
          ? `${auditEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
          : '';
        fs.writeFileSync(paths.auditPath, repairedText, 'utf8');
      }
      const existingAudit = auditEntries
        .find((entry) => entry.audit_id === normalizedAuditEntry.audit_id);
      if (existingAudit == null) {
        appendControlPlaneAuditEntry({ auditPath: paths.auditPath, entry: normalizedAuditEntry });
      } else if (JSON.stringify(existingAudit) !== JSON.stringify(normalizedAuditEntry)) {
        throw new Error('State mutation recovery journal conflicts with durable audit evidence');
      }
      fs.rmSync(paths.stateMutationJournalPath, { force: true });
    };
    if (stateLockHeld) recover();
    else withFileLockSync(stateWriteLockPath, recover);
  }

  function readSnapshot({ stateLockHeld = false, diagnosticTaskGraph = false } = {}) {
    recoverPendingStateMutation({ stateLockHeld });
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
      return readSnapshot({ diagnosticTaskGraph });
    }

    const isolatedControllerLeases = readControllerLeaseRecords();
    const taskGraphInspection = inspectTaskGraph({
      tasks: state.managed_tasks,
      relations: state.task_relations,
      terminalEvidence: terminalEvidenceFromManagedTasks(state.managed_tasks),
    });
    let normalizedTaskRelations;
    try {
      normalizedTaskRelations = normalizeStoredTaskRelations(state);
    } catch (error) {
      if (!diagnosticTaskGraph) throw error;
      normalizedTaskRelations = [];
      state.task_relations = [];
    }
    const normalizedCompletionRecords = normalizeStoredCompletionRecords(state);
    const nextState = sortRepositoryStateCollections(cloneJsonValue(state), {
      controllerLeases: isolatedControllerLeases,
    });
    nextState.task_relations = sortRepositoryCollectionByKey(
      normalizedTaskRelations,
      'relation_id',
    );
    nextState.completion_records = normalizedCompletionRecords;

    return {
      bootstrapped: true,
      schema,
      state: nextState,
      ...(diagnosticTaskGraph ? { task_graph_inspection: taskGraphInspection } : {}),
      paths,
    };
  }

  function ensureBootstrapped() {
    bootstrapControlPlaneState({
      repoRoot,
      projectId,
      now: clock,
    });
    recoverPendingStateMutation();
  }

  function persistState({
    state,
    entityKind,
    entityId,
    summary,
    details,
    operation = 'upsert',
    stateLockHeld = false,
  } = {}) {
    const recordedAt = resolveNow(clock);
    const nextState = cloneJsonValue(state);
    delete nextState.controller_leases;
    nextState.updated_at = recordedAt;
    const auditEntry = createControlPlaneAuditEntry({
      audit_id: auditIdGenerator(),
      project_id: projectId,
      recorded_at: recordedAt,
      entity_kind: entityKind,
      entity_id: entityId,
      operation,
      actor: 'state_repository',
      summary,
      details,
    });
    const writeState = () => {
      recoverPendingStateMutation({ stateLockHeld: true });
      const priorState = readJsonFile(paths.statePath);
      const existingAudit = readControlPlaneAuditEntries({ auditPath: paths.auditPath })
        .find((entry) => entry.audit_id === auditEntry.audit_id);
      if (existingAudit != null) {
        throw new Error(`Duplicate state mutation audit id ${auditEntry.audit_id}`);
      }
      writeJsonFileAtomic(paths.stateMutationJournalPath, {
        schema_version: STATE_MUTATION_JOURNAL_SCHEMA_VERSION,
        project_id: projectId,
        prior_state_digest: digestJsonValue(priorState),
        next_state_digest: digestJsonValue(nextState),
        next_state: nextState,
        audit_entry: auditEntry,
      });
      writeJsonFileAtomic(paths.statePath, nextState);
      appendControlPlaneAuditEntry({ auditPath: paths.auditPath, entry: auditEntry });
      fs.rmSync(paths.stateMutationJournalPath, { force: true });
    };
    if (stateLockHeld) writeState();
    else withFileLockSync(stateWriteLockPath, writeState);
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
    return withFileLockSync(stateWriteLockPath, () => {
      const snapshot = readSnapshot({ stateLockHeld: true });
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
        stateLockHeld: true,
      });

      return normalizedRecord;
    });
  }

  const collectionUpsertMethods = createRepositoryCollectionUpsertMethods(upsertCollectionRecord);

  function validateTaskRelationWrite(record, snapshot, { requireAbsent = false } = {}) {
    const normalizedRecord = createTaskRelation(record);
    const existingRecord = (snapshot.state.task_relations ?? []).find(
      (entry) => entry?.relation_id === normalizedRecord.relation_id,
    );
    if (requireAbsent && existingRecord) {
      throw new Error(`Task relation already exists: ${normalizedRecord.relation_id}`);
    }
    return assertTaskRelationGraphWrite({
      relation: normalizedRecord,
      taskIds: new Set((snapshot.state.managed_tasks ?? []).map((task) => task?.task_id)),
      existingRelations: snapshot.state.task_relations ?? [],
    });
  }

  function writeTaskRelation(record, { requireAbsent = false } = {}) {
    ensureBootstrapped();
    return withFileLockSync(stateWriteLockPath, () => {
      const snapshot = readSnapshot({ stateLockHeld: true });
      const normalizedRecord = validateTaskRelationWrite(record, snapshot, { requireAbsent });
      const nextState = cloneJsonValue(snapshot.state);
      upsertRepositoryCollectionRecord({
        state: nextState,
        descriptor: TASK_RELATION_COLLECTION,
        record: normalizedRecord,
      });
      persistState({
        state: nextState,
        entityKind: 'task_relation',
        entityId: normalizedRecord.relation_id,
        summary: `Persisted task relation ${normalizedRecord.relation_id}.`,
        details: normalizedRecord,
        stateLockHeld: true,
      });
      return normalizedRecord;
    });
  }

  function validateCompletionRecordWrite(record, snapshot, { operation }) {
    const normalizedRecord = normalizeCompletionRecord(record);
    const existingRecord = snapshot.state.completion_records.find(
      (entry) => entry.record_id === normalizedRecord.record_id,
    );
    const knownChild = snapshot.state.managed_tasks.some(
      (task) => task.task_id === normalizedRecord.child_task_id,
    );
    if (!knownChild) {
      throw new Error(`Completion Record references unknown managed child ${normalizedRecord.child_task_id}`);
    }

    if (operation === 'create') {
      if (existingRecord) {
        throw new Error(`Completion Record already exists: ${normalizedRecord.record_id}`);
      }
      return normalizedRecord;
    }

    if (!existingRecord) {
      throw new Error(`Completion Record does not exist: ${normalizedRecord.record_id}`);
    }
    const generationChanged = [
      'generator_ref',
      'generation_inputs',
      'generation_inputs_digest',
      'artifact',
    ].some((field) => (
      JSON.stringify(existingRecord[field]) !== JSON.stringify(normalizedRecord[field])
    ));
    if (generationChanged) {
      if (JSON.stringify(normalizedRecord.prior_artifact) !== JSON.stringify(existingRecord.artifact)) {
        throw new Error('Regenerated Completion Record requires prior_artifact matching the durable artifact');
      }
    } else if (
      JSON.stringify(normalizedRecord.prior_artifact ?? null)
      !== JSON.stringify(existingRecord.prior_artifact ?? null)
    ) {
      throw new Error('Completion Record prior_artifact can change only during regeneration');
    }
    return normalizedRecord;
  }

  function writeCompletionRecord(record, { operation }) {
    ensureBootstrapped();
    return withFileLockSync(stateWriteLockPath, () => {
      const snapshot = readSnapshot({ stateLockHeld: true });
      const normalizedRecord = validateCompletionRecordWrite(record, snapshot, { operation });
      const nextState = cloneJsonValue(snapshot.state);
      upsertRepositoryCollectionRecord({
        state: nextState,
        descriptor: COMPLETION_RECORD_COLLECTION,
        record: normalizedRecord,
      });
      nextState.completion_records = normalizeStoredCompletionRecords(nextState);
      persistState({
        state: nextState,
        entityKind: 'completion_record',
        entityId: normalizedRecord.record_id,
        operation,
        summary: `${operation === 'create' ? 'Created' : 'Updated'} Completion Record ${normalizedRecord.record_id}.`,
        details: normalizedRecord,
        stateLockHeld: true,
      });
      return normalizedRecord;
    });
  }

  return {
    getSnapshot() {
      return readSnapshot();
    },

    getDiagnosticSnapshot() {
      return readSnapshot({ diagnosticTaskGraph: true });
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
      recoverPendingStateMutation();
      return readControlPlaneAuditEntries({
        auditPath: paths.auditPath,
        limit,
      });
    },

    ...collectionUpsertMethods,

    createCompletionRecord(record) {
      return writeCompletionRecord(record, { operation: 'create' });
    },

    updateCompletionRecord(record) {
      return writeCompletionRecord(record, { operation: 'update' });
    },

    getCompletionRecord(recordId) {
      if (typeof recordId !== 'string' || recordId.trim() !== recordId || recordId === '') {
        throw new Error('Invalid Completion Record identity');
      }
      return readSnapshot().state.completion_records.find(
        (record) => record.record_id === recordId,
      ) ?? null;
    },

    getCompletionRecordForChild(childTaskId) {
      const recordId = completionRecordId(childTaskId);
      return readSnapshot().state.completion_records.find(
        (record) => record.record_id === recordId,
      ) ?? null;
    },

    queryCompletionRecords({
      childTaskId = null,
      deliveryStatus = null,
      generatorRef = null,
    } = {}) {
      const recordId = childTaskId == null ? null : completionRecordId(childTaskId);
      if (deliveryStatus != null && !COMPLETION_DELIVERY_STATUSES.includes(deliveryStatus)) {
        throw new Error('Invalid Completion Record delivery status query');
      }
      if (
        generatorRef != null
        && (typeof generatorRef !== 'string' || generatorRef.trim() !== generatorRef || generatorRef === '')
      ) {
        throw new Error('Invalid Completion Record generator_ref query');
      }
      return readSnapshot().state.completion_records.filter((record) => (
        (recordId == null || record.record_id === recordId)
        && (deliveryStatus == null || record.delivery_status === deliveryStatus)
        && (generatorRef == null || record.generator_ref === generatorRef)
      ));
    },

    createTaskRelation(record) {
      return writeTaskRelation(record, { requireAbsent: true });
    },

    upsertTaskRelation(record) {
      return writeTaskRelation(record);
    },

    getTaskRelation(relationId) {
      const normalizedRelationId = normalizeRelationId(relationId);
      return readSnapshot().state.task_relations.find(
        (relation) => relation.relation_id === normalizedRelationId,
      ) ?? null;
    },

    listTaskRelations({
      taskId = null,
      relationKind = null,
      direction = 'any',
    } = {}) {
      if (!['any', 'outgoing', 'incoming'].includes(direction)) {
        throw new Error('Invalid task relation direction');
      }
      const normalizedTaskId = taskId == null ? null : normalizeRelationId(taskId);
      const normalizedRelationKind = relationKind == null ? null : String(relationKind).trim();
      if (normalizedRelationKind != null && !TASK_RELATION_KINDS.includes(normalizedRelationKind)) {
        throw new Error('Invalid task relation kind');
      }
      return readSnapshot().state.task_relations.filter((relation) => {
        if (normalizedRelationKind != null && relation.relation_kind !== normalizedRelationKind) return false;
        if (normalizedTaskId == null) return true;
        if (direction === 'outgoing') return relation.source_task_id === normalizedTaskId;
        if (direction === 'incoming') return relation.target_task_id === normalizedTaskId;
        return relation.source_task_id === normalizedTaskId || relation.target_task_id === normalizedTaskId;
      });
    },

    deleteTaskRelation(relationId) {
      const normalizedRelationId = normalizeRelationId(relationId);
      ensureBootstrapped();
      return withFileLockSync(stateWriteLockPath, () => {
        const snapshot = readSnapshot({ stateLockHeld: true });
        const existingRecord = snapshot.state.task_relations.find(
          (relation) => relation.relation_id === normalizedRelationId,
        );
        if (!existingRecord) return null;
        const nextState = cloneJsonValue(snapshot.state);
        nextState.task_relations = nextState.task_relations.filter(
          (relation) => relation.relation_id !== normalizedRelationId,
        );
        persistState({
          state: nextState,
          entityKind: 'task_relation',
          entityId: normalizedRelationId,
          operation: 'delete',
          summary: `Deleted task relation ${normalizedRelationId}.`,
          details: existingRecord,
          stateLockHeld: true,
        });
        return existingRecord;
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

    ensureRuntimePreflights({
      cwd = repoRoot,
      now = clock,
      runtimeRefs = null,
      probes = {},
    } = {}) {
      ensureBootstrapped();
      const timestamp = resolveNow(now);
      const snapshot = readSnapshot();
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
        const ensuredRecord = withFileLockSync(stateWriteLockPath, () => {
          const currentSnapshot = readSnapshot({ stateLockHeld: true });
          const existingRecord = (currentSnapshot.state.runtime_preflights ?? []).find(
            (record) => record?.runtime_ref === normalizedRecord.runtime_ref,
          );
          if (existingRecord?.replay_key === normalizedRecord.replay_key) {
            return existingRecord;
          }

          const nextState = cloneJsonValue(currentSnapshot.state);
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
            stateLockHeld: true,
          });
          return normalizedRecord;
        });
        ensuredRecords.push(ensuredRecord);
      }

      return sortRepositoryCollectionByKey(ensuredRecords, 'runtime_ref');
    },

    ensureRepoKnowledge({
      now = clock,
    } = {}) {
      ensureBootstrapped();
      const timestamp = resolveNow(now);
      const repoKnowledgeSnapshot = materializeRepoKnowledge({
        repoRoot,
        projectId,
        now: timestamp,
      });
      const normalizedRecord = createRepoKnowledgeRecord({
        recorded_at: timestamp,
        snapshot: repoKnowledgeSnapshot,
      });
      return withFileLockSync(stateWriteLockPath, () => {
        const snapshot = readSnapshot({ stateLockHeld: true });
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
          stateLockHeld: true,
        });

        return normalizedRecord;
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
