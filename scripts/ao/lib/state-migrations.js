import fs from 'node:fs';
import path from 'node:path';

import {
  CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  CONTROL_PLANE_LATEST_VERSION,
  createControlPlaneAuditEntry,
  createControlPlaneSchema,
  createControllerModeRecord,
  createEmptyControlPlaneState,
  createTaskSpecRecord,
} from './state-contracts.js';
import {
  createControllerLeaseAuthority,
  digestControllerLeaseAuthorityEvidence,
  normalizeControllerLeaseRecords,
  parseControllerLeaseAuthority,
  readControllerLeaseAuthorityFile,
} from './controller-lease-authority.js';
import { normalizeIssueIntake } from './issue-intake.js';
import { appendControlPlaneAuditEntry, readControlPlaneAuditEntries } from './state-audit.js';
import {
  ensureDirectory,
  readJsonFile,
  withFileLockSync,
  writeJsonFileAtomic,
} from './state-storage.js';

const CONTROLLER_LEASE_MIGRATION_RECEIPT_SCHEMA_VERSION = 'ao.controller-lease-migration-receipt.v1';
const CONTROL_PLANE_BOOTSTRAP_PROVENANCE_SCHEMA_VERSION = 'ao.control-plane-bootstrap-provenance.v1';
const CONTROLLER_LEASE_MIGRATION_AUDIT_CHECKPOINT_SCHEMA_VERSION = 'ao.controller-lease-migration-audit-checkpoint.v1';

export const CONTROL_PLANE_BOOTSTRAP_MIGRATION = {
  version: 1,
  key: '0001_bootstrap_control_plane_v1',
};

export const CONTROL_PLANE_TASK_SPEC_MIGRATION = {
  version: 2,
  key: '0002_task_spec_v1',
};

export const CONTROL_PLANE_DELIVERY_EVENTS_MIGRATION = {
  version: 3,
  key: '0003_delivery_events_v1',
};

export const CONTROL_PLANE_POLICY_ENGINE_MIGRATION = {
  version: 4,
  key: '0004_policy_engine_v1',
};

export const CONTROL_PLANE_RUNTIME_PREFLIGHT_MIGRATION = {
  version: 5,
  key: '0005_runtime_preflight_v1',
};

export const CONTROL_PLANE_CHECKPOINT_MIGRATION = {
  version: 6,
  key: '0006_checkpoint_v1',
};

export const CONTROL_PLANE_HANDOFF_PROTOCOL_MIGRATION = {
  version: 7,
  key: '0007_handoff_protocol_v1',
};

export const CONTROL_PLANE_MEASUREMENT_METRICS_MIGRATION = {
  version: 8,
  key: '0008_measurement_metrics_v1',
};

export const CONTROL_PLANE_REPO_KNOWLEDGE_MIGRATION = {
  version: 9,
  key: '0009_repo_knowledge_v1',
};

export const CONTROL_PLANE_REVIEW_GATE_MIGRATION = {
  version: 10,
  key: '0010_review_gate_v1',
};

export const CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION = {
  version: 11,
  key: '0011_controller_lease_authority_v1',
};

export const CONTROL_PLANE_TASK_RELATIONS_MIGRATION = {
  version: 12,
  key: '0012_task_relations_v1alpha1',
};

export const CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION = {
  version: 13,
  key: '0013_completion_records_v1alpha1',
};

const CONTROL_PLANE_MIGRATIONS = [
  CONTROL_PLANE_BOOTSTRAP_MIGRATION,
  CONTROL_PLANE_TASK_SPEC_MIGRATION,
  CONTROL_PLANE_DELIVERY_EVENTS_MIGRATION,
  CONTROL_PLANE_POLICY_ENGINE_MIGRATION,
  CONTROL_PLANE_RUNTIME_PREFLIGHT_MIGRATION,
  CONTROL_PLANE_CHECKPOINT_MIGRATION,
  CONTROL_PLANE_HANDOFF_PROTOCOL_MIGRATION,
  CONTROL_PLANE_MEASUREMENT_METRICS_MIGRATION,
  CONTROL_PLANE_REPO_KNOWLEDGE_MIGRATION,
  CONTROL_PLANE_REVIEW_GATE_MIGRATION,
  CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION,
  CONTROL_PLANE_TASK_RELATIONS_MIGRATION,
  CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION,
];

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeProjectId(projectId) {
  if (typeof projectId !== 'string') {
    throw new Error('Invalid projectId');
  }

  const normalizedProjectId = projectId.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(normalizedProjectId)) {
    throw new Error('Invalid projectId');
  }

  return normalizedProjectId;
}

function buildDefaultControllerMode(now) {
  return createControllerModeRecord({
    controller_id: CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
    mode: 'off',
    updated_at: now,
    updated_by: 'bootstrap',
    reason: 'Initialized repo-local AO control-plane state.',
  });
}

