import { LIFECYCLE_TRIGGERS, normalizeLifecycleTrigger } from './lifecycle-contracts.js';

export const CONTROLLER_RUN_MEASUREMENT_SCHEMA_VERSION = 'ao.controller-run-measurement.v1alpha1';
export const CONTROLLER_RUN_MEASUREMENT_FORMAT = 'ao_controller_run_measurement';
export const EXECUTION_ATTEMPT_MEASUREMENT_SCHEMA_VERSION = 'ao.execution-attempt-measurement.v1alpha1';
export const EXECUTION_ATTEMPT_MEASUREMENT_FORMAT = 'ao_execution_attempt_measurement';

export const MEASUREMENT_TRIGGER_KINDS = [...LIFECYCLE_TRIGGERS];

export const MEASUREMENT_ACTION_CLASSES = [
  'continue_worker',
  'notify_human',
  'hold',
  'human_gate',
  'restore_worker',
  'handoff_worker',
  'unknown',
];

export const MEASUREMENT_INTERVENTION_KINDS = [
  'human_gate',
  'override',
  'explicit_resume',
  'successor_handoff',
  'policy_block',
  'preflight_block',
];

export const MEASUREMENT_RETRY_CAUSES = [
  'none',
  'explicit_resume',
  'successor_handoff',
  'policy_retry',
  'preflight_retry',
  'unknown',
];

export const MEASUREMENT_FAILURE_CLASSES = [
  'none',
  'ci_failure',
  'review_blocked',
  'merge_conflict',
  'source_failure',
  'human_gate',
  'override',
  'policy_block',
  'preflight_block',
  'worker_exit',
  'successor_handoff',
  'unknown',
];

