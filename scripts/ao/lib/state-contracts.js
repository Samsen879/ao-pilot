import { createRuntimePreflightSnapshot } from './runtime-contracts.js';
import { createRepoKnowledgeSnapshot } from './repo-knowledge.js';
import { createTaskSpecSnapshot } from './task-spec.js';
import {
  CONTROLLER_RUN_MEASUREMENT_FORMAT,
  CONTROLLER_RUN_MEASUREMENT_SCHEMA_VERSION,
  EXECUTION_ATTEMPT_MEASUREMENT_FORMAT,
  EXECUTION_ATTEMPT_MEASUREMENT_SCHEMA_VERSION,
  MEASUREMENT_ACTION_CLASSES,
  MEASUREMENT_FAILURE_CLASSES,
  MEASUREMENT_INTERVENTION_KINDS,
  MEASUREMENT_RETRY_CAUSES,
  createMeasurementCountMap,
  normalizeMeasurementActionClass,
  normalizeMeasurementFailureClass,
  normalizeMeasurementRetryCause,
  normalizeMeasurementTrigger,
} from './measurement-taxonomy.js';

export const CONTROL_PLANE_SCHEMA_VERSION = 'ao.control-plane.schema.v1alpha1';
export const CONTROL_PLANE_SCHEMA_FORMAT = 'ao_control_plane_schema';
export const CONTROL_PLANE_STATE_SCHEMA_VERSION = 'ao.control-plane.state.v1alpha1';
export const CONTROL_PLANE_STATE_FORMAT = 'ao_control_plane_state';
export const CONTROL_PLANE_AUDIT_SCHEMA_VERSION = 'ao.control-plane.audit.v1alpha1';
export const CONTROL_PLANE_AUDIT_FORMAT = 'ao_control_plane_audit_entry';
export const CONTROL_PLANE_LATEST_VERSION = 10;
export const CONTROL_PLANE_DEFAULT_CONTROLLER_ID = 'default';
export const CHECKPOINT_SCHEMA_VERSION = 'ao.checkpoint.v1alpha1';
export const CHECKPOINT_FORMAT = 'ao_checkpoint';
export const HANDOFF_REQUEST_SCHEMA_VERSION = 'ao.handoff-request.v1alpha1';
export const HANDOFF_REQUEST_FORMAT = 'ao_handoff_request';
export const HANDOFF_CLAIM_SCHEMA_VERSION = 'ao.handoff-claim.v1alpha1';
export const HANDOFF_CLAIM_FORMAT = 'ao_handoff_claim';
export const HANDOFF_DECISION_SCHEMA_VERSION = 'ao.handoff-decision.v1alpha1';
export const HANDOFF_DECISION_FORMAT = 'ao_handoff_decision';
export const HANDOFF_TRANSFER_SCHEMA_VERSION = 'ao.handoff-transfer.v1alpha1';
export const HANDOFF_TRANSFER_FORMAT = 'ao_handoff_transfer';
export const REVIEW_RECORD_SCHEMA_VERSION = 'ao.review-record.v1alpha1';
export const REVIEW_RECORD_FORMAT = 'ao_review_record';
export const AO_EVAL_HARNESS_RUN_SCHEMA_VERSION = 'ao.eval-harness-run.v1alpha1';
export const AO_EVAL_HARNESS_RUN_FORMAT = 'ao_eval_harness_run';
export const AO_EVAL_SCORECARD_SCHEMA_VERSION = 'ao.eval-scorecard.v1alpha1';
export const AO_EVAL_SCORECARD_FORMAT = 'ao_eval_scorecard';