function buildBootstrapState({
  projectId,
  now,
  existingState,
} = {}) {
  const state = createEmptyControlPlaneState({
    project_id: projectId,
    created_at: existingState?.created_at ?? now,
    updated_at: now,
  });

  for (const collectionKey of [
    'managed_tasks',
    'pr_bindings',
    'ownership_leases',
    'actions',
    'overrides',
    'controller_modes',
    'observations',
    'delivery_events',
    'controller_cursors',
    'policy_decisions',
    'credential_provenances',
    'task_specs',
    'task_relations',
    'completion_records',
    'runtime_preflights',
    'repo_knowledge',
    'review_records',
    'checkpoints',
    'handoff_requests',
    'handoff_claims',
    'handoff_decisions',
    'handoff_transfers',
    'controller_run_metrics',
    'execution_attempt_metrics',
  ]) {
    if (Array.isArray(existingState?.[collectionKey])) {
      state[collectionKey] = cloneJsonValue(existingState[collectionKey]);
    }
  }

  if (!state.controller_modes.length) {
    state.controller_modes.push(buildDefaultControllerMode(now));
  }

  return state;
}

function removeControllerLeaseShadow(state) {
  const nextState = state;
  delete nextState.controller_leases;
  return nextState;
}

function backfillTaskSpecs({
  state,
  now,
} = {}) {
  const nextState = buildBootstrapState({
    projectId: state?.project_id,
    now,
    existingState: state,
  });

  const existingTaskIds = new Set((nextState.task_specs ?? []).map((record) => record?.task_id));
  for (const task of nextState.managed_tasks ?? []) {
    if (!task?.task_id || existingTaskIds.has(task.task_id)) continue;

    const { task_spec_snapshot: taskSpecSnapshot } = normalizeIssueIntake({
      issueNumber: task.issue_number ?? null,
      title: task.title ?? null,
      body: task?.metadata?.task_spec_body ?? task?.metadata?.issue_body ?? '',
      sourceKind: 'migration_backfill',
    });
    nextState.task_specs.push(createTaskSpecRecord({
      task_id: task.task_id,
      source_kind: 'migration_backfill',
      source_issue_number: task.issue_number ?? null,
      created_at: now,
      updated_at: now,
      snapshot: taskSpecSnapshot,
    }));
  }

  nextState.updated_at = now;
  return nextState;
}

function applyMigration({
  migration,
  projectId,
  now,
  state,
} = {}) {
  if (migration.version === CONTROL_PLANE_BOOTSTRAP_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_TASK_SPEC_MIGRATION.version) {
    return backfillTaskSpecs({
      state: buildBootstrapState({
        projectId,
        now,
        existingState: state,
      }),
      now,
    });
  }

  if (migration.version === CONTROL_PLANE_DELIVERY_EVENTS_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_POLICY_ENGINE_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_RUNTIME_PREFLIGHT_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_CHECKPOINT_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_HANDOFF_PROTOCOL_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_MEASUREMENT_METRICS_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_REPO_KNOWLEDGE_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_REVIEW_GATE_MIGRATION.version) {
    return buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
  }

  if (migration.version === CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version) {
    return removeControllerLeaseShadow(buildBootstrapState({
      projectId,
      now,
      existingState: state,
    }));
  }

  if (migration.version === CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
    if (
      Object.hasOwn(state ?? {}, 'task_relations')
      && (!Array.isArray(state.task_relations) || state.task_relations.length > 0)
    ) {
      throw new Error('Pre-v12 task_relations evidence is not authoritative and cannot be migrated');
    }
    const nextState = buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
    removeControllerLeaseShadow(nextState);
    nextState.task_relations = [];
    return nextState;
  }

  if (migration.version === CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version) {
    if (!Array.isArray(state?.task_relations)) {
      throw new Error('Pre-v13 state is missing authoritative task_relations evidence');
    }
    if (
      Object.hasOwn(state ?? {}, 'completion_records')
      && (!Array.isArray(state.completion_records) || state.completion_records.length > 0)
    ) {
      throw new Error(
        'Pre-v13 completion_records evidence is not authoritative and cannot be migrated',
      );
    }
    const nextState = buildBootstrapState({
      projectId,
      now,
      existingState: state,
    });
    removeControllerLeaseShadow(nextState);
    nextState.completion_records = [];
    return nextState;
  }

  throw new Error(`Unsupported migration version ${migration.version}`);
}

function buildAuditSummary(migration) {
  if (migration.version === CONTROL_PLANE_BOOTSTRAP_MIGRATION.version) {
    return {
      operation: 'bootstrap',
      summary: 'Applied control-plane bootstrap migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_DELIVERY_EVENTS_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane delivery-event migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_POLICY_ENGINE_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane policy-engine migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_RUNTIME_PREFLIGHT_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane runtime-preflight migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_CHECKPOINT_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane checkpoint migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_HANDOFF_PROTOCOL_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane handoff-protocol migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_MEASUREMENT_METRICS_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane measurement-metrics migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_REPO_KNOWLEDGE_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane repo-knowledge migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_REVIEW_GATE_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane review-gate migration.',
    };
  }

  if (migration.version === CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied canonical controller-lease authority migration.',
    };
  }


  if (migration.version === CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane task-relations migration.',
    };
  }
  if (migration.version === CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version) {
    return {
      operation: 'migrate',
      summary: 'Applied control-plane Completion Record migration.',
    };
  }

  return {
    operation: 'migrate',
    summary: 'Applied control-plane task-spec migration.',
  };
}

