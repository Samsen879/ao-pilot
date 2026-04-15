export const CONTINUITY_SCHEMA_VERSION = 'ao.continuity.v1alpha1';
export const CONTINUITY_REPORT_FORMAT = 'ao_continuity_report';
export const CONTINUITY_POSTURES = [
  'active_owner',
  'restore_ready',
  'handoff_pending',
  'handoff_granted',
  'orphaned',
  'ambiguous',
  'retired',
];
export const CONTINUITY_RECOMMENDED_ACTIONS = [
  'continue_current_worker',
  'restore_existing_worker',
  'handoff_to_successor',
  'hold_for_human',
  'no_action',
];

function normalizeRequiredString(value, fieldName) {
  const normalized = String(value ?? '').trim();
  if (normalized === '') {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '' ? null : normalized;
}

function normalizeOptionalInteger(value, fieldName) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeOptionalEnum(value, fieldName, allowedValues) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Unsupported ${fieldName}: ${value}`);
  }
  return normalized;
}

function normalizeReasonCodes(reasonCodes = []) {
  return [...new Set((reasonCodes ?? [])
    .map((reasonCode) => String(reasonCode ?? '').trim())
    .filter(Boolean))];
}

export function createContinuityInspection({
  taskId,
  issueNumber = null,
  prNumber = null,
  taskStatus = null,
  posture,
  recommendedAction,
  ownerSessionName = null,
  successorSessionName = null,
  checkpointId = null,
  checkpointState = null,
  handoffRequestId = null,
  reasonCodes = [],
} = {}) {
  return {
    schema_version: CONTINUITY_SCHEMA_VERSION,
    report_format: CONTINUITY_REPORT_FORMAT,
    task_id: normalizeRequiredString(taskId, 'taskId'),
    issue_number: normalizeOptionalInteger(issueNumber, 'issueNumber'),
    pr_number: normalizeOptionalInteger(prNumber, 'prNumber'),
    task_status: normalizeOptionalString(taskStatus),
    posture: normalizeOptionalEnum(posture, 'continuity posture', CONTINUITY_POSTURES),
    recommended_action: normalizeOptionalEnum(
      recommendedAction,
      'continuity action',
      CONTINUITY_RECOMMENDED_ACTIONS,
    ),
    owner_session_name: normalizeOptionalString(ownerSessionName),
    successor_session_name: normalizeOptionalString(successorSessionName),
    checkpoint_id: normalizeOptionalString(checkpointId),
    checkpoint_state: normalizeOptionalEnum(
      checkpointState,
      'checkpoint state',
      ['valid', 'stale', 'invalid'],
    ),
    handoff_request_id: normalizeOptionalString(handoffRequestId),
    reason_codes: normalizeReasonCodes(reasonCodes),
  };
}