export const MANAGED_TASK_STATUSES = ['active', 'paused', 'retired'];
export const PR_BINDING_STATUSES = ['bound', 'released', 'closed'];
export const OWNERSHIP_LEASE_STATUSES = ['active', 'released', 'expired'];
export const CONTROLLER_LEASE_STATUSES = ['active', 'released', 'expired'];
export const ACTION_STATUSES = ['proposed', 'blocked', 'executed', 'cancelled'];
export const OVERRIDE_SCOPE_KINDS = ['global', 'task', 'pr', 'controller'];
export const OVERRIDE_STATUSES = ['active', 'cleared', 'expired'];
export const CONTROLLER_MODES = ['off', 'observe', 'shadow', 'assist'];
export const CONTROLLER_RUNTIME_KINDS = ['oneshot', 'continuous'];
export const CONTROLLER_RUN_STATUSES = ['running', 'completed', 'failed', 'stopping'];
export const OBSERVATION_SOURCE_KINDS = ['ao_poll', 'github_poll'];
export const TASK_SPEC_RECORD_STATES = ['valid', 'invalid'];
export const DELIVERY_EVENT_FAMILIES = ['pr', 'check', 'review', 'review_comment'];
export const POLICY_DECISIONS = ['allow', 'deny', 'downgrade'];
export const CREDENTIAL_PROVENANCE_TRUST_DECISIONS = ['trusted', 'untrusted'];
export const HANDOFF_REQUEST_STATUSES = ['open', 'accepted', 'rejected', 'expired', 'completed'];
export const HANDOFF_CLAIM_STATUSES = ['pending', 'blocked', 'accepted', 'rejected', 'expired'];
export const HANDOFF_DECISION_OUTCOMES = ['accept', 'reject', 'expire'];
export const REVIEW_RECORD_STATUSES = ['open', 'claimed', 'passed', 'changes_required', 'escalated', 'cancelled'];
export const REVIEW_VERDICTS = ['pass', 'changes_required', 'escalate_human'];
export const REVIEW_FREEZE_STATUSES = ['active', 'released'];
export const REVIEW_BASELINE_CATEGORIES = [
  'workspace_sanity',
  'control_plane_sanity',
  'scoped_verification',
  'pr_readonly',
];
export const EXECUTION_ATTEMPT_KINDS = ['assist_action', 'managed_task'];
export const EXECUTION_ATTEMPT_STATUSES = ['active', 'executed', 'blocked', 'paused', 'retired', 'completed'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }

  return value.trim();
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new Error('Expected string or null');
  }

  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function normalizePositiveInteger(value, fieldName, { nullable = false, allowZero = false } = {}) {
  if (value == null && nullable) return null;

  const normalized = Number(value);
  const minimumValue = allowZero ? 0 : 1;
  if (!Number.isInteger(normalized) || normalized < minimumValue) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeIsoTimestamp(value, fieldName, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`);
  }

  const normalized = value.trim();
  if (normalized === '') {
    if (nullable) return null;
    throw new Error(`Invalid ${fieldName}`);
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeEnum(value, fieldName, allowedValues) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizeStringArray(values, fieldName) {
  if (!Array.isArray(values)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return values.map((value, index) => normalizeRequiredString(value, `${fieldName}[${index}]`));
}

function normalizeMetadata(value = {}) {
  if (value == null) return {};
  if (!isPlainObject(value)) {
    throw new Error('Invalid metadata');
  }

  return cloneJsonValue(value);
}

function normalizeNullableNumber(value, fieldName) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeCountMap(values, fieldName, keys) {
  if (values == null) return createMeasurementCountMap(keys);
  if (!isPlainObject(values)) {
    throw new Error(`Invalid ${fieldName}`);
  }

  const nextValues = {};
  for (const [key, value] of Object.entries(values)) {
    if (!keys.includes(key)) {
      throw new Error(`Invalid ${fieldName}.${key}`);
    }
    nextValues[key] = normalizePositiveInteger(value, `${fieldName}.${key}`, {
      allowZero: true,
    });
  }

  return createMeasurementCountMap(keys, nextValues);
}

function normalizeVerificationBaseline(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Invalid verification_baseline');
  }

  return values.map((value, index) => {
    if (!isPlainObject(value)) {
      throw new Error(`Invalid verification_baseline[${index}]`);
    }

    return {
      category: normalizeEnum(
        value.category,
        `verification_baseline[${index}].category`,
        REVIEW_BASELINE_CATEGORIES,
      ),
      commands: normalizeStringArray(value.commands, `verification_baseline[${index}].commands`),
    };
  });
}

function normalizeBaselineExecution(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new Error('Invalid baseline_execution');
  }

  return {
    status: normalizeRequiredString(value.status, 'baseline_execution.status'),
    summary: normalizeOptionalString(value.summary),
    recorded_at: normalizeIsoTimestamp(
      value.recorded_at,
      'baseline_execution.recorded_at',
      { nullable: true },
    ),
    attested_by_session_name: normalizeOptionalString(value.attested_by_session_name),
    attested_by_session_id: normalizeOptionalString(value.attested_by_session_id),
    commands_run: value.commands_run == null
      ? []
      : normalizeStringArray(value.commands_run, 'baseline_execution.commands_run'),
  };
}

function normalizeFindingsSummary(values = []) {
  if (!Array.isArray(values)) {
    throw new Error('Invalid findings_summary');
  }

  return values.map((value, index) => normalizeRequiredString(value, `findings_summary[${index}]`));
}

function normalizeActionClassCounts(values) {
  if (values == null) return createMeasurementCountMap(MEASUREMENT_ACTION_CLASSES);
  if (!isPlainObject(values)) {
    throw new Error('Invalid action_class_counts');
  }

  const nextValues = {};
  for (const [key, value] of Object.entries(values)) {
    const normalizedKey = normalizeMeasurementActionClass(key);
    nextValues[normalizedKey] = (nextValues[normalizedKey] ?? 0) + normalizePositiveInteger(
      value,
      `action_class_counts.${key}`,
      { allowZero: true },
    );
  }

  return createMeasurementCountMap(MEASUREMENT_ACTION_CLASSES, nextValues);
}

function normalizeTokenUsage(value) {
  if (value == null) {
    return {
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
    };
  }
  if (!isPlainObject(value)) {
    throw new Error('Invalid token_usage');
  }

  return {
    input_tokens: normalizePositiveInteger(value.input_tokens, 'token_usage.input_tokens', {
      nullable: true,
      allowZero: true,
    }),
    output_tokens: normalizePositiveInteger(value.output_tokens, 'token_usage.output_tokens', {
      nullable: true,
      allowZero: true,
    }),
    total_tokens: normalizePositiveInteger(value.total_tokens, 'token_usage.total_tokens', {
      nullable: true,
      allowZero: true,
    }),
  };
}

function normalizeCost(value) {
  if (value == null) {
    return {
      usd: null,
    };
  }
  if (!isPlainObject(value)) {
    throw new Error('Invalid cost');
  }

  return {
    usd: normalizeNullableNumber(value.usd, 'cost.usd'),
  };
}

function normalizeLineage(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid lineage');
  }

  return {
    source_observation_id: normalizeRequiredString(
      value.source_observation_id,
      'lineage.source_observation_id',
    ),
    source_cursor: normalizeRequiredString(value.source_cursor, 'lineage.source_cursor'),
  };
}

export function createControlPlaneSchema({
  project_id,
  current_version,
  latest_version = CONTROL_PLANE_LATEST_VERSION,
  created_at,
  updated_at,
  applied_migrations = [],
} = {}) {
  return {
    schema_version: CONTROL_PLANE_SCHEMA_VERSION,
    format: CONTROL_PLANE_SCHEMA_FORMAT,
    project_id: normalizeRequiredString(project_id, 'project_id'),
    current_version: normalizePositiveInteger(current_version, 'current_version', {
      nullable: current_version == null,
      allowZero: true,
    }),
    latest_version: normalizePositiveInteger(latest_version, 'latest_version'),
    created_at: normalizeIsoTimestamp(created_at, 'created_at', { nullable: true }),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at', { nullable: true }),
    applied_migrations: (applied_migrations ?? []).map((migration) => ({
      version: normalizePositiveInteger(migration?.version, 'migration.version'),
      key: normalizeRequiredString(migration?.key, 'migration.key'),
      applied_at: normalizeIsoTimestamp(migration?.applied_at, 'migration.applied_at'),
    })),
  };
}

export function createEmptyControlPlaneState({
  project_id,
  created_at,
  updated_at,
} = {}) {
  return {
    schema_version: CONTROL_PLANE_STATE_SCHEMA_VERSION,
    format: CONTROL_PLANE_STATE_FORMAT,
    project_id: normalizeRequiredString(project_id, 'project_id'),
    created_at: normalizeIsoTimestamp(created_at, 'created_at', { nullable: true }),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at', { nullable: true }),
    managed_tasks: [],
    pr_bindings: [],
    ownership_leases: [],
    controller_leases: [],
    actions: [],
    overrides: [],
    controller_modes: [],
    observations: [],
    delivery_events: [],
    controller_cursors: [],
    policy_decisions: [],
    credential_provenances: [],
    task_specs: [],
    runtime_preflights: [],
    repo_knowledge: [],
    review_records: [],
    checkpoints: [],
    handoff_requests: [],
    handoff_claims: [],
    handoff_decisions: [],
    handoff_transfers: [],
    controller_run_metrics: [],
    execution_attempt_metrics: [],
  };
}

export function createManagedTask({
  task_id,
  issue_number = null,
  title,
  branch_name = null,
  worktree_path = null,
  status,
  created_at,
  updated_at,
  metadata = {},
} = {}) {
  return {
    task_id: normalizeRequiredString(task_id, 'task_id'),
    issue_number: normalizePositiveInteger(issue_number, 'issue_number', { nullable: true }),
    title: normalizeRequiredString(title, 'title'),
    branch_name: normalizeOptionalString(branch_name),
    worktree_path: normalizeOptionalString(worktree_path),
    status: normalizeEnum(status, 'status', MANAGED_TASK_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    metadata: normalizeMetadata(metadata),
  };
}

export function createPrBinding({
  binding_id,
  task_id,
  pr_number,
  branch_name = null,
  base_branch = null,
  status,
  created_at,
  updated_at,
  metadata = {},
} = {}) {
  return {
    binding_id: normalizeRequiredString(binding_id, 'binding_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    pr_number: normalizePositiveInteger(pr_number, 'pr_number'),
    branch_name: normalizeOptionalString(branch_name),
    base_branch: normalizeOptionalString(base_branch),
    status: normalizeEnum(status, 'status', PR_BINDING_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    metadata: normalizeMetadata(metadata),
  };
}

export function createOwnershipLease({
  lease_id,
  task_id,
  owner_session_name,
  owner_session_id = null,
  status,
  acquired_at,
  expires_at,
  released_at = null,
  release_reason = null,
  metadata = {},
} = {}) {
  return {
    lease_id: normalizeRequiredString(lease_id, 'lease_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    owner_session_name: normalizeRequiredString(owner_session_name, 'owner_session_name'),
    owner_session_id: normalizeOptionalString(owner_session_id),
    status: normalizeEnum(status, 'status', OWNERSHIP_LEASE_STATUSES),
    acquired_at: normalizeIsoTimestamp(acquired_at, 'acquired_at'),
    expires_at: normalizeIsoTimestamp(expires_at, 'expires_at'),
    released_at: normalizeIsoTimestamp(released_at, 'released_at', { nullable: true }),
    release_reason: normalizeOptionalString(release_reason),
    metadata: normalizeMetadata(metadata),
  };
}

export function createControllerLease({
  lease_id,
  controller_id,
  holder_id,
  holder_type,
  incarnation_id = null,
  status,
  acquired_at,
  heartbeat_at = null,
  expires_at,
  lease_timeout_ms = null,
  runtime_kind = null,
  poll_interval_ms = null,
  shutdown_timeout_ms = null,
  last_run_started_at = null,
  last_run_completed_at = null,
  last_run_status = null,
  released_at = null,
  release_reason = null,
  metadata = {},
} = {}) {
  return {
    lease_id: normalizeRequiredString(lease_id, 'lease_id'),
    controller_id: normalizeRequiredString(controller_id, 'controller_id'),
    holder_id: normalizeRequiredString(holder_id, 'holder_id'),
    holder_type: normalizeRequiredString(holder_type, 'holder_type'),
    incarnation_id: normalizeOptionalString(incarnation_id),
    status: normalizeEnum(status, 'status', CONTROLLER_LEASE_STATUSES),
    acquired_at: normalizeIsoTimestamp(acquired_at, 'acquired_at'),
    heartbeat_at: normalizeIsoTimestamp(heartbeat_at, 'heartbeat_at', { nullable: true }),
    expires_at: normalizeIsoTimestamp(expires_at, 'expires_at'),
    lease_timeout_ms: normalizePositiveInteger(lease_timeout_ms, 'lease_timeout_ms', { nullable: true }),
    runtime_kind: runtime_kind == null ? null : normalizeEnum(runtime_kind, 'runtime_kind', CONTROLLER_RUNTIME_KINDS),
    poll_interval_ms: normalizePositiveInteger(poll_interval_ms, 'poll_interval_ms', { nullable: true }),
    shutdown_timeout_ms: normalizePositiveInteger(shutdown_timeout_ms, 'shutdown_timeout_ms', { nullable: true }),
    last_run_started_at: normalizeIsoTimestamp(last_run_started_at, 'last_run_started_at', { nullable: true }),
    last_run_completed_at: normalizeIsoTimestamp(last_run_completed_at, 'last_run_completed_at', { nullable: true }),
    last_run_status: last_run_status == null ? null : normalizeEnum(last_run_status, 'last_run_status', CONTROLLER_RUN_STATUSES),
    released_at: normalizeIsoTimestamp(released_at, 'released_at', { nullable: true }),
    release_reason: normalizeOptionalString(release_reason),
    metadata: normalizeMetadata(metadata),
  };
}

export function createActionRecord({
  action_id,
  task_id = null,
  action_kind,
  status,
  requested_by = null,
  reason = null,
  created_at,
  updated_at,
  payload = {},
} = {}) {
  return {
    action_id: normalizeRequiredString(action_id, 'action_id'),
    task_id: normalizeOptionalString(task_id),
    action_kind: normalizeRequiredString(action_kind, 'action_kind'),
    status: normalizeEnum(status, 'status', ACTION_STATUSES),
    requested_by: normalizeOptionalString(requested_by),
    reason: normalizeOptionalString(reason),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    payload: cloneJsonValue(payload ?? {}),
  };
}

export function createOverrideRecord({
  override_id,
  scope_kind,
  scope_id,
  override_kind,
  value,
  status,
  created_at,
  expires_at = null,
  cleared_at = null,
  cleared_reason = null,
  created_by = null,
} = {}) {
  return {
    override_id: normalizeRequiredString(override_id, 'override_id'),
    scope_kind: normalizeEnum(scope_kind, 'scope_kind', OVERRIDE_SCOPE_KINDS),
    scope_id: normalizeRequiredString(scope_id, 'scope_id'),
    override_kind: normalizeRequiredString(override_kind, 'override_kind'),
    value: cloneJsonValue(value),
    status: normalizeEnum(status, 'status', OVERRIDE_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    expires_at: normalizeIsoTimestamp(expires_at, 'expires_at', { nullable: true }),
    cleared_at: normalizeIsoTimestamp(cleared_at, 'cleared_at', { nullable: true }),
    cleared_reason: normalizeOptionalString(cleared_reason),
    created_by: normalizeOptionalString(created_by),
  };
}

export function createControllerModeRecord({
  controller_id,
  mode,
  updated_at,
  updated_by = null,
  reason = null,
} = {}) {
  return {
    controller_id: normalizeRequiredString(controller_id, 'controller_id'),
    mode: normalizeEnum(mode, 'mode', CONTROLLER_MODES),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    updated_by: normalizeOptionalString(updated_by),
    reason: normalizeOptionalString(reason),
  };
}

export function createObservationRecord({
  observation_id,
  task_id,
  source_kind,
  cursor,
  observed_at,
  recorded_at,
  summary = null,
  payload = {},
} = {}) {
  return {
    observation_id: normalizeRequiredString(observation_id, 'observation_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    source_kind: normalizeEnum(source_kind, 'source_kind', OBSERVATION_SOURCE_KINDS),
    cursor: normalizeRequiredString(cursor, 'cursor'),
    observed_at: normalizeIsoTimestamp(observed_at, 'observed_at'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    summary: normalizeOptionalString(summary),
    payload: cloneJsonValue(payload ?? {}),
  };
}

export function createDeliveryEventRecord({
  event_id,
  task_id,
  pr_number = null,
  source_kind,
  event_family,
  event_type,
  dedupe_key,
  lifecycle_trigger = null,
  controller_action_hint = null,
  observed_at,
  recorded_at,
  lineage = {},
  payload = {},
} = {}) {
  return {
    event_id: normalizeRequiredString(event_id, 'event_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    pr_number: normalizePositiveInteger(pr_number, 'pr_number', { nullable: true }),
    source_kind: normalizeRequiredString(source_kind, 'source_kind'),
    event_family: normalizeEnum(event_family, 'event_family', DELIVERY_EVENT_FAMILIES),
    event_type: normalizeRequiredString(event_type, 'event_type'),
    dedupe_key: normalizeRequiredString(dedupe_key, 'dedupe_key'),
    lifecycle_trigger: normalizeOptionalString(lifecycle_trigger),
    controller_action_hint: normalizeOptionalString(controller_action_hint),
    observed_at: normalizeIsoTimestamp(observed_at, 'observed_at'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    lineage: normalizeLineage(lineage),
    payload: cloneJsonValue(payload ?? {}),
  };
}

export function createControllerCursorRecord({
  cursor_id,
  controller_id,
  task_id,
  source_kind,
  last_cursor,
  observed_at,
  updated_at,
} = {}) {
  return {
    cursor_id: normalizeRequiredString(cursor_id, 'cursor_id'),
    controller_id: normalizeRequiredString(controller_id, 'controller_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    source_kind: normalizeEnum(source_kind, 'source_kind', OBSERVATION_SOURCE_KINDS),
    last_cursor: normalizeRequiredString(last_cursor, 'last_cursor'),
    observed_at: normalizeIsoTimestamp(observed_at, 'observed_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
  };
}

function normalizePolicyFindings(findings = []) {
  if (!Array.isArray(findings)) {
    throw new Error('Invalid findings');
  }

  return findings.map((finding) => ({
    code: normalizeRequiredString(finding?.code, 'finding.code'),
    severity: normalizeEnum(finding?.severity, 'finding.severity', POLICY_DECISIONS),
    surface: normalizeRequiredString(finding?.surface, 'finding.surface'),
    value: normalizeRequiredString(finding?.value, 'finding.value'),
    detail: normalizeOptionalString(finding?.detail),
  }));
}

export function createCredentialProvenanceRecord({
  provenance_id,
  credential_kind,
  source_kind,
  trust_decision = 'trusted',
  scope = null,
  created_at,
  updated_at,
  metadata = {},
} = {}) {
  return {
    provenance_id: normalizeRequiredString(provenance_id, 'provenance_id'),
    credential_kind: normalizeRequiredString(credential_kind, 'credential_kind'),
    source_kind: normalizeRequiredString(source_kind, 'source_kind'),
    trust_decision: normalizeEnum(
      trust_decision,
      'trust_decision',
      CREDENTIAL_PROVENANCE_TRUST_DECISIONS,
    ),
    scope: normalizeOptionalString(scope),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    metadata: normalizeMetadata(metadata),
  };
}

export function createPolicyDecisionRecord({
  decision_id,
  task_id,
  action_id = null,
  action_kind = null,
  subject_kind,
  decision,
  policy_version,
  input_fingerprint,
  recorded_at,
  summary = null,
  findings = [],
  input = {},
  result = {},
} = {}) {
  return {
    decision_id: normalizeRequiredString(decision_id, 'decision_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    action_id: normalizeOptionalString(action_id),
    action_kind: normalizeOptionalString(action_kind),
    subject_kind: normalizeRequiredString(subject_kind, 'subject_kind'),
    decision: normalizeEnum(decision, 'decision', POLICY_DECISIONS),
    policy_version: normalizeRequiredString(policy_version, 'policy_version'),
    input_fingerprint: normalizeRequiredString(input_fingerprint, 'input_fingerprint'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    summary: normalizeOptionalString(summary),
    findings: normalizePolicyFindings(findings),
    input: cloneJsonValue(input ?? {}),
    result: cloneJsonValue(result ?? {}),
  };
}

export function createTaskSpecRecord({
  task_id,
  source_kind,
  source_issue_number = null,
  created_at,
  updated_at,
  snapshot,
} = {}) {
  const normalizedSnapshot = createTaskSpecSnapshot({
    schema_version: snapshot?.schema_version,
    problem_type: snapshot?.spec?.problem_type,
    acceptance_contract: snapshot?.spec?.acceptance_contract,
    runtime_ref: snapshot?.spec?.runtime_ref,
    policy_ref: snapshot?.spec?.policy_ref,
    human_gates: snapshot?.spec?.human_gates,
  });

  return {
    task_id: normalizeRequiredString(task_id, 'task_id'),
    source_kind: normalizeRequiredString(source_kind, 'source_kind'),
    source_issue_number: normalizePositiveInteger(source_issue_number, 'source_issue_number', {
      nullable: true,
    }),
    state: normalizedSnapshot.valid ? 'valid' : 'invalid',
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    snapshot: normalizedSnapshot,
  };
}

export function createRuntimePreflightRecord({
  recorded_at,
  snapshot,
} = {}) {
  const normalizedSnapshot = createRuntimePreflightSnapshot({
    runtime_ref: snapshot?.runtime_ref,
    provider_id: snapshot?.provider_id ?? null,
    observed_at: snapshot?.observed_at,
    status: snapshot?.status,
    contract: snapshot?.contract ?? null,
    checks: snapshot?.checks ?? [],
  });

  return {
    runtime_ref: normalizeRequiredString(normalizedSnapshot.runtime_ref, 'runtime_ref'),
    provider_id: normalizeOptionalString(normalizedSnapshot.provider_id),
    status: normalizeRequiredString(normalizedSnapshot.status, 'status'),
    observed_at: normalizeIsoTimestamp(normalizedSnapshot.observed_at, 'observed_at'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    replay_key: normalizeRequiredString(normalizedSnapshot.replay_key, 'replay_key'),
    snapshot: normalizedSnapshot,
  };
}

export function createRepoKnowledgeRecord({
  recorded_at,
  snapshot,
} = {}) {
  const normalizedSnapshot = createRepoKnowledgeSnapshot(snapshot);

  return {
    project_id: normalizeRequiredString(normalizedSnapshot.project_id, 'project_id'),
    profile_version: normalizePositiveInteger(normalizedSnapshot.profile_version, 'profile_version'),
    lint_status: normalizeRequiredString(normalizedSnapshot?.lint?.status, 'lint.status'),
    observed_at: normalizeIsoTimestamp(normalizedSnapshot.observed_at, 'observed_at'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    replay_key: normalizeRequiredString(normalizedSnapshot.replay_key, 'replay_key'),
    snapshot: normalizedSnapshot,
  };
}

export function createReviewRecord({
  review_id,
  task_id,
  issue_number = null,
  pr_number = null,
  status,
  trigger_kind,
  target_branch,
  target_head_sha,
  requested_by_session_name,
  requested_by_session_id = null,
  implementation_session_name,
  implementation_session_id = null,
  reviewer_session_name = null,
  reviewer_session_id = null,
  verification_baseline,
  findings_summary = [],
  verdict = null,
  baseline_execution = null,
  freeze_status,
  created_at,
  updated_at,
  metadata = {},
} = {}) {
  return {
    schema_version: REVIEW_RECORD_SCHEMA_VERSION,
    format: REVIEW_RECORD_FORMAT,
    review_id: normalizeRequiredString(review_id, 'review_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    issue_number: normalizePositiveInteger(issue_number, 'issue_number', { nullable: true }),
    pr_number: normalizePositiveInteger(pr_number, 'pr_number', { nullable: true }),
    status: normalizeEnum(status, 'status', REVIEW_RECORD_STATUSES),
    trigger_kind: normalizeRequiredString(trigger_kind, 'trigger_kind'),
    target_branch: normalizeRequiredString(target_branch, 'target_branch'),
    target_head_sha: normalizeRequiredString(target_head_sha, 'target_head_sha'),
    requested_by_session_name: normalizeRequiredString(
      requested_by_session_name,
      'requested_by_session_name',
    ),
    requested_by_session_id: normalizeOptionalString(requested_by_session_id),
    implementation_session_name: normalizeRequiredString(
      implementation_session_name,
      'implementation_session_name',
    ),
    implementation_session_id: normalizeOptionalString(implementation_session_id),
    reviewer_session_name: normalizeOptionalString(reviewer_session_name),
    reviewer_session_id: normalizeOptionalString(reviewer_session_id),
    verification_baseline: normalizeVerificationBaseline(verification_baseline),
    findings_summary: normalizeFindingsSummary(findings_summary),
    verdict: verdict == null ? null : normalizeEnum(verdict, 'verdict', REVIEW_VERDICTS),
    baseline_execution: normalizeBaselineExecution(baseline_execution),
    freeze_status: normalizeEnum(freeze_status, 'freeze_status', REVIEW_FREEZE_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    metadata: normalizeMetadata(metadata),
  };
}

function normalizeCheckpointPrBinding(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new Error('Invalid checkpoint pr_binding');
  }

  return {
    binding_id: normalizeRequiredString(value.binding_id, 'pr_binding.binding_id'),
    pr_number: normalizePositiveInteger(value.pr_number, 'pr_binding.pr_number'),
    branch_name: normalizeOptionalString(value.branch_name),
    base_branch: normalizeOptionalString(value.base_branch),
    updated_at: normalizeIsoTimestamp(value.updated_at, 'pr_binding.updated_at'),
    status: normalizeRequiredString(value.status, 'pr_binding.status'),
  };
}

function normalizeCheckpointTaskRef(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid task_ref');
  }

  return {
    task_id: normalizeRequiredString(value.task_id, 'task_ref.task_id'),
    issue_number: normalizePositiveInteger(value.issue_number, 'task_ref.issue_number', {
      nullable: true,
    }),
    title: normalizeRequiredString(value.title, 'task_ref.title'),
    branch_name: normalizeOptionalString(value.branch_name),
    worktree_path: normalizeOptionalString(value.worktree_path),
    updated_at: normalizeIsoTimestamp(value.updated_at, 'task_ref.updated_at'),
    pr_binding: normalizeCheckpointPrBinding(value.pr_binding),
  };
}

function normalizeCheckpointTaskSpecRef(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new Error('Invalid verification_ref.task_spec');
  }

  return {
    task_id: normalizeRequiredString(value.task_id, 'verification_ref.task_spec.task_id'),
    updated_at: normalizeIsoTimestamp(value.updated_at, 'verification_ref.task_spec.updated_at'),
    state: normalizeRequiredString(value.state, 'verification_ref.task_spec.state'),
    snapshot_schema_version: normalizeRequiredString(
      value.snapshot_schema_version,
      'verification_ref.task_spec.snapshot_schema_version',
    ),
  };
}

function normalizeCheckpointRuntimePreflightRef(value) {
  if (value == null) return null;
  if (!isPlainObject(value)) {
    throw new Error('Invalid verification_ref.runtime_preflight');
  }

  return {
    runtime_ref: normalizeRequiredString(
      value.runtime_ref,
      'verification_ref.runtime_preflight.runtime_ref',
    ),
    recorded_at: normalizeIsoTimestamp(
      value.recorded_at,
      'verification_ref.runtime_preflight.recorded_at',
    ),
    replay_key: normalizeRequiredString(
      value.replay_key,
      'verification_ref.runtime_preflight.replay_key',
    ),
    status: normalizeRequiredString(value.status, 'verification_ref.runtime_preflight.status'),
    snapshot_schema_version: normalizeRequiredString(
      value.snapshot_schema_version,
      'verification_ref.runtime_preflight.snapshot_schema_version',
    ),
  };
}

function normalizeCheckpointVerificationRef(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid verification_ref');
  }

  return {
    task_spec: normalizeCheckpointTaskSpecRef(value.task_spec),
    runtime_preflight: normalizeCheckpointRuntimePreflightRef(value.runtime_preflight),
  };
}

function normalizeCheckpointExecutionRef(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid execution_ref');
  }

  return {
    controller_id: normalizeRequiredString(value.controller_id, 'execution_ref.controller_id'),
    controller_mode: normalizeEnum(value.controller_mode, 'execution_ref.controller_mode', CONTROLLER_MODES),
    controller_mode_updated_at: normalizeIsoTimestamp(
      value.controller_mode_updated_at,
      'execution_ref.controller_mode_updated_at',
    ),
    derived_trigger: normalizeOptionalString(value.derived_trigger),
    lifecycle_top_status: normalizeOptionalString(value.lifecycle_top_status),
    observed_at: normalizeIsoTimestamp(value.observed_at, 'execution_ref.observed_at'),
    action_ids: normalizeStringArray(value.action_ids ?? [], 'execution_ref.action_ids'),
  };
}

export function createCheckpointSnapshot({
  schema_version = CHECKPOINT_SCHEMA_VERSION,
  format = CHECKPOINT_FORMAT,
  task_ref,
  verification_ref,
  execution_ref,
} = {}) {
  return {
    schema_version: normalizeRequiredString(schema_version, 'schema_version'),
    format: normalizeRequiredString(format, 'format'),
    task_ref: normalizeCheckpointTaskRef(task_ref),
    verification_ref: normalizeCheckpointVerificationRef(verification_ref),
    execution_ref: normalizeCheckpointExecutionRef(execution_ref),
  };
}

export function createCheckpointRecord({
  checkpoint_id,
  task_id,
  recorded_at,
  snapshot,
  created_by = null,
  reason = null,
  metadata = {},
} = {}) {
  const normalizedSnapshot = createCheckpointSnapshot({
    schema_version: snapshot?.schema_version,
    format: snapshot?.format,
    task_ref: snapshot?.task_ref,
    verification_ref: snapshot?.verification_ref,
    execution_ref: snapshot?.execution_ref,
  });
  const normalizedTaskId = normalizeRequiredString(task_id, 'task_id');

  if (normalizedTaskId !== normalizedSnapshot.task_ref.task_id) {
    throw new Error('Checkpoint task_id must match snapshot.task_ref.task_id');
  }

  return {
    checkpoint_id: normalizeRequiredString(checkpoint_id, 'checkpoint_id'),
    task_id: normalizedTaskId,
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    created_by: normalizeOptionalString(created_by),
    reason: normalizeOptionalString(reason),
    metadata: normalizeMetadata(metadata),
    snapshot: normalizedSnapshot,
  };
}

function normalizeReasonCodes(reasonCodes = []) {
  return normalizeStringArray(reasonCodes ?? [], 'reason_codes');
}

function normalizeHandoffLineage(value = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Invalid lineage');
  }

  return {
    checkpoint_id: normalizeRequiredString(value.checkpoint_id, 'lineage.checkpoint_id'),
    checkpoint_recorded_at: normalizeIsoTimestamp(
      value.checkpoint_recorded_at,
      'lineage.checkpoint_recorded_at',
    ),
    checkpoint_state: normalizeRequiredString(value.checkpoint_state, 'lineage.checkpoint_state'),
    prior_ownership_lease_id: normalizeOptionalString(value.prior_ownership_lease_id),
    prior_owner_session_name: normalizeOptionalString(value.prior_owner_session_name),
    prior_owner_session_id: normalizeOptionalString(value.prior_owner_session_id),
    prior_ownership_status: normalizeOptionalString(value.prior_ownership_status),
    pr_binding_id: normalizeOptionalString(value.pr_binding_id),
    pr_number: normalizePositiveInteger(value.pr_number, 'lineage.pr_number', { nullable: true }),
  };
}

export function createHandoffRequestRecord({
  request_id,
  task_id,
  status,
  created_at,
  updated_at,
  requested_by_session_name = null,
  requested_by_session_id = null,
  operator_session_name = null,
  operator_session_id = null,
  successor_session_name = null,
  successor_session_id = null,
  reason = null,
  expires_at = null,
  selected_claim_id = null,
  accepted_decision_id = null,
  completed_transfer_id = null,
  reason_codes = [],
  lineage,
  metadata = {},
} = {}) {
  return {
    schema_version: HANDOFF_REQUEST_SCHEMA_VERSION,
    format: HANDOFF_REQUEST_FORMAT,
    request_id: normalizeRequiredString(request_id, 'request_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    status: normalizeEnum(status, 'status', HANDOFF_REQUEST_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    requested_by_session_name: normalizeOptionalString(requested_by_session_name),
    requested_by_session_id: normalizeOptionalString(requested_by_session_id),
    operator_session_name: normalizeOptionalString(operator_session_name),
    operator_session_id: normalizeOptionalString(operator_session_id),
    successor_session_name: normalizeOptionalString(successor_session_name),
    successor_session_id: normalizeOptionalString(successor_session_id),
    reason: normalizeOptionalString(reason),
    expires_at: normalizeIsoTimestamp(expires_at, 'expires_at', { nullable: true }),
    selected_claim_id: normalizeOptionalString(selected_claim_id),
    accepted_decision_id: normalizeOptionalString(accepted_decision_id),
    completed_transfer_id: normalizeOptionalString(completed_transfer_id),
    reason_codes: normalizeReasonCodes(reason_codes),
    lineage: normalizeHandoffLineage(lineage),
    metadata: normalizeMetadata(metadata),
  };
}

export function createHandoffClaimRecord({
  claim_id,
  request_id,
  task_id,
  status,
  created_at,
  updated_at,
  successor_session_name,
  successor_session_id = null,
  operator_session_name = null,
  operator_session_id = null,
  decision_id = null,
  reason = null,
  reason_codes = [],
  metadata = {},
} = {}) {
  return {
    schema_version: HANDOFF_CLAIM_SCHEMA_VERSION,
    format: HANDOFF_CLAIM_FORMAT,
    claim_id: normalizeRequiredString(claim_id, 'claim_id'),
    request_id: normalizeRequiredString(request_id, 'request_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    status: normalizeEnum(status, 'status', HANDOFF_CLAIM_STATUSES),
    created_at: normalizeIsoTimestamp(created_at, 'created_at'),
    updated_at: normalizeIsoTimestamp(updated_at, 'updated_at'),
    successor_session_name: normalizeRequiredString(successor_session_name, 'successor_session_name'),
    successor_session_id: normalizeOptionalString(successor_session_id),
    operator_session_name: normalizeOptionalString(operator_session_name),
    operator_session_id: normalizeOptionalString(operator_session_id),
    decision_id: normalizeOptionalString(decision_id),
    reason: normalizeOptionalString(reason),
    reason_codes: normalizeReasonCodes(reason_codes),
    metadata: normalizeMetadata(metadata),
  };
}

export function createHandoffDecisionRecord({
  decision_id,
  request_id,
  claim_id = null,
  task_id,
  outcome,
  decided_at,
  operator_session_name,
  operator_session_id = null,
  successor_session_name = null,
  successor_session_id = null,
  grant_expires_at = null,
  reason = null,
  reason_codes = [],
  metadata = {},
} = {}) {
  return {
    schema_version: HANDOFF_DECISION_SCHEMA_VERSION,
    format: HANDOFF_DECISION_FORMAT,
    decision_id: normalizeRequiredString(decision_id, 'decision_id'),
    request_id: normalizeRequiredString(request_id, 'request_id'),
    claim_id: normalizeOptionalString(claim_id),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    outcome: normalizeEnum(outcome, 'outcome', HANDOFF_DECISION_OUTCOMES),
    decided_at: normalizeIsoTimestamp(decided_at, 'decided_at'),
    operator_session_name: normalizeRequiredString(operator_session_name, 'operator_session_name'),
    operator_session_id: normalizeOptionalString(operator_session_id),
    successor_session_name: normalizeOptionalString(successor_session_name),
    successor_session_id: normalizeOptionalString(successor_session_id),
    grant_expires_at: normalizeIsoTimestamp(grant_expires_at, 'grant_expires_at', { nullable: true }),
    reason: normalizeOptionalString(reason),
    reason_codes: normalizeReasonCodes(reason_codes),
    metadata: normalizeMetadata(metadata),
  };
}

export function createHandoffTransferRecord({
  transfer_id,
  request_id,
  claim_id,
  decision_id,
  task_id,
  checkpoint_id,
  previous_ownership_lease_id = null,
  previous_owner_session_name = null,
  previous_owner_session_id = null,
  successor_ownership_lease_id,
  successor_session_name,
  successor_session_id = null,
  transferred_at,
  transferred_by = null,
  reason = null,
  metadata = {},
} = {}) {
  return {
    schema_version: HANDOFF_TRANSFER_SCHEMA_VERSION,
    format: HANDOFF_TRANSFER_FORMAT,
    transfer_id: normalizeRequiredString(transfer_id, 'transfer_id'),
    request_id: normalizeRequiredString(request_id, 'request_id'),
    claim_id: normalizeRequiredString(claim_id, 'claim_id'),
    decision_id: normalizeRequiredString(decision_id, 'decision_id'),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    checkpoint_id: normalizeRequiredString(checkpoint_id, 'checkpoint_id'),
    previous_ownership_lease_id: normalizeOptionalString(previous_ownership_lease_id),
    previous_owner_session_name: normalizeOptionalString(previous_owner_session_name),
    previous_owner_session_id: normalizeOptionalString(previous_owner_session_id),
    successor_ownership_lease_id: normalizeRequiredString(
      successor_ownership_lease_id,
      'successor_ownership_lease_id',
    ),
    successor_session_name: normalizeRequiredString(successor_session_name, 'successor_session_name'),
    successor_session_id: normalizeOptionalString(successor_session_id),
    transferred_at: normalizeIsoTimestamp(transferred_at, 'transferred_at'),
    transferred_by: normalizeOptionalString(transferred_by),
    reason: normalizeOptionalString(reason),
    metadata: normalizeMetadata(metadata),
  };
}

export function createControllerRunMetricRecord({
  controller_run_metric_id,
  task_id,
  issue_number = null,
  pr_number = null,
  controller_id,
  controller_mode,
  trigger_kind = 'manual',
  lifecycle_top_status = null,
  failure_class = 'none',
  started_at,
  completed_at,
  duration_ms = null,
  observation_count = 0,
  delivery_event_count = 0,
  proposed_action_count = 0,
  executed_action_count = 0,
  blocked_action_count = 0,
  policy_decision_count = 0,
  policy_blocked_action_count = 0,
  denied_action_count = 0,
  downgraded_action_count = 0,
  action_class_counts = null,
  intervention_counts = null,
  token_usage = null,
  cost = null,
  metadata = {},
} = {}) {
  return {
    schema_version: CONTROLLER_RUN_MEASUREMENT_SCHEMA_VERSION,
    format: CONTROLLER_RUN_MEASUREMENT_FORMAT,
    controller_run_metric_id: normalizeRequiredString(
      controller_run_metric_id,
      'controller_run_metric_id',
    ),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    issue_number: normalizePositiveInteger(issue_number, 'issue_number', { nullable: true }),
    pr_number: normalizePositiveInteger(pr_number, 'pr_number', { nullable: true }),
    controller_id: normalizeRequiredString(controller_id, 'controller_id'),
    controller_mode: normalizeEnum(controller_mode, 'controller_mode', CONTROLLER_MODES),
    trigger_kind: normalizeMeasurementTrigger(trigger_kind),
    lifecycle_top_status: normalizeOptionalString(lifecycle_top_status),
    failure_class: normalizeMeasurementFailureClass(failure_class),
    started_at: normalizeIsoTimestamp(started_at, 'started_at'),
    completed_at: normalizeIsoTimestamp(completed_at, 'completed_at'),
    duration_ms: normalizePositiveInteger(duration_ms, 'duration_ms', {
      nullable: true,
      allowZero: true,
    }),
    observation_count: normalizePositiveInteger(observation_count, 'observation_count', {
      allowZero: true,
    }),
    delivery_event_count: normalizePositiveInteger(delivery_event_count, 'delivery_event_count', {
      allowZero: true,
    }),
    proposed_action_count: normalizePositiveInteger(proposed_action_count, 'proposed_action_count', {
      allowZero: true,
    }),
    executed_action_count: normalizePositiveInteger(executed_action_count, 'executed_action_count', {
      allowZero: true,
    }),
    blocked_action_count: normalizePositiveInteger(blocked_action_count, 'blocked_action_count', {
      allowZero: true,
    }),
    policy_decision_count: normalizePositiveInteger(policy_decision_count, 'policy_decision_count', {
      allowZero: true,
    }),
    policy_blocked_action_count: normalizePositiveInteger(
      policy_blocked_action_count,
      'policy_blocked_action_count',
      { allowZero: true },
    ),
    denied_action_count: normalizePositiveInteger(denied_action_count, 'denied_action_count', {
      allowZero: true,
    }),
    downgraded_action_count: normalizePositiveInteger(
      downgraded_action_count,
      'downgraded_action_count',
      { allowZero: true },
    ),
    action_class_counts: normalizeActionClassCounts(action_class_counts),
    intervention_counts: normalizeCountMap(
      intervention_counts,
      'intervention_counts',
      MEASUREMENT_INTERVENTION_KINDS,
    ),
    token_usage: normalizeTokenUsage(token_usage),
    cost: normalizeCost(cost),
    metadata: normalizeMetadata(metadata),
  };
}

export function createExecutionAttemptMetricRecord({
  execution_attempt_metric_id,
  attempt_kind,
  task_id,
  issue_number = null,
  pr_number = null,
  controller_id = null,
  owner_session_name = null,
  owner_session_id = null,
  action_id = null,
  action_kind = null,
  action_class = null,
  command = null,
  status,
  retry_cause = 'none',
  failure_class = 'none',
  reason = null,
  started_at,
  completed_at = null,
  duration_ms = null,
  intervention_counts = null,
  token_usage = null,
  cost = null,
  metadata = {},
} = {}) {
  return {
    schema_version: EXECUTION_ATTEMPT_MEASUREMENT_SCHEMA_VERSION,
    format: EXECUTION_ATTEMPT_MEASUREMENT_FORMAT,
    execution_attempt_metric_id: normalizeRequiredString(
      execution_attempt_metric_id,
      'execution_attempt_metric_id',
    ),
    attempt_kind: normalizeEnum(attempt_kind, 'attempt_kind', EXECUTION_ATTEMPT_KINDS),
    task_id: normalizeRequiredString(task_id, 'task_id'),
    issue_number: normalizePositiveInteger(issue_number, 'issue_number', { nullable: true }),
    pr_number: normalizePositiveInteger(pr_number, 'pr_number', { nullable: true }),
    controller_id: normalizeOptionalString(controller_id),
    owner_session_name: normalizeOptionalString(owner_session_name),
    owner_session_id: normalizeOptionalString(owner_session_id),
    action_id: normalizeOptionalString(action_id),
    action_kind: normalizeOptionalString(action_kind),
    action_class: action_class == null ? null : normalizeMeasurementActionClass(action_class),
    command: normalizeOptionalString(command),
    status: normalizeEnum(status, 'status', EXECUTION_ATTEMPT_STATUSES),
    retry_cause: normalizeMeasurementRetryCause(retry_cause),
    failure_class: normalizeMeasurementFailureClass(failure_class),
    reason: normalizeOptionalString(reason),
    started_at: normalizeIsoTimestamp(started_at, 'started_at'),
    completed_at: normalizeIsoTimestamp(completed_at, 'completed_at', { nullable: true }),
    duration_ms: normalizePositiveInteger(duration_ms, 'duration_ms', {
      nullable: true,
      allowZero: true,
    }),
    intervention_counts: normalizeCountMap(
      intervention_counts,
      'intervention_counts',
      MEASUREMENT_INTERVENTION_KINDS,
    ),
    token_usage: normalizeTokenUsage(token_usage),
    cost: normalizeCost(cost),
    metadata: normalizeMetadata(metadata),
  };
}

export function createControlPlaneAuditEntry({
  audit_id,
  project_id,
  recorded_at,
  entity_kind,
  entity_id,
  operation,
  actor,
  summary,
  details = {},
} = {}) {
  return {
    schema_version: CONTROL_PLANE_AUDIT_SCHEMA_VERSION,
    format: CONTROL_PLANE_AUDIT_FORMAT,
    audit_id: normalizeRequiredString(audit_id, 'audit_id'),
    project_id: normalizeRequiredString(project_id, 'project_id'),
    recorded_at: normalizeIsoTimestamp(recorded_at, 'recorded_at'),
    entity_kind: normalizeRequiredString(entity_kind, 'entity_kind'),
    entity_id: normalizeRequiredString(entity_id, 'entity_id'),
    operation: normalizeRequiredString(operation, 'operation'),
    actor: normalizeRequiredString(actor, 'actor'),
    summary: normalizeRequiredString(summary, 'summary'),
    details: cloneJsonValue(details ?? {}),
  };
}
