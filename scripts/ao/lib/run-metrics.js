import { createHash } from 'node:crypto';

import { findRepoRoot } from './repo-root.js';
import { createStateRepository } from './state-repository.js';
import {
  createControllerRunMetricRecord,
  createExecutionAttemptMetricRecord,
} from './state-contracts.js';
import {
  MEASUREMENT_ACTION_CLASSES,
  MEASUREMENT_FAILURE_CLASSES,
  MEASUREMENT_INTERVENTION_KINDS,
  MEASUREMENT_RETRY_CAUSES,
  MEASUREMENT_TRIGGER_KINDS,
  createMeasurementCountMap,
  normalizeMeasurementTrigger,
  resolveControllerRunFailureClass,
  resolveExecutionAttemptFailureClass,
  resolveExecutionAttemptRetryCause,
  resolveMeasurementActionClass,
} from './measurement-taxonomy.js';

export const DEFAULT_PROJECT_ID = 'my-project';
export const AO_METRICS_REPORT_SCHEMA_VERSION = 'ao.metrics-report.v1alpha1';
export const AO_METRICS_REPORT_FORMAT = 'ao_metrics_report';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function sanitizeToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_');
}

function buildDeterministicId(prefix, payload) {
  const fingerprint = createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex')
    .slice(0, 12);
  return `${prefix}-${fingerprint}`;
}

function parseTimestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

function calculateDurationMs(startedAt, completedAt) {
  const startedAtMs = parseTimestamp(startedAt);
  const completedAtMs = parseTimestamp(completedAt);
  if (startedAtMs == null || completedAtMs == null) return null;
  return Math.max(0, completedAtMs - startedAtMs);
}

function zeroTokenUsage() {
  return {
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
  };
}

function zeroCost() {
  return {
    usd: null,
  };
}

function sumCountMaps(keys, records = []) {
  const total = createMeasurementCountMap(keys);

  for (const record of records) {
    for (const key of keys) {
      total[key] += Number(record?.[key] ?? 0);
    }
  }

  return total;
}

function countValues(keys, values = []) {
  const counts = createMeasurementCountMap(keys);

  for (const value of values) {
    if (value == null || !keys.includes(value)) continue;
    counts[value] += 1;
  }

  return counts;
}

function compareMetricRecords(left, right) {
  const leftTimestamp = String(
    left?.completed_at ?? left?.started_at ?? left?.recorded_at ?? '',
  );
  const rightTimestamp = String(
    right?.completed_at ?? right?.started_at ?? right?.recorded_at ?? '',
  );
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp.localeCompare(leftTimestamp);
  }
  return String(
    right?.controller_run_metric_id
      ?? right?.execution_attempt_metric_id
      ?? '',
  ).localeCompare(String(
    left?.controller_run_metric_id
      ?? left?.execution_attempt_metric_id
      ?? '',
  ));
}

function normalizeWindowBoundary(value, fieldName) {
  if (value == null) return null;
  const timestamp = parseTimestamp(value);
  if (timestamp == null) throw new Error(`Invalid metrics ${fieldName}: ${value}`);
  return {
    iso: new Date(timestamp).toISOString(),
    timestamp,
  };
}

function resolveMetricTimestamp(record) {
  return parseTimestamp(
    record?.completed_at ?? record?.started_at ?? record?.recorded_at ?? null,
  );
}

function filterMetricsByWindow(records, since, until) {
  return records.filter((record) => {
    const timestamp = resolveMetricTimestamp(record);
    if (timestamp == null) return since == null && until == null;
    if (since != null && timestamp < since.timestamp) return false;
    if (until != null && timestamp > until.timestamp) return false;
    return true;
  });
}

function hasIntervention(record) {
  return Object.values(record?.intervention_counts ?? {})
    .some((value) => Number(value ?? 0) > 0);
}

function buildInterventionCountsFromReason(reason, {
  actionKind = null,
  retryCause = 'none',
} = {}) {
  const counts = createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS);
  const normalizedReason = reason == null ? '' : String(reason).trim().toLowerCase();

  if (normalizedReason.startsWith('override_')) counts.override += 1;
  if (normalizedReason === 'policy_allow_required') counts.policy_block += 1;
  if (normalizedReason.startsWith('runtime_preflight_') || normalizedReason === 'runtime_preflight_clean') {
    counts.preflight_block += 1;
  }
  if (normalizedReason === 'explicit_human_gate_required') counts.human_gate += 1;
  if (normalizedReason.includes('handoff') || actionKind === 'handoff_worker') counts.successor_handoff += 1;
  if (retryCause === 'explicit_resume') counts.explicit_resume += 1;
  if (retryCause === 'successor_handoff') counts.successor_handoff += 1;

  return counts;
}