export function resolveControlPlanePaths({
  repoRoot,
  projectId,
} = {}) {
  const normalizedRepoRoot = path.resolve(String(repoRoot));
  const normalizedProjectId = normalizeProjectId(projectId);
  const stateRoot = path.join(normalizedRepoRoot, '.ao-control-plane', normalizedProjectId);

  return {
    repoRoot: normalizedRepoRoot,
    stateRoot,
    schemaPath: path.join(stateRoot, 'schema.json'),
    statePath: path.join(stateRoot, 'state.json'),
    controllerLeasesPath: path.join(stateRoot, 'controller-leases.json'),
    controllerLeaseMigrationReceiptPath: path.join(stateRoot, 'controller-lease-migration-receipt.json'),
    controllerLeaseMigrationAuditCheckpointPath: path.join(stateRoot, 'controller-lease-migration-audit-checkpoint.json'),
    bootstrapProvenancePath: path.join(stateRoot, 'bootstrap-provenance.json'),
    bootstrapInitializationLockPath: path.join(
      normalizedRepoRoot,
      '.ao-control-plane',
      `.${normalizedProjectId}.bootstrap.lock`,
    ),
    stateWriteLockPath: path.join(stateRoot, 'state.json.lock'),
    stateMutationJournalPath: path.join(stateRoot, 'state-mutation-journal.json'),
    auditPath: path.join(stateRoot, 'audit-log.jsonl'),
    evalRoot: path.join(stateRoot, 'eval'),
    evalScorecardRoot: path.join(stateRoot, 'eval', 'scorecards'),
    evalBaselineRoot: path.join(stateRoot, 'eval', 'baselines'),
    latestEvalScorecardPath: path.join(stateRoot, 'eval', 'latest.json'),
    operatorEvalRoot: path.join(normalizedRepoRoot, 'ao-artifacts', 'ao-eval'),
    operatorEvalScorecardRoot: path.join(normalizedRepoRoot, 'ao-artifacts', 'ao-eval', 'scorecards'),
    operatorEvalBaselineRoot: path.join(normalizedRepoRoot, 'ao-artifacts', 'ao-eval', 'baselines'),
    operatorLatestEvalScorecardPath: path.join(normalizedRepoRoot, 'ao-artifacts', 'ao-eval', 'latest.json'),
  };
}

export function readControlPlaneSchema({ schemaPath } = {}) {
  return readJsonFile(schemaPath);
}

export function readControlPlaneState({ statePath } = {}) {
  return readJsonFile(statePath);
}

function prepareControllerLeaseAuthorityMigration({
  paths,
  existingSchema,
  existingState,
  allowFreshInitialization = false,
} = {}) {
  if (fs.existsSync(paths.controllerLeasesPath)) {
    const sourcePayload = readJsonFile(paths.controllerLeasesPath);
    const sourceSchemaVersion = Number(existingSchema?.current_version ?? 0);
    const envelope = Array.isArray(sourcePayload)
      ? createControllerLeaseAuthority(normalizeControllerLeaseRecords(sourcePayload))
      : parseControllerLeaseAuthority(sourcePayload);
    if (Array.isArray(sourcePayload) && sourceSchemaVersion >= CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version) {
      throw new Error('Unsupported canonical controller lease authority: unversioned arrays are legacy migration evidence only');
    }
    return {
      envelope,
      source: Array.isArray(sourcePayload)
        ? 'legacy_canonical_array_migration'
        : 'existing_canonical_authority',
      source_evidence_digest: digestControllerLeaseAuthorityEvidence(sourcePayload),
      state_shadow_removed: Object.hasOwn(existingState ?? {}, 'controller_leases'),
    };
  }

  if (allowFreshInitialization) {
    const envelope = createControllerLeaseAuthority([]);
    return {
      envelope,
      source: 'fresh_state_provenance',
      source_evidence_digest: digestControllerLeaseAuthorityEvidence({
        provenance: 'new_state_root',
      }),
      state_shadow_removed: false,
    };
  }

  if (!Object.hasOwn(existingState ?? {}, 'controller_leases')) {
    throw new Error(
      'Missing canonical controller lease authority and no explicit migration evidence is available',
    );
  }

  const sourceRecords = normalizeControllerLeaseRecords(existingState.controller_leases);
  return {
    envelope: createControllerLeaseAuthority(sourceRecords),
    source: 'legacy_state_shadow_migration',
    source_evidence_digest: digestControllerLeaseAuthorityEvidence(existingState.controller_leases),
    state_shadow_removed: true,
  };
}

