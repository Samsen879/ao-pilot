import { createActionRecord } from './state-contracts.js';
import { buildAssistExecutionAttemptMetric } from './run-metrics.js';

export const ASSIST_ACTION_MODEL_SCHEMA_VERSION = 'ao.control-plane.action-model.v1alpha1';
export const ASSIST_ACTION_MODEL_FORMAT = 'ao_control_plane_action_model';
export const ACTION_RISK_CLASSES = ['class_a', 'class_b', 'class_c'];
export const ASSIST_AUTOMATION_BOUNDARY = 'class_a_only';
export const ASSIST_IDEMPOTENCY_MODE = 'action_status_gate';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function toStringArray(values) {
  return (values ?? []).map((value) => String(value));
}

function toNullablePositiveInteger(value) {
  if (value == null) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) return null;
  return normalized;
}

function buildTaskActivePrecondition(task) {
  return {
    code: 'task_active',
    description: 'Managed task must remain active.',
    satisfied: task?.status === 'active',
  };
}

function buildPrScopePrecondition(prNumber) {
  return {
    code: 'pr_scope_required',
    description: 'Action requires one bound PR scope.',
    satisfied: Number.isInteger(toNullablePositiveInteger(prNumber)),
  };
}

function normalizeRuntimePreflight(runtimeRef, runtimePreflight) {
  const normalizedRuntimeRef = runtimeRef == null ? null : String(runtimeRef);
  const normalizedRecord = isPlainObject(runtimePreflight) ? runtimePreflight : null;
  return {
    runtime_ref: normalizedRuntimeRef ?? normalizedRecord?.runtime_ref ?? null,
    status: normalizedRecord?.status == null ? 'missing' : String(normalizedRecord.status),
    replay_key: normalizedRecord?.replay_key == null ? null : String(normalizedRecord.replay_key),
  };
}

function buildRuntimePreflightPrecondition(runtimeRef, runtimePreflight) {
  const normalizedRuntimePreflight = normalizeRuntimePreflight(runtimeRef, runtimePreflight);
  return {
    code: 'runtime_preflight_clean',
    description: 'Assist execution requires a clean runtime preflight for the bound runtime.',
    satisfied: normalizedRuntimePreflight.runtime_ref != null && normalizedRuntimePreflight.status === 'clean',
  };
}