function buildActionClassCounts(actionRecords = []) {
  const counts = createMeasurementCountMap(MEASUREMENT_ACTION_CLASSES);

  for (const record of actionRecords) {
    const actionClass = resolveMeasurementActionClass({
      actionKind: record?.action_kind ?? null,
      actionClass: record?.payload?.action_class ?? record?.payload?.action_model?.action_class ?? null,
    });
    counts[actionClass] += 1;
  }

  return counts;
}

function buildControllerInterventionCounts(actionRecords = []) {
  const counts = createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS);

  for (const record of actionRecords) {
    const policyDecision = record?.payload?.policy?.decision ?? null;
    if (policyDecision === 'deny' || policyDecision === 'downgrade') {
      counts.policy_block += 1;
    }

    const actionKind = record?.action_kind ?? null;
    const actionClass = resolveMeasurementActionClass({
      actionKind,
      actionClass: record?.payload?.action_class ?? record?.payload?.action_model?.action_class ?? null,
    });
    if (actionClass === 'human_gate') counts.human_gate += 1;
    if (actionClass === 'handoff_worker') counts.successor_handoff += 1;

    const attemptCounts = buildInterventionCountsFromReason(
      record?.payload?.execution?.reason ?? null,
      { actionKind },
    );
    for (const key of MEASUREMENT_INTERVENTION_KINDS) {
      counts[key] += attemptCounts[key];
    }
  }

  return counts;
}

export function buildControllerRunMetricId({
  taskId,
  controllerId,
  startedAt,
} = {}) {
  return buildDeterministicId('controller-run', {
    task_id: taskId,
    controller_id: controllerId,
    started_at: startedAt,
  });
}

export function buildExecutionAttemptMetricId({
  attemptKind,
  taskId,
  startedAt,
  ownerSessionName = null,
  actionId = null,
  command = null,
} = {}) {
  return buildDeterministicId('execution-attempt', {
    attempt_kind: attemptKind,
    task_id: taskId,
    started_at: startedAt,
    owner_session_name: ownerSessionName,
    action_id: actionId,
    command,
  });
}

export function buildAssistExecutionAttemptMetric({
  task,
  controllerId,
  actionRecord,
  model,
  status,
  reason = null,
  now = new Date().toISOString(),
} = {}) {
  const timestamp = resolveNow(now);
  const retryCause = 'none';
  const actionKind = actionRecord?.action_kind ?? null;
  const actionClass = resolveMeasurementActionClass({
    actionKind,
    actionClass: model?.action_class ?? actionRecord?.payload?.action_class ?? null,
  });
  const interventionCounts = buildInterventionCountsFromReason(reason, {
    actionKind,
    retryCause,
  });

  return createExecutionAttemptMetricRecord({
    execution_attempt_metric_id: buildExecutionAttemptMetricId({
      attemptKind: 'assist_action',
      taskId: task?.task_id ?? 'unknown-task',
      startedAt: timestamp,
      actionId: actionRecord?.action_id ?? null,
    }),
    attempt_kind: 'assist_action',
    task_id: task?.task_id ?? null,
    issue_number: task?.issue_number ?? null,
    pr_number: model?.pr_number ?? actionRecord?.payload?.pr_number ?? null,
    controller_id: controllerId,
    owner_session_name: null,
    owner_session_id: null,
    action_id: actionRecord?.action_id ?? null,
    action_kind: actionKind,
    action_class: actionClass,
    command: null,
    status,
    retry_cause: retryCause,
    failure_class: resolveExecutionAttemptFailureClass({
      reason,
      triggerKind: model?.derived_trigger ?? null,
      lifecycleTopStatus: model?.lifecycle_top_status ?? null,
    }),
    reason,
    started_at: timestamp,
    completed_at: timestamp,
    duration_ms: 0,
    intervention_counts: interventionCounts,
    token_usage: zeroTokenUsage(),
    cost: zeroCost(),
  });
}