function validateCurrentControllerLeaseAuthority(paths) {
  return readControllerLeaseAuthorityFile(paths.controllerLeasesPath);
}

function assertNoControllerLeaseShadow(state) {
  if (Object.hasOwn(state ?? {}, 'controller_leases')) {
    throw new Error('Prohibited controller_leases shadow detected in v11 state.json');
  }
}

function createBootstrapProvenance({ projectId, status, now, source }) {
  return {
    schema_version: CONTROL_PLANE_BOOTSTRAP_PROVENANCE_SCHEMA_VERSION,
    format: 'ao_control_plane_bootstrap_provenance',
    project_id: projectId,
    status,
    source,
    recorded_at: now,
  };
}

function readBootstrapProvenance(paths, projectId) {
  const provenance = readJsonFile(paths.bootstrapProvenancePath);
  if (provenance == null) return null;
  if (
    provenance.schema_version !== CONTROL_PLANE_BOOTSTRAP_PROVENANCE_SCHEMA_VERSION
    || provenance.format !== 'ao_control_plane_bootstrap_provenance'
    || provenance.project_id !== projectId
    || !['initializing', 'complete'].includes(provenance.status)
    || !['fresh_state_root', 'legacy_migration'].includes(provenance.source)
    || typeof provenance.recorded_at !== 'string'
    || provenance.recorded_at.trim() === ''
  ) {
    throw new Error('Malformed control-plane bootstrap provenance');
  }
  return provenance;
}

function createControllerLeaseMigrationReceipt({
  projectId,
  migration,
  sourceSchemaVersion,
  sourceStateDigest,
  legacyWriterQuiescence,
  now,
}) {
  const receipt = {
    schema_version: CONTROLLER_LEASE_MIGRATION_RECEIPT_SCHEMA_VERSION,
    format: 'ao_controller_lease_migration_receipt',
    project_id: projectId,
    migration_key: CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.key,
    source_schema_version: sourceSchemaVersion,
    destination_schema_version: CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version,
    authority_source: migration.source,
    source_evidence_digest: migration.source_evidence_digest,
    destination_authority_digest: digestControllerLeaseAuthorityEvidence(migration.envelope),
    controller_lease_count: migration.envelope.records.length,
    state_shadow_removed: migration.state_shadow_removed,
    source_state_digest: sourceStateDigest,
    state_write_fence: 'state.json.lock+sha256_cas',
    legacy_writer_quiescence: legacyWriterQuiescence,
    recorded_at: now,
  };
  return {
    ...receipt,
    receipt_integrity_digest: digestControllerLeaseAuthorityEvidence(receipt),
  };
}

function readControllerLeaseMigrationReceipt(
  paths,
  envelope,
  projectId,
  { validateDestination = true } = {},
) {
  const receipt = readJsonFile(paths.controllerLeaseMigrationReceiptPath);
  if (receipt == null) return null;
  const { receipt_integrity_digest: integrityDigest, ...receiptEvidence } = receipt;
  if (
    receipt.schema_version !== CONTROLLER_LEASE_MIGRATION_RECEIPT_SCHEMA_VERSION
    || receipt.format !== 'ao_controller_lease_migration_receipt'
    || receipt.project_id !== projectId
    || receipt.migration_key !== CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.key
    || receipt.destination_schema_version !== CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version
    || typeof receipt.source_evidence_digest !== 'string'
    || typeof receipt.source_state_digest !== 'string'
    || receipt.state_write_fence !== 'state.json.lock+sha256_cas'
    || !['not_required', 'verified'].includes(receipt.legacy_writer_quiescence?.result)
    || typeof receipt.legacy_writer_quiescence?.verified_at !== 'string'
    || receipt.legacy_writer_quiescence?.evidence !== 'no_unexpired_active_controller_leases'
    || integrityDigest !== digestControllerLeaseAuthorityEvidence(receiptEvidence)
  ) {
    throw new Error('Malformed controller lease authority migration receipt');
  }
  const authorityDigest = digestControllerLeaseAuthorityEvidence(envelope);
  if (validateDestination && receipt.destination_authority_digest !== authorityDigest) {
    throw new Error('Controller lease authority migration receipt destination digest mismatch');
  }
  return receipt;
}

function verifyLegacyWriterQuiescence({ records, sourceSchemaVersion, now }) {
  const result = sourceSchemaVersion > 0 ? 'verified' : 'not_required';
  if (sourceSchemaVersion > 0) {
    const timestampMs = new Date(now).getTime();
    const liveLegacyLease = records.find((record) => (
      record.status === 'active'
      && new Date(record.expires_at).getTime() > timestampMs
    ));
    if (liveLegacyLease) {
      throw new Error(
        `Legacy controller writer quiescence required before v11 migration: stop controller lease ${liveLegacyLease.lease_id} and wait for expiry or obtain a human-approved shutdown`,
      );
    }
  }
  return {
    result,
    verified_at: now,
    evidence: 'no_unexpired_active_controller_leases',
  };
}