function normalizeEnum(value, allowedValues, fallback = null) {
  if (value == null && fallback != null) return fallback;
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Unsupported measurement value: ${value}`);
  }
  return normalized;
}

function toPositiveCount(value) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`Invalid measurement count: ${value}`);
  }
  return normalized;
}

export function normalizeMeasurementTrigger(trigger = 'manual') {
  return normalizeLifecycleTrigger(trigger);
}

export function normalizeMeasurementActionClass(actionClass = 'unknown') {
  return normalizeEnum(actionClass, MEASUREMENT_ACTION_CLASSES, 'unknown');
}

export function normalizeMeasurementInterventionKind(kind) {
  return normalizeEnum(kind, MEASUREMENT_INTERVENTION_KINDS);
}

export function normalizeMeasurementRetryCause(cause = 'none') {
  return normalizeEnum(cause, MEASUREMENT_RETRY_CAUSES, 'none');
}

export function normalizeMeasurementFailureClass(failureClass = 'none') {
  return normalizeEnum(failureClass, MEASUREMENT_FAILURE_CLASSES, 'none');
}

export function createMeasurementCountMap(keys, values = {}) {
  const counts = {};

  for (const key of keys) {
    counts[key] = 0;
  }

  for (const [key, value] of Object.entries(values ?? {})) {
    if (!keys.includes(key)) {
      throw new Error(`Unsupported measurement count key: ${key}`);
    }
    counts[key] = toPositiveCount(value);
  }

  return counts;
}

export function resolveMeasurementActionClass({
  actionKind = null,
  actionClass = null,
} = {}) {
  const normalizedActionKind = actionKind == null ? '' : String(actionKind).trim().toLowerCase();
  const normalizedActionClass = actionClass == null ? '' : String(actionClass).trim().toLowerCase();

  if (normalizedActionKind === 'continue_worker' || normalizedActionClass === 'continue_worker') {
    return 'continue_worker';
  }
  if (normalizedActionKind === 'notify_human_ready' || normalizedActionClass === 'notify_human') {
    return 'notify_human';
  }
  if (
    ['hold_ci', 'hold_review', 'hold_mergeability', 'hold_local_control'].includes(normalizedActionKind)
    || normalizedActionClass === 'hold'
  ) {
    return 'hold';
  }
  if (normalizedActionKind === 'human_gate' || normalizedActionClass === 'human_gate') {
    return 'human_gate';
  }
  if (normalizedActionKind === 'restore_worker' || normalizedActionClass === 'restore_worker') {
    return 'restore_worker';
  }
  if (normalizedActionKind === 'handoff_worker' || normalizedActionClass === 'handoff_worker') {
    return 'handoff_worker';
  }
  return 'unknown';
}

export function resolveExecutionAttemptRetryCause({
  command = null,
  acceptedHandoff = false,
} = {}) {
  const normalizedCommand = command == null ? '' : String(command).trim().toLowerCase();

  if (acceptedHandoff) return 'successor_handoff';
  if (normalizedCommand === 'resume') return 'explicit_resume';
  return 'none';
}

export function resolveExecutionAttemptFailureClass({
  reason = null,
  triggerKind = null,
  lifecycleTopStatus = null,
} = {}) {
  const normalizedReason = reason == null ? '' : String(reason).trim().toLowerCase();
  const normalizedTriggerKind = triggerKind == null ? null : normalizeMeasurementTrigger(triggerKind);
  const normalizedLifecycleTopStatus = lifecycleTopStatus == null
    ? null
    : String(lifecycleTopStatus).trim().toLowerCase().replace(/-/g, '_');

  if (normalizedReason.startsWith('override_')) return 'override';
  if (normalizedReason === 'policy_allow_required') return 'policy_block';
  if (normalizedReason.startsWith('runtime_preflight_') || normalizedReason === 'runtime_preflight_clean') {
    return 'preflight_block';
  }
  if (normalizedReason === 'explicit_human_gate_required') return 'human_gate';
  if (normalizedReason === 'worker_exited' || normalizedReason === 'worker_stale') return 'worker_exit';
  if (normalizedReason.includes('handoff')) return 'successor_handoff';
  if (normalizedLifecycleTopStatus === 'source_failure') return 'source_failure';
  if (normalizedTriggerKind === 'ci_failed') return 'ci_failure';
  if (['changes_requested', 'bugbot_comments'].includes(normalizedTriggerKind)) return 'review_blocked';
  if (normalizedTriggerKind === 'merge_conflicts') return 'merge_conflict';
  if (normalizedTriggerKind === 'agent_exited') return 'worker_exit';
  return 'none';
}

export function resolveControllerRunFailureClass({
  triggerKind = 'manual',
  interventionCounts = createMeasurementCountMap(MEASUREMENT_INTERVENTION_KINDS),
  lifecycleTopStatus = null,
} = {}) {
  const normalizedTriggerKind = normalizeMeasurementTrigger(triggerKind);
  const normalizedLifecycleTopStatus = lifecycleTopStatus == null
    ? null
    : String(lifecycleTopStatus).trim().toLowerCase().replace(/-/g, '_');

  if ((interventionCounts?.preflight_block ?? 0) > 0) return 'preflight_block';
  if ((interventionCounts?.policy_block ?? 0) > 0) return 'policy_block';
  if ((interventionCounts?.override ?? 0) > 0) return 'override';
  if ((interventionCounts?.human_gate ?? 0) > 0 || normalizedLifecycleTopStatus === 'human_gate') {
    return 'human_gate';
  }
  if ((interventionCounts?.successor_handoff ?? 0) > 0) return 'successor_handoff';
  if (normalizedLifecycleTopStatus === 'source_failure') return 'source_failure';
  if (normalizedTriggerKind === 'ci_failed') return 'ci_failure';
  if (['changes_requested', 'bugbot_comments'].includes(normalizedTriggerKind)) return 'review_blocked';
  if (normalizedTriggerKind === 'merge_conflicts') return 'merge_conflict';
  if (normalizedTriggerKind === 'agent_exited') return 'worker_exit';
  return 'none';
}