export function buildManagedTaskExecutionAttemptMetric({
  task,
  ownerSessionName = null,
  ownerSessionId = null,
  prNumber = null,
  command,
  acceptedHandoff = false,
  now = new Date().toISOString(),
} = {}) {
  const timestamp = resolveNow(now);
  const retryCause = resolveExecutionAttemptRetryCause({
    command,
    acceptedHandoff,
  });

  return createExecutionAttemptMetricRecord({
    execution_attempt_metric_id: buildExecutionAttemptMetricId({
      attemptKind: 'managed_task',
      taskId: task?.task_id ?? 'unknown-task',
      startedAt: timestamp,
      ownerSessionName,
      command,
    }),
    attempt_kind: 'managed_task',
    task_id: task?.task_id ?? null,
    issue_number: task?.issue_number ?? null,
    pr_number: prNumber ?? null,
    controller_id: null,
    owner_session_name: ownerSessionName,
    owner_session_id: ownerSessionId,
    action_id: null,
    action_kind: null,
    action_class: null,
    command,
    status: 'active',
    retry_cause: retryCause,
    failure_class: 'none',
    reason: null,
    started_at: timestamp,
    completed_at: null,
    duration_ms: null,
    intervention_counts: buildInterventionCountsFromReason(null, {
      retryCause,
    }),
    token_usage: zeroTokenUsage(),
    cost: zeroCost(),
  });
}

export function completeManagedTaskExecutionAttemptMetric({
  attemptRecord,
  status,
  reason = null,
  now = new Date().toISOString(),
} = {}) {
  const timestamp = resolveNow(now);

  return createExecutionAttemptMetricRecord({
    ...attemptRecord,
    status,
    reason,
    completed_at: timestamp,
    duration_ms: calculateDurationMs(attemptRecord?.started_at, timestamp),
    failure_class: resolveExecutionAttemptFailureClass({ reason }),
  });
}

export function buildControllerRunMetric({
  task,
  controllerId,
  controllerMode,
  triggerKind,
  lifecycleTopStatus = null,
  startedAt,
  completedAt = startedAt,
  observationCount = 0,
  deliveryEventCount = 0,
  proposedActionCount = 0,
  executedActionCount = 0,
  blockedActionCount = 0,
  policyDecisionCount = 0,
  policyBlockedActionCount = 0,
  deniedActionCount = 0,
  downgradedActionCount = 0,
  actionRecords = [],
  prNumber = null,
} = {}) {
  const actionClassCounts = buildActionClassCounts(actionRecords);
  const interventionCounts = buildControllerInterventionCounts(actionRecords);

  return createControllerRunMetricRecord({
    controller_run_metric_id: buildControllerRunMetricId({
      taskId: task?.task_id ?? 'unknown-task',
      controllerId,
      startedAt,
    }),
    task_id: task?.task_id ?? null,
    issue_number: task?.issue_number ?? null,
    pr_number: prNumber,
    controller_id: controllerId,
    controller_mode: controllerMode,
    trigger_kind: normalizeMeasurementTrigger(triggerKind),
    lifecycle_top_status: lifecycleTopStatus,
    failure_class: resolveControllerRunFailureClass({
      triggerKind,
      interventionCounts,
      lifecycleTopStatus,
    }),
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: calculateDurationMs(startedAt, completedAt),
    observation_count: observationCount,
    delivery_event_count: deliveryEventCount,
    proposed_action_count: proposedActionCount,
    executed_action_count: executedActionCount,
    blocked_action_count: blockedActionCount,
    policy_decision_count: policyDecisionCount,
    policy_blocked_action_count: policyBlockedActionCount,
    denied_action_count: deniedActionCount,
    downgraded_action_count: downgradedActionCount,
    action_class_counts: actionClassCounts,
    intervention_counts: interventionCounts,
    token_usage: zeroTokenUsage(),
    cost: zeroCost(),
  });
}

function buildZeroMetricsSummary() {
  return {
    controller_run_count: 0,
    execution_attempt_count: 0,
    measurement_count: 0,
    intervened_measurement_count: 0,
    failed_measurement_count: 0,
    intervention_rate: 0,
    failure_rate: 0,
    trigger_counts: createMeasurementCountMap(MEASUREMENT_TRIGGER_KINDS),
    action_class_counts: createMeasurementCountMap(MEASUREMENT_ACTION_CLASSES),
    intervention_counts: createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS),
    failure_class_counts: createMeasurementCountMap(MEASUREMENT_FAILURE_CLASSES),
    retry_cause_counts: createMeasurementCountMap(MEASUREMENT_RETRY_CAUSES),
  };
}