function createMigrationAuditCheckpoint({ projectId, receipt, status }) {
  return {
    schema_version: CONTROLLER_LEASE_MIGRATION_AUDIT_CHECKPOINT_SCHEMA_VERSION,
    format: 'ao_controller_lease_migration_audit_checkpoint',
    project_id: projectId,
    migration_key: CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.key,
    audit_id: `migration-${CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version}`,
    receipt_digest: digestControllerLeaseAuthorityEvidence(receipt),
    status,
    recorded_at: receipt.recorded_at,
  };
}

function readMigrationAuditCheckpoint(paths, projectId, receipt) {
  const checkpoint = readJsonFile(paths.controllerLeaseMigrationAuditCheckpointPath);
  if (checkpoint == null) return null;
  if (
    checkpoint.schema_version !== CONTROLLER_LEASE_MIGRATION_AUDIT_CHECKPOINT_SCHEMA_VERSION
    || checkpoint.format !== 'ao_controller_lease_migration_audit_checkpoint'
    || checkpoint.project_id !== projectId
    || checkpoint.migration_key !== CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.key
    || checkpoint.audit_id !== `migration-${CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version}`
    || checkpoint.receipt_digest !== digestControllerLeaseAuthorityEvidence(receipt)
    || !['pending', 'complete'].includes(checkpoint.status)
    || checkpoint.recorded_at !== receipt.recorded_at
  ) {
    throw new Error('Malformed controller lease migration audit checkpoint');
  }
  return checkpoint;
}

function claimFreshStateRoot({ paths, projectId, now, timeoutMs, retryMs }) {
  return withFileLockSync(paths.bootstrapInitializationLockPath, () => {
    if (fs.existsSync(paths.stateRoot)) return false;
    ensureDirectory(path.dirname(paths.stateRoot));
    const stagingRoot = fs.mkdtempSync(`${paths.stateRoot}.initializing-`);
    writeJsonFileAtomic(
      path.join(stagingRoot, path.basename(paths.bootstrapProvenancePath)),
      createBootstrapProvenance({
        projectId,
        status: 'initializing',
        source: 'fresh_state_root',
        now,
      }),
    );
    fs.renameSync(stagingRoot, paths.stateRoot);
    return true;
  }, { timeoutMs, retryMs });
}

function buildControllerLeaseMigrationAuditDetails(receipt) {
  return {
    canonical_authority: 'controller-leases.json',
    migration_receipt_digest: digestControllerLeaseAuthorityEvidence(receipt),
    ...receipt,
  };
}

function resolveAppliedMigration(schema, migration) {
  const matching = (schema?.applied_migrations ?? []).filter(
    (entry) => Number(entry?.version) === migration.version,
  );
  const [applied] = matching;
  if (
    matching.length !== 1
    || applied?.key !== migration.key
    || typeof applied?.applied_at !== 'string'
  ) {
    throw new Error(`Missing or malformed applied migration evidence for ${migration.key}`);
  }
  return applied;
}

function assertTaskRelationsMigrationAuditEntry(entry, { projectId, recordedAt }) {
  let normalizedEntry;
  try {
    normalizedEntry = createControlPlaneAuditEntry(entry);
  } catch {
    throw new Error('Malformed control-plane task-relations migration audit evidence');
  }
  if (
    JSON.stringify(normalizedEntry) !== JSON.stringify(entry)
    ||
    entry?.audit_id !== `migration-${CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version}`
    || entry.project_id !== projectId
    || entry.recorded_at !== recordedAt
    || entry.entity_kind !== 'schema'
    || entry.entity_id !== `v${CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version}`
    || entry.operation !== 'migrate'
    || entry.actor !== 'bootstrap'
    || entry.summary !== 'Applied control-plane task-relations migration.'
    || entry.details?.migration_key !== CONTROL_PLANE_TASK_RELATIONS_MIGRATION.key
    || entry.details?.migration_version !== CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version
  ) {
    throw new Error('Malformed control-plane task-relations migration audit evidence');
  }
}

function assertCompletionRecordsMigrationAuditEntry(entry, { projectId, recordedAt }) {
  let normalizedEntry;
  try {
    normalizedEntry = createControlPlaneAuditEntry(entry);
  } catch {
    throw new Error('Malformed control-plane Completion Record migration audit evidence');
  }
  if (
    JSON.stringify(normalizedEntry) !== JSON.stringify(entry)
    || entry?.audit_id !== `migration-${CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version}`
    || entry.project_id !== projectId
    || entry.recorded_at !== recordedAt
    || entry.entity_kind !== 'schema'
    || entry.entity_id !== `v${CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version}`
    || entry.operation !== 'migrate'
    || entry.actor !== 'bootstrap'
    || entry.summary !== 'Applied control-plane Completion Record migration.'
    || entry.details?.migration_key !== CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.key
    || entry.details?.migration_version !== CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version
  ) {
    throw new Error('Malformed control-plane Completion Record migration audit evidence');
  }
}