const ACTION_POLICIES = {
  continue_worker: {
    riskClass: 'class_a',
    phase4AssistExecutable: true,
    nonExecutableReason: 'class_a_allowlist',
    buildPreconditions: ({ task }) => [
      buildTaskActivePrecondition(task),
    ],
  },
  notify_human_ready: {
    riskClass: 'class_a',
    phase4AssistExecutable: true,
    nonExecutableReason: 'class_a_allowlist',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
  hold_ci: {
    riskClass: 'class_b',
    phase4AssistExecutable: false,
    nonExecutableReason: 'advisory_hold_non_executable',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
  hold_review: {
    riskClass: 'class_b',
    phase4AssistExecutable: false,
    nonExecutableReason: 'advisory_hold_non_executable',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
  hold_mergeability: {
    riskClass: 'class_b',
    phase4AssistExecutable: false,
    nonExecutableReason: 'advisory_hold_non_executable',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
  hold_local_control: {
    riskClass: 'class_b',
    phase4AssistExecutable: false,
    nonExecutableReason: 'advisory_hold_non_executable',
    buildPreconditions: ({ task }) => [
      buildTaskActivePrecondition(task),
    ],
  },
  human_gate: {
    riskClass: 'class_b',
    phase4AssistExecutable: false,
    nonExecutableReason: 'explicit_human_gate_required',
    buildPreconditions: ({ task }) => [
      buildTaskActivePrecondition(task),
    ],
  },
  restore_worker: {
    riskClass: 'class_c',
    phase4AssistExecutable: false,
    nonExecutableReason: 'runtime_ownership_change_forbidden',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
  handoff_worker: {
    riskClass: 'class_c',
    phase4AssistExecutable: false,
    nonExecutableReason: 'runtime_ownership_change_forbidden',
    buildPreconditions: ({ task, prNumber }) => [
      buildTaskActivePrecondition(task),
      buildPrScopePrecondition(prNumber),
    ],
  },
};

function resolveActionPolicy(actionKind) {
  return ACTION_POLICIES[actionKind] ?? {
    riskClass: 'class_c',
    phase4AssistExecutable: false,
    nonExecutableReason: 'unclassified_action_forbidden',
    buildPreconditions: ({ task }) => [
      buildTaskActivePrecondition(task),
    ],
  };
}

function buildExecutionDecision({
  phase4AssistExecutable,
  preconditions,
  nonExecutableReason,
} = {}) {
  const preconditionsSatisfied = preconditions.every((item) => item.satisfied === true);
  if (!phase4AssistExecutable) {
    return {
      executable: false,
      reason: nonExecutableReason,
    };
  }

  return {
    executable: preconditionsSatisfied,
    reason: preconditionsSatisfied
      ? 'class_a_allowlist'
      : (preconditions.find((item) => item.satisfied !== true)?.code ?? 'preconditions_unsatisfied'),
  };
}

function resolveRollbackMode(riskClass) {
  if (riskClass === 'class_a') return 'audit_only';
  if (riskClass === 'class_b') return 'not_applicable';
  return 'manual_only';
}

function buildExecutionContract({
  riskClass,
  runtimePreflightRecord,
  preconditions,
  phase4Assist,
} = {}) {
  return {
    automation_boundary: ASSIST_AUTOMATION_BOUNDARY,
    durable_policy_required: true,
    runtime_preflight_required: true,
    runtime_preflight_status: runtimePreflightRecord?.status ?? 'missing',
    idempotency_mode: ASSIST_IDEMPOTENCY_MODE,
    rollback_mode: resolveRollbackMode(riskClass),
    executable: phase4Assist?.executable === true,
    reason: phase4Assist?.reason ?? 'phase4_assist_not_executable',
    blocking_precondition_codes: preconditions
      .filter((item) => item?.satisfied !== true)
      .map((item) => item.code),
  };
}

export function buildAssistActionModel({
  controllerId,
  task,
  prNumber = null,
  derivedTrigger = 'manual',
  lifecycleTopStatus = null,
  runtimeRef = null,
  runtimePreflight = null,
  action,
} = {}) {
  const policy = resolveActionPolicy(action?.id);
  const normalizedPrNumber = toNullablePositiveInteger(prNumber);
  const runtimePreflightRecord = normalizeRuntimePreflight(runtimeRef, runtimePreflight);
  const preconditions = [
    ...policy.buildPreconditions({
      controllerId,
      task,
      prNumber: normalizedPrNumber,
      action,
    }),
    buildRuntimePreflightPrecondition(runtimeRef, runtimePreflight),
  ];
  const phase4Assist = buildExecutionDecision({
    phase4AssistExecutable: policy.phase4AssistExecutable,
    preconditions,
    nonExecutableReason: policy.nonExecutableReason,
  });
  const executionContract = buildExecutionContract({
    riskClass: policy.riskClass,
    runtimePreflightRecord,
    preconditions,
    phase4Assist,
  });

  return {
    schema_version: ASSIST_ACTION_MODEL_SCHEMA_VERSION,
    format: ASSIST_ACTION_MODEL_FORMAT,
    controller_id: controllerId == null ? null : String(controllerId),
    task_id: task?.task_id ?? null,
    pr_number: normalizedPrNumber,
    action_kind: String(action?.id),
    action_class: String(action?.action_class ?? action?.id ?? 'unknown'),
    summary: String(action?.summary ?? ''),
    commands: toStringArray(action?.commands),
    rationale: String(action?.rationale ?? ''),
    derived_trigger: String(derivedTrigger ?? 'manual'),
    lifecycle_top_status: lifecycleTopStatus == null ? null : String(lifecycleTopStatus),
    risk_class: policy.riskClass,
    runtime_preflight: runtimePreflightRecord,
    preconditions,
    phase4_assist: phase4Assist,
    execution_contract: executionContract,
  };
}

function buildFallbackActionModel(record, controllerId, task) {
  return buildAssistActionModel({
    controllerId,
    task,
    prNumber: record?.payload?.pr_number ?? null,
    derivedTrigger: record?.payload?.derived_trigger ?? 'manual',
    lifecycleTopStatus: record?.payload?.top_status ?? null,
    runtimeRef: record?.payload?.runtime_preflight?.runtime_ref
      ?? record?.payload?.action_model?.runtime_preflight?.runtime_ref
      ?? null,
    runtimePreflight: record?.payload?.runtime_preflight
      ?? record?.payload?.action_model?.runtime_preflight
      ?? null,
    action: {
      id: record?.action_kind,
      action_class: record?.payload?.action_class ?? record?.action_kind,
      summary: record?.reason ?? `Action ${record?.action_kind ?? 'unknown'}`,
      commands: record?.payload?.commands ?? [],
      rationale: record?.payload?.rationale ?? '',
    },
  });
}

function isExpiredOverride(override, timestamp) {
  if (override?.status !== 'active' || !override?.expires_at) return false;
  const expiresAt = new Date(override.expires_at);
  const now = new Date(timestamp);
  if (Number.isNaN(expiresAt.getTime()) || Number.isNaN(now.getTime())) return false;
  return expiresAt.getTime() <= now.getTime();
}

function matchesOverrideScope(override, { controllerId, taskId, prNumber } = {}) {
  switch (override?.scope_kind) {
    case 'global':
      return true;
    case 'task':
      return override.scope_id === taskId;
    case 'controller':
      return override.scope_id === controllerId;
    case 'pr':
      return override.scope_id === (prNumber == null ? null : String(prNumber));
    default:
      return false;
  }
}

function normalizeActionKindsFromOverride(value) {
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (!isPlainObject(value)) return [];

  const explicitKind = typeof value.action_kind === 'string' ? [value.action_kind] : [];
  const explicitKinds = Array.isArray(value.action_kinds)
    ? value.action_kinds.map((item) => String(item))
    : [];
  return [...explicitKind, ...explicitKinds];
}

function resolveOverrideBlockReason(override, actionKind) {
  if (override?.override_kind === 'hold_autonomy') {
    const enabled = !isPlainObject(override.value) || override.value.enabled !== false;
    return enabled ? 'override_hold_autonomy' : null;
  }

  if (override?.override_kind === 'block_action_kind') {
    const actionKinds = normalizeActionKindsFromOverride(override.value);
    return actionKinds.includes(actionKind) ? 'override_block_action_kind' : null;
  }

  return null;
}

function resolveBlockingOverrides(repository, {
  controllerId,
  task,
  actionKind,
  prNumber,
  timestamp,
} = {}) {
  const snapshot = repository.getSnapshot();

  return snapshot.state.overrides
    .filter((override) => override.status === 'active')
    .filter((override) => !isExpiredOverride(override, timestamp))
    .filter((override) => matchesOverrideScope(override, {
      controllerId,
      taskId: task?.task_id ?? null,
      prNumber,
    }))
    .map((override) => ({
      override,
      reason: resolveOverrideBlockReason(override, actionKind),
    }))
    .filter((entry) => entry.reason != null);
}

function buildBlockedActionRecord(record, model, timestamp, {
  reason,
  matchedOverrideIds = [],
  structural = false,
} = {}) {
  return createActionRecord({
    ...record,
    status: structural ? 'blocked' : record.status,
    updated_at: timestamp,
    payload: {
      ...(isPlainObject(record?.payload) ? record.payload : {}),
      action_model: cloneJsonValue(model),
      execution: {
        outcome: 'blocked',
        reason,
        blocked_at: timestamp,
        executor: 'assist_controller',
        matched_override_ids: matchedOverrideIds,
        idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
        rollback_mode: model?.execution_contract?.rollback_mode ?? null,
      },
    },
  });
}

function buildExecutedActionRecord(record, model, timestamp) {
  return createActionRecord({
    ...record,
    status: 'executed',
    updated_at: timestamp,
    payload: {
      ...(isPlainObject(record?.payload) ? record.payload : {}),
      action_model: cloneJsonValue(model),
      execution: {
        outcome: 'executed',
        reason: 'class_a_assist_execution',
        executed_at: timestamp,
        executor: 'assist_controller',
        idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
        rollback_mode: model?.execution_contract?.rollback_mode ?? null,
      },
    },
  });
}

function hasDurableAllowPolicy(record) {
  const policyDecisionId = typeof record?.payload?.policy_decision_id === 'string'
    ? record.payload.policy_decision_id.trim()
    : '';
  return policyDecisionId !== '' && record?.payload?.policy?.decision === 'allow';
}

function persistExecutionAttemptMetric(repository, {
  controllerId,
  task,
  record,
  model,
  status,
  reason,
  timestamp,
} = {}) {
  repository.upsertExecutionAttemptMetric(buildAssistExecutionAttemptMetric({
    task,
    controllerId,
    actionRecord: record,
    model,
    status,
    reason,
    now: timestamp,
  }));
}

function normalizeExecutionReason(record, model) {
  const explicitReason = record?.payload?.execution?.reason ?? null;
  if (explicitReason != null) return explicitReason;

  const policyDecision = record?.payload?.policy?.decision ?? null;
  if (policyDecision === 'deny') return 'policy_denied';
  if (policyDecision === 'downgrade') return 'policy_downgraded';

  return model?.execution_contract?.reason
    ?? model?.phase4_assist?.reason
    ?? null;
}

export function summarizeAssistActionRecord(record) {
  if (!isPlainObject(record)) return null;

  const model = isPlainObject(record?.payload?.action_model)
    ? record.payload.action_model
    : null;
  const executionContract = isPlainObject(model?.execution_contract)
    ? model.execution_contract
    : null;

  return {
    action_id: record?.action_id ?? null,
    task_id: record?.task_id ?? null,
    action_kind: record?.action_kind ?? null,
    action_class: model?.action_class ?? record?.payload?.action_class ?? null,
    status: record?.status ?? null,
    requested_by: record?.requested_by ?? null,
    risk_class: model?.risk_class ?? null,
    policy_decision: record?.payload?.policy?.decision ?? null,
    policy_decision_id: record?.payload?.policy_decision_id ?? null,
    model_executable: executionContract?.executable
      ?? model?.phase4_assist?.executable
      ?? null,
    model_reason: executionContract?.reason
      ?? model?.phase4_assist?.reason
      ?? null,
    execution_outcome: record?.payload?.execution?.outcome ?? null,
    execution_reason: normalizeExecutionReason(record, model),
    runtime_preflight_status: executionContract?.runtime_preflight_status
      ?? model?.runtime_preflight?.status
      ?? null,
    blocking_precondition_codes: executionContract?.blocking_precondition_codes ?? [],
    idempotency_mode: executionContract?.idempotency_mode ?? null,
    rollback_mode: executionContract?.rollback_mode ?? null,
    updated_at: record?.updated_at ?? null,
  };
}

export async function executeAssistActions({
  repository,
  controllerId,
  task,
  actionIds = [],
  now = new Date().toISOString(),
} = {}) {
  const timestamp = resolveNow(now);
  const uniqueActionIds = [...new Set((actionIds ?? []).map((value) => String(value)))];
  const executedActionIds = [];
  const blockedActionIds = [];

  for (const actionId of uniqueActionIds) {
    const record = repository.getSnapshot().state.actions.find((item) => item.action_id === actionId);
    if (!record || record.status !== 'proposed') {
      continue;
    }

    const model = isPlainObject(record.payload?.action_model)
      ? cloneJsonValue(record.payload.action_model)
      : buildFallbackActionModel(record, controllerId, task);

    if (!hasDurableAllowPolicy(record)) {
      const blockedRecord = buildBlockedActionRecord(record, model, timestamp, {
        reason: 'policy_allow_required',
        matchedOverrideIds: [],
        structural: true,
      });
      repository.upsertAction(blockedRecord);
      repository.appendAuditEntry({
        entityKind: 'action',
        entityId: record.action_id,
        operation: 'execution_blocked',
        actor: 'assist_controller',
        summary: `Blocked assist execution for ${record.action_id}.`,
        details: {
          action_id: record.action_id,
          action_kind: record.action_kind,
          reason: 'policy_allow_required',
          policy_decision_id: record?.payload?.policy_decision_id ?? null,
          idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
          rollback_mode: model?.execution_contract?.rollback_mode ?? null,
        },
        recordedAt: timestamp,
      });
      persistExecutionAttemptMetric(repository, {
        controllerId,
        task,
        record,
        model,
        status: 'blocked',
        reason: 'policy_allow_required',
        timestamp,
      });
      blockedActionIds.push(record.action_id);
      continue;
    }

    const blockingOverrides = resolveBlockingOverrides(repository, {
      controllerId,
      task,
      actionKind: record.action_kind,
      prNumber: toNullablePositiveInteger(model.pr_number),
      timestamp,
    });

    if (blockingOverrides.length > 0) {
      const blockedRecord = buildBlockedActionRecord(record, model, timestamp, {
        reason: blockingOverrides[0].reason,
        matchedOverrideIds: blockingOverrides.map((entry) => entry.override.override_id),
        structural: false,
      });
      repository.upsertAction(blockedRecord);
      repository.appendAuditEntry({
        entityKind: 'action',
        entityId: record.action_id,
        operation: 'execution_blocked',
        actor: 'assist_controller',
        summary: `Blocked assist execution for ${record.action_id}.`,
        details: {
          action_id: record.action_id,
          action_kind: record.action_kind,
          reason: blockingOverrides[0].reason,
          matched_override_ids: blockingOverrides.map((entry) => entry.override.override_id),
          idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
          rollback_mode: model?.execution_contract?.rollback_mode ?? null,
        },
        recordedAt: timestamp,
      });
      persistExecutionAttemptMetric(repository, {
        controllerId,
        task,
        record,
        model,
        status: 'blocked',
        reason: blockingOverrides[0].reason,
        timestamp,
      });
      blockedActionIds.push(record.action_id);
      continue;
    }

    if (model.phase4_assist?.executable !== true) {
      const blockedRecord = buildBlockedActionRecord(record, model, timestamp, {
        reason: model.phase4_assist?.reason ?? 'phase4_assist_not_executable',
        matchedOverrideIds: [],
        structural: true,
      });
      repository.upsertAction(blockedRecord);
      repository.appendAuditEntry({
        entityKind: 'action',
        entityId: record.action_id,
        operation: 'execution_blocked',
        actor: 'assist_controller',
        summary: `Blocked assist execution for ${record.action_id}.`,
        details: {
          action_id: record.action_id,
          action_kind: record.action_kind,
          reason: model.phase4_assist?.reason ?? 'phase4_assist_not_executable',
          risk_class: model.risk_class,
          runtime_preflight: cloneJsonValue(model.runtime_preflight ?? null),
          idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
          rollback_mode: model?.execution_contract?.rollback_mode ?? null,
        },
        recordedAt: timestamp,
      });
      persistExecutionAttemptMetric(repository, {
        controllerId,
        task,
        record,
        model,
        status: 'blocked',
        reason: model.phase4_assist?.reason ?? 'phase4_assist_not_executable',
        timestamp,
      });
      blockedActionIds.push(record.action_id);
      continue;
    }

    const executedRecord = buildExecutedActionRecord(record, model, timestamp);
    repository.upsertAction(executedRecord);
    repository.appendAuditEntry({
      entityKind: 'action',
      entityId: record.action_id,
      operation: 'executed',
      actor: 'assist_controller',
      summary: `Executed assist action ${record.action_id}.`,
      details: {
        action_id: record.action_id,
        action_kind: record.action_kind,
        risk_class: model.risk_class,
        task_id: task?.task_id ?? null,
        controller_id: controllerId,
        pr_number: model.pr_number ?? null,
        runtime_preflight: cloneJsonValue(model.runtime_preflight ?? null),
        policy_decision_id: record?.payload?.policy_decision_id ?? null,
        idempotency_mode: model?.execution_contract?.idempotency_mode ?? null,
        rollback_mode: model?.execution_contract?.rollback_mode ?? null,
      },
      recordedAt: timestamp,
    });
    persistExecutionAttemptMetric(repository, {
      controllerId,
      task,
      record,
      model,
      status: 'executed',
      reason: 'class_a_assist_execution',
      timestamp,
    });
    executedActionIds.push(record.action_id);
  }

  return {
    executedActionIds,
    blockedActionIds,
  };
}
