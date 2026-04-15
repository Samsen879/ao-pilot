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
import { normalizeIssueIntake } from './issue-intake.js';
import { appendControlPlaneAuditEntry } from './state-audit.js';
import {
  ensureDirectory,
  readJsonFile,
  writeJsonFileAtomic,
} from './state-storage.js';

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
    'controller_leases',
    'actions',
    'overrides',
    'controller_modes',
    'observations',
    'delivery_events',
    'controller_cursors',
    'policy_decisions',
    'credential_provenances',
    'task_specs',
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

export function bootstrapControlPlaneState({
  repoRoot,
  projectId,
  now,
} = {}) {
  const paths = resolveControlPlanePaths({
    repoRoot,
    projectId,
  });
  ensureDirectory(paths.stateRoot);

  const existingSchema = readControlPlaneSchema({ schemaPath: paths.schemaPath });
  const existingState = readControlPlaneState({ statePath: paths.statePath });
  const timestamp = resolveNow(now);
  const effectiveCurrentVersion = existingSchema != null && existingState != null
    ? Number(existingSchema.current_version ?? 0)
    : 0;

  if (
    existingSchema != null
    && existingState != null
    && effectiveCurrentVersion >= CONTROL_PLANE_LATEST_VERSION
  ) {
    return {
      bootstrapped: true,
      migrated: false,
      state_root: paths.stateRoot,
      schema: existingSchema,
      state: existingState,
    };
  }

  let nextState = existingState;
  const priorMigrations = Array.isArray(existingSchema?.applied_migrations)
    ? existingSchema.applied_migrations.filter(
        (migration) => Number(migration?.version) <= effectiveCurrentVersion,
      )
    : [];
  const newAppliedMigrations = [];

  for (const migration of CONTROL_PLANE_MIGRATIONS) {
    if (migration.version <= effectiveCurrentVersion) continue;
    nextState = applyMigration({
      migration,
      projectId,
      now: timestamp,
      state: nextState,
    });
    newAppliedMigrations.push({
      version: migration.version,
      key: migration.key,
      applied_at: timestamp,
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

  writeJsonFileAtomic(paths.schemaPath, nextSchema);
  writeJsonFileAtomic(paths.statePath, nextState);

  for (const migration of CONTROL_PLANE_MIGRATIONS) {
    if (migration.version <= effectiveCurrentVersion) continue;
    const audit = buildAuditSummary(migration);
    appendControlPlaneAuditEntry({
      auditPath: paths.auditPath,
      entry: createControlPlaneAuditEntry({
        audit_id: `migration-${migration.version}`,
        project_id: projectId,
        recorded_at: timestamp,
        entity_kind: 'schema',
        entity_id: `v${migration.version}`,
        operation: audit.operation,
        actor: 'bootstrap',
        summary: audit.summary,
        details: {
          migration_key: migration.key,
          migration_version: migration.version,
        },
      }),
    });
  }

  return {
    bootstrapped: true,
    migrated: newAppliedMigrations.length > 0,
    state_root: paths.stateRoot,
    schema: nextSchema,
    state: nextState,
  };
}