function resolveAdditiveMigrationAuditEntry({ entries, migration, projectId, recordedAt }) {
  const matching = entries.filter(
    (entry) => entry.audit_id === `migration-${migration.version}`,
  );
  if (matching.length > 1) {
    if (migration.version === CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
      throw new Error('Malformed control-plane task-relations migration audit evidence');
    }
    throw new Error('Malformed control-plane Completion Record migration audit evidence');
  }
  const [entry] = matching;
  if (entry == null) return null;
  const expectedRecordedAt = recordedAt ?? entry.recorded_at;
  if (migration.version === CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
    assertTaskRelationsMigrationAuditEntry(entry, { projectId, recordedAt: expectedRecordedAt });
  } else {
    assertCompletionRecordsMigrationAuditEntry(entry, {
      projectId,
      recordedAt: expectedRecordedAt,
    });
  }
  return entry;
}

function validateCurrentAdditiveMigrationEvidence({ paths, projectId, schema }) {
  const taskMigration = resolveAppliedMigration(
    schema,
    CONTROL_PLANE_TASK_RELATIONS_MIGRATION,
  );
  const completionMigration = resolveAppliedMigration(
    schema,
    CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION,
  );
  const entries = readControlPlaneAuditEntries({ auditPath: paths.auditPath });
  const taskAudit = resolveAdditiveMigrationAuditEntry({
    entries,
    migration: CONTROL_PLANE_TASK_RELATIONS_MIGRATION,
    projectId,
    recordedAt: taskMigration.applied_at,
  });
  const completionAudit = resolveAdditiveMigrationAuditEntry({
    entries,
    migration: CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION,
    projectId,
    recordedAt: completionMigration.applied_at,
  });
  return {
    taskMigration,
    taskAudit,
    completionMigration,
    completionAudit,
  };
}

function resolveMigrationAppliedAt({ paths, projectId, migration, fallback }) {
  if (![
    CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version,
    CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version,
  ].includes(migration.version)) return fallback;
  const existing = resolveAdditiveMigrationAuditEntry({
    entries: readControlPlaneAuditEntries({ auditPath: paths.auditPath }),
    migration,
    projectId,
  });
  if (existing == null) return fallback;
  return existing.recorded_at;
}

function ensureMigrationAuditEntry({ paths, projectId, migration, recordedAt, details = {} }) {
  const auditId = `migration-${migration.version}`;
  const auditEntries = readControlPlaneAuditEntries({ auditPath: paths.auditPath });
  let existing;
  if ([
    CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version,
    CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version,
  ].includes(migration.version)) {
    existing = resolveAdditiveMigrationAuditEntry({
      entries: auditEntries,
      migration,
      projectId,
      recordedAt,
    });
  } else {
    existing = auditEntries.find((entry) => entry.audit_id === auditId);
  }
  if (existing) {
    if (migration.version === CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version) {
      if (existing.details?.migration_receipt_digest !== details.migration_receipt_digest) {
        throw new Error('Controller lease migration audit receipt digest mismatch');
      }
    }
    if (migration.version === CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
      assertTaskRelationsMigrationAuditEntry(existing, { projectId, recordedAt });
    }
    if (migration.version === CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION.version) {
      assertCompletionRecordsMigrationAuditEntry(existing, { projectId, recordedAt });
    }
    return existing;
  }
  const audit = buildAuditSummary(migration);
  const entry = createControlPlaneAuditEntry({
    audit_id: auditId,
    project_id: projectId,
    recorded_at: recordedAt,
    entity_kind: 'schema',
    entity_id: `v${migration.version}`,
    operation: audit.operation,
    actor: 'bootstrap',
    summary: audit.summary,
    details: {
      migration_key: migration.key,
      migration_version: migration.version,
      ...details,
    },
  });
  appendControlPlaneAuditEntry({ auditPath: paths.auditPath, entry });
  return entry;
}