export function buildAoMetricsReport({
  projectId = DEFAULT_PROJECT_ID,
  repoRoot = null,
  snapshot = null,
  traceLimit = 5,
  since = null,
  until = null,
} = {}) {
  const normalizedSince = normalizeWindowBoundary(since, 'since');
  const normalizedUntil = normalizeWindowBoundary(until, 'until');
  if (
    normalizedSince != null
      && normalizedUntil != null
      && normalizedSince.timestamp > normalizedUntil.timestamp
  ) {
    throw new Error('Invalid metrics window: since is after until');
  }
  const controllerRuns = filterMetricsByWindow(
    [...(snapshot?.state?.controller_run_metrics ?? [])],
    normalizedSince,
    normalizedUntil,
  ).sort(compareMetricRecords);
  const executionAttempts = filterMetricsByWindow(
    [...(snapshot?.state?.execution_attempt_metrics ?? [])],
    normalizedSince,
    normalizedUntil,
  ).sort(compareMetricRecords);
  const measurementRecords = [...controllerRuns, ...executionAttempts];

  const summary = buildZeroMetricsSummary();
  summary.controller_run_count = controllerRuns.length;
  summary.execution_attempt_count = executionAttempts.length;
  summary.measurement_count = measurementRecords.length;
  summary.intervened_measurement_count = measurementRecords.filter(hasIntervention).length;
  summary.failed_measurement_count = measurementRecords.filter(
    (record) => record?.failure_class != null && record.failure_class !== 'none',
  ).length;
  summary.intervention_rate = summary.measurement_count === 0
    ? 0
    : summary.intervened_measurement_count / summary.measurement_count;
  summary.failure_rate = summary.measurement_count === 0
    ? 0
    : summary.failed_measurement_count / summary.measurement_count;
  summary.trigger_counts = countValues(
    MEASUREMENT_TRIGGER_KINDS,
    controllerRuns.map((record) => record.trigger_kind),
  );
  summary.action_class_counts = sumCountMaps(
    MEASUREMENT_ACTION_CLASSES,
    controllerRuns.map((record) => record.action_class_counts),
  );
  summary.intervention_counts = sumCountMaps(
    MEASUREMENT_INTERVENTION_KINDS,
    [
      ...controllerRuns.map((record) => record.intervention_counts),
      ...executionAttempts.map((record) => record.intervention_counts),
    ],
  );
  summary.failure_class_counts = countValues(
    MEASUREMENT_FAILURE_CLASSES,
    [
      ...controllerRuns.map((record) => record.failure_class),
      ...executionAttempts.map((record) => record.failure_class),
    ],
  );
  summary.retry_cause_counts = countValues(
    MEASUREMENT_RETRY_CAUSES,
    executionAttempts.map((record) => record.retry_cause),
  );

  return {
    schema_version: AO_METRICS_REPORT_SCHEMA_VERSION,
    report_format: AO_METRICS_REPORT_FORMAT,
    project_id: projectId,
    repo_root: repoRoot,
    window: {
      since: normalizedSince?.iso ?? null,
      until: normalizedUntil?.iso ?? null,
    },
    summary,
    recent_traces: {
      controller_runs: controllerRuns.slice(0, traceLimit),
      execution_attempts: executionAttempts.slice(0, traceLimit),
    },
  };
}

export async function loadAoMetricsReport({
  cwd = process.cwd(),
  repoRoot = null,
  projectId = DEFAULT_PROJECT_ID,
  traceLimit = 5,
  since = null,
  until = null,
} = {}) {
  const resolvedRepoRoot = repoRoot ?? findRepoRoot(cwd);
  if (!resolvedRepoRoot) {
    throw new Error(`Could not locate repo root from ${cwd}`);
  }

  const repository = createStateRepository({
    repoRoot: resolvedRepoRoot,
    projectId,
  });

  return buildAoMetricsReport({
    projectId,
    repoRoot: resolvedRepoRoot,
    snapshot: repository.getSnapshot(),
    traceLimit,
    since,
    until,
  });
}

function formatCountMap(counts) {
  return Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || 'none';
}

export function renderAoMetricsHumanSummary(report) {
  const controllerTrace = (report.recent_traces?.controller_runs ?? [])
    .map((record) => `${record.task_id}:${record.trigger_kind}:${record.failure_class}`);
  const executionTrace = (report.recent_traces?.execution_attempts ?? [])
    .map((record) => `${record.task_id}:${record.command ?? record.action_kind ?? record.status}:${record.retry_cause}`);

  return [
    `project_id: ${report.project_id}`,
    `controller_runs: ${report.summary.controller_run_count}`,
    `execution_attempts: ${report.summary.execution_attempt_count}`,
    `measurements: ${report.summary.measurement_count}`,
    `intervention_rate: ${report.summary.intervention_rate}`,
    `failure_rate: ${report.summary.failure_rate}`,
    `interventions: ${formatCountMap(report.summary.intervention_counts)}`,
    `failures: ${formatCountMap(report.summary.failure_class_counts)}`,
    `retries: ${formatCountMap(report.summary.retry_cause_counts)}`,
    `recent_controller_runs: ${controllerTrace.join(', ') || 'none'}`,
    `recent_execution_attempts: ${executionTrace.join(', ') || 'none'}`,
  ].join('\n');
}