export function bootstrapControlPlaneState({
  repoRoot,
  projectId,
  now,
  controllerLeaseLockTimeoutMs = 1000,
  controllerLeaseLockRetryMs = 10,
} = {}) {
  const paths = resolveControlPlanePaths({
    repoRoot,
    projectId,
  });
  const initialTimestamp = resolveNow(now);
  const freshStateRootClaimed = claimFreshStateRoot({
    paths,
    projectId,
    now: initialTimestamp,
    timeoutMs: controllerLeaseLockTimeoutMs,
    retryMs: controllerLeaseLockRetryMs,
  });
  const controllerLeaseLockPath = `${paths.controllerLeasesPath}.lock`;

  const initialSchema = readControlPlaneSchema({ schemaPath: paths.schemaPath });
  const initialState = readControlPlaneState({ statePath: paths.statePath });
  if (
    initialSchema != null
    && initialState != null
    && Number(initialSchema.current_version ?? 0) >= CONTROL_PLANE_LATEST_VERSION
  ) {
    const additiveEvidence = validateCurrentAdditiveMigrationEvidence({
      paths,
      projectId,
      schema: initialSchema,
    });
    assertNoControllerLeaseShadow(initialState);
    const envelope = validateCurrentControllerLeaseAuthority(paths);
    const receipt = readControllerLeaseMigrationReceipt(paths, envelope, projectId, {
      validateDestination: false,
    });
    if (receipt == null) throw new Error('Missing controller lease authority migration receipt');
    const checkpoint = readMigrationAuditCheckpoint(paths, projectId, receipt);
    if (checkpoint?.status === 'complete') {
      if (additiveEvidence.taskAudit != null && additiveEvidence.completionAudit != null) {
        return {
          bootstrapped: true,
          migrated: false,
          state_root: paths.stateRoot,
          schema: initialSchema,
          state: initialState,
        };
      }
    }
  }

  return withFileLockSync(controllerLeaseLockPath, () => {
    const existingSchema = readControlPlaneSchema({ schemaPath: paths.schemaPath });
    const existingState = readControlPlaneState({ statePath: paths.statePath });
    const timestamp = initialTimestamp;
    const effectiveCurrentVersion = existingSchema != null && existingState != null
      ? Number(existingSchema.current_version ?? 0)
      : 0;
    const provenance = readBootstrapProvenance(paths, projectId);

    if ((existingSchema == null) !== (existingState == null)) {
      throw new Error('Incomplete control-plane migration evidence: schema.json and state.json are both required');
    }

    if (
      existingSchema != null
      && existingState != null
      && effectiveCurrentVersion >= CONTROL_PLANE_LATEST_VERSION
    ) {
      const additiveEvidence = validateCurrentAdditiveMigrationEvidence({
        paths,
        projectId,
        schema: existingSchema,
      });
      assertNoControllerLeaseShadow(existingState);
      const envelope = validateCurrentControllerLeaseAuthority(paths);
      const receipt = readControllerLeaseMigrationReceipt(paths, envelope, projectId, {
        validateDestination: false,
      });
      if (receipt == null) {
        throw new Error('Missing controller lease authority migration receipt');
      }
      const checkpoint = readMigrationAuditCheckpoint(paths, projectId, receipt);
      if (checkpoint == null) {
        const auditEntry = readControlPlaneAuditEntries({ auditPath: paths.auditPath })
          .find((entry) => entry.audit_id === `migration-${CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version}`);
        if (
          auditEntry?.details?.migration_receipt_digest
          !== digestControllerLeaseAuthorityEvidence(receipt)
        ) {
          throw new Error('Missing independently validated controller lease migration audit checkpoint');
        }
        writeJsonFileAtomic(
          paths.controllerLeaseMigrationAuditCheckpointPath,
          createMigrationAuditCheckpoint({ projectId, receipt, status: 'complete' }),
        );
      } else if (checkpoint.status === 'pending') {
        ensureMigrationAuditEntry({
          paths,
          projectId,
          migration: CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION,
          recordedAt: receipt.recorded_at,
          details: buildControllerLeaseMigrationAuditDetails(receipt),
        });
        writeJsonFileAtomic(
          paths.controllerLeaseMigrationAuditCheckpointPath,
          createMigrationAuditCheckpoint({ projectId, receipt, status: 'complete' }),
        );
      }
      ensureMigrationAuditEntry({
        paths,
        projectId,
        migration: CONTROL_PLANE_TASK_RELATIONS_MIGRATION,
        recordedAt: additiveEvidence.taskMigration.applied_at,
      });
      ensureMigrationAuditEntry({
        paths,
        projectId,
        migration: CONTROL_PLANE_COMPLETION_RECORDS_MIGRATION,
        recordedAt: additiveEvidence.completionMigration.applied_at,
      });
      return {
        bootstrapped: true,
        migrated: false,
        state_root: paths.stateRoot,
        schema: existingSchema,
        state: existingState,
      };
    }

    const coreStateMissing = existingSchema == null && existingState == null;
    const resumableFreshInitialization = provenance?.status === 'initializing'
      && provenance?.source === 'fresh_state_root';
    const allowFreshInitialization = coreStateMissing
      && (freshStateRootClaimed || resumableFreshInitialization);
    if (coreStateMissing && !allowFreshInitialization) {
      throw new Error(
        'Incomplete control-plane migration evidence: existing or orphaned state root cannot initialize empty authority',
      );
    }
    if (effectiveCurrentVersion >= CONTROL_PLANE_TASK_RELATIONS_MIGRATION.version) {
      resolveAppliedMigration(existingSchema, CONTROL_PLANE_TASK_RELATIONS_MIGRATION);
    }
    let controllerLeaseAuthorityMigration;
    let migrationReceipt = null;
    if (fs.existsSync(paths.controllerLeasesPath)) {
      const existingPayload = readJsonFile(paths.controllerLeasesPath);
      if (!Array.isArray(existingPayload)) {
        const existingEnvelope = parseControllerLeaseAuthority(existingPayload);
        migrationReceipt = readControllerLeaseMigrationReceipt(paths, existingEnvelope, projectId);
        if (migrationReceipt != null) {
          controllerLeaseAuthorityMigration = {
            envelope: existingEnvelope,
            source: migrationReceipt.authority_source,
            source_evidence_digest: migrationReceipt.source_evidence_digest,
            state_shadow_removed: migrationReceipt.state_shadow_removed,
          };
        }
      }
    }
    if (controllerLeaseAuthorityMigration == null) {
      controllerLeaseAuthorityMigration = prepareControllerLeaseAuthorityMigration({
        paths,
        existingSchema,
        existingState,
        allowFreshInitialization,
      });
    }

    let nextState = existingState;
    const priorMigrations = Array.isArray(existingSchema?.applied_migrations)
      ? existingSchema.applied_migrations.filter(
          (migration) => Number(migration?.version) <= effectiveCurrentVersion,
        )
      : [];
    const newAppliedMigrations = [];
    const migrationAppliedAt = new Map();

    for (const migration of CONTROL_PLANE_MIGRATIONS) {
      if (migration.version <= effectiveCurrentVersion) continue;
      const appliedAt = resolveMigrationAppliedAt({
        paths,
        projectId,
        migration,
        fallback: timestamp,
      });
      nextState = applyMigration({
        migration,
        projectId,
        now: appliedAt,
        state: nextState,
      });
      migrationAppliedAt.set(migration.version, appliedAt);
      newAppliedMigrations.push({
        version: migration.version,
        key: migration.key,
        applied_at: appliedAt,
      });
    }

    const nextSchema = createControlPlaneSchema({
      project_id: projectId,
      current_version: CONTROL_PLANE_LATEST_VERSION,
      latest_version: CONTROL_PLANE_LATEST_VERSION,
      created_at: existingSchema?.created_at ?? timestamp,
      updated_at: timestamp,
      applied_migrations: [...priorMigrations, ...newAppliedMigrations],
    });
    const sourceStateDigest = digestControllerLeaseAuthorityEvidence(existingState);
    const legacyWriterQuiescence = verifyLegacyWriterQuiescence({
      records: controllerLeaseAuthorityMigration.envelope.records,
      sourceSchemaVersion: effectiveCurrentVersion,
      now: timestamp,
    });
    migrationReceipt ??= createControllerLeaseMigrationReceipt({
      projectId,
      migration: controllerLeaseAuthorityMigration,
      sourceSchemaVersion: effectiveCurrentVersion,
      sourceStateDigest,
      legacyWriterQuiescence,
      now: timestamp,
    });

    writeJsonFileAtomic(paths.controllerLeasesPath, controllerLeaseAuthorityMigration.envelope);
    writeJsonFileAtomic(paths.controllerLeaseMigrationReceiptPath, migrationReceipt);
    writeJsonFileAtomic(
      paths.controllerLeaseMigrationAuditCheckpointPath,
      createMigrationAuditCheckpoint({ projectId, receipt: migrationReceipt, status: 'pending' }),
    );
    withFileLockSync(paths.stateWriteLockPath, () => {
      const currentStateDigest = digestControllerLeaseAuthorityEvidence(
        readControlPlaneState({ statePath: paths.statePath }),
      );
      if (currentStateDigest !== sourceStateDigest) {
        throw new Error('Legacy state writer changed state.json during v11 migration; quiescence not established');
      }
      writeJsonFileAtomic(paths.statePath, nextState);
    }, {
      timeoutMs: controllerLeaseLockTimeoutMs,
      retryMs: controllerLeaseLockRetryMs,
    });

    for (const migration of CONTROL_PLANE_MIGRATIONS) {
      if (migration.version <= effectiveCurrentVersion) continue;
      ensureMigrationAuditEntry({
        paths,
        projectId,
        migration,
        recordedAt: migrationAppliedAt.get(migration.version) ?? timestamp,
        details: migration.version === CONTROL_PLANE_CONTROLLER_LEASE_AUTHORITY_MIGRATION.version
          ? buildControllerLeaseMigrationAuditDetails(migrationReceipt)
          : {},
      });
    }

    writeJsonFileAtomic(
      paths.controllerLeaseMigrationAuditCheckpointPath,
      createMigrationAuditCheckpoint({ projectId, receipt: migrationReceipt, status: 'complete' }),
    );

    writeJsonFileAtomic(paths.schemaPath, nextSchema);
    assertNoControllerLeaseShadow(readControlPlaneState({ statePath: paths.statePath }));
    writeJsonFileAtomic(paths.bootstrapProvenancePath, createBootstrapProvenance({
      projectId,
      status: 'complete',
      source: allowFreshInitialization ? 'fresh_state_root' : 'legacy_migration',
      now: timestamp,
    }));

    return {
      bootstrapped: true,
      migrated: newAppliedMigrations.length > 0,
      state_root: paths.stateRoot,
      schema: nextSchema,
      state: nextState,
    };
  }, {
    timeoutMs: controllerLeaseLockTimeoutMs,
    retryMs: controllerLeaseLockRetryMs,
  });
}

export const CONTROLLER_LEASE_AUTHORITY_BOOTSTRAP_BOUNDARY = true;
