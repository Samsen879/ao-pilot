import { createHash } from 'node:crypto';

import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_SCHEMA_VERSION,
  createCheckpointRecord,
} from './state-contracts.js';

const VALID_TASK_SPEC_SCHEMA_VERSION = 'ao.task-spec.v1alpha1';
const VALID_RUNTIME_PREFLIGHT_SCHEMA_VERSION = 'ao.runtime-preflight.v1alpha1';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function compareRecordedAtDescending(left, right) {
  const leftRecordedAt = String(left?.recorded_at ?? '');
  const rightRecordedAt = String(right?.recorded_at ?? '');
  if (leftRecordedAt !== rightRecordedAt) {
    return rightRecordedAt.localeCompare(leftRecordedAt);
  }

  return String(right?.checkpoint_id ?? '').localeCompare(String(left?.checkpoint_id ?? ''));
}

function buildCheckpointId({ taskId, recordedAt }) {
  const digest = createHash('sha1')
    .update(JSON.stringify({
      task_id: taskId,
      recorded_at: recordedAt,
    }))
    .digest('hex')
    .slice(0, 12);
  return `checkpoint-${taskId}-${digest}`;
}

function selectLatestTaskCheckpoint(checkpoints = [], taskId) {
  return (checkpoints ?? [])
    .filter((record) => record?.task_id === taskId)
    .sort(compareRecordedAtDescending)[0] ?? null;
}

function resolveCheckpointRecord(snapshot, {
  taskId = null,
  checkpointId = null,
} = {}) {
  if (checkpointId) {
    return (snapshot?.state?.checkpoints ?? []).find((record) => record?.checkpoint_id === checkpointId) ?? null;
  }

  if (taskId) {
    return selectLatestTaskCheckpoint(snapshot?.state?.checkpoints ?? [], taskId);
  }

  return null;
}

function buildInspection(record, reasonCodes = []) {
  let state = 'valid';
  if (reasonCodes.some((code) => code.startsWith('checkpoint_') || code.endsWith('_mixed_version') || code.endsWith('_not_clean'))) {
    state = 'invalid';
  } else if (reasonCodes.length > 0) {
    state = 'stale';
  }

  return {
    checkpoint_id: record?.checkpoint_id ?? null,
    task_id: record?.task_id ?? null,
    state,
    reason_codes: [...new Set(reasonCodes)],
    record,
  };
}

function validateCheckpointRecord(snapshot, record) {
  if (!record) {
    return buildInspection(null, ['checkpoint_missing']);
  }

  const reasonCodes = [];
  const checkpointSnapshot = record.snapshot ?? {};

  if (checkpointSnapshot.schema_version !== CHECKPOINT_SCHEMA_VERSION) {
    reasonCodes.push('checkpoint_mixed_version');
  }
  if (checkpointSnapshot.format !== CHECKPOINT_FORMAT) {
    reasonCodes.push('checkpoint_invalid_format');
  }

  const taskRef = checkpointSnapshot.task_ref ?? {};
  const currentTask = (snapshot?.state?.managed_tasks ?? []).find((task) => task?.task_id === record.task_id) ?? null;
  if (!currentTask) {
    reasonCodes.push('managed_task_missing');
  } else {
    if (
      currentTask.issue_number !== taskRef.issue_number
      || currentTask.title !== taskRef.title
      || currentTask.branch_name !== taskRef.branch_name
      || currentTask.worktree_path !== taskRef.worktree_path
    ) {
      reasonCodes.push('managed_task_advanced');
    }
    if (currentTask.branch_name !== taskRef.branch_name || currentTask.worktree_path !== taskRef.worktree_path) {
      reasonCodes.push('managed_task_binding_changed');
    }
    if (currentTask.status === 'retired') {
      reasonCodes.push('managed_task_retired');
    }
  }

  const taskSpecRef = checkpointSnapshot.verification_ref?.task_spec ?? null;
  if (!taskSpecRef) {
    reasonCodes.push('checkpoint_task_spec_missing');
  } else {
    if (taskSpecRef.snapshot_schema_version !== VALID_TASK_SPEC_SCHEMA_VERSION) {
      reasonCodes.push('task_spec_mixed_version');
    }

    const currentTaskSpec = (snapshot?.state?.task_specs ?? []).find(
      (taskSpec) => taskSpec?.task_id === taskSpecRef.task_id,
    ) ?? null;
    if (!currentTaskSpec) {
      reasonCodes.push('task_spec_missing');
    } else {
      if (currentTaskSpec.updated_at !== taskSpecRef.updated_at) {
        reasonCodes.push('task_spec_advanced');
      }
      if (currentTaskSpec.snapshot?.schema_version !== VALID_TASK_SPEC_SCHEMA_VERSION) {
        reasonCodes.push('task_spec_mixed_version');
      }
      if (currentTaskSpec.state !== taskSpecRef.state || currentTaskSpec.state !== 'valid') {
        reasonCodes.push('task_spec_invalid');
      }
    }
  }

  const runtimePreflightRef = checkpointSnapshot.verification_ref?.runtime_preflight ?? null;
  if (!runtimePreflightRef) {
    reasonCodes.push('checkpoint_runtime_preflight_missing');
  } else {
    if (runtimePreflightRef.snapshot_schema_version !== VALID_RUNTIME_PREFLIGHT_SCHEMA_VERSION) {
      reasonCodes.push('runtime_preflight_mixed_version');
    }

    const currentRuntimePreflight = (snapshot?.state?.runtime_preflights ?? []).find(
      (runtimePreflight) => runtimePreflight?.runtime_ref === runtimePreflightRef.runtime_ref,
    ) ?? null;
    if (!currentRuntimePreflight) {
      reasonCodes.push('runtime_preflight_missing');
    } else {
      if (currentRuntimePreflight.snapshot?.schema_version !== VALID_RUNTIME_PREFLIGHT_SCHEMA_VERSION) {
        reasonCodes.push('runtime_preflight_mixed_version');
      }
      if (
        currentRuntimePreflight.recorded_at !== runtimePreflightRef.recorded_at
        || currentRuntimePreflight.replay_key !== runtimePreflightRef.replay_key
      ) {
        reasonCodes.push('runtime_preflight_advanced');
      }
      if (currentRuntimePreflight.status !== 'clean' || runtimePreflightRef.status !== 'clean') {
        reasonCodes.push('runtime_preflight_not_clean');
      }
    }
  }

  const executionRef = checkpointSnapshot.execution_ref ?? null;
  if (!executionRef) {
    reasonCodes.push('checkpoint_execution_ref_missing');
  } else {
    const currentControllerMode = (snapshot?.state?.controller_modes ?? []).find(
      (recordItem) => recordItem?.controller_id === executionRef.controller_id,
    ) ?? null;
    if (!currentControllerMode) {
      reasonCodes.push('controller_mode_missing');
    } else if (
      currentControllerMode.mode !== executionRef.controller_mode
      || currentControllerMode.updated_at !== executionRef.controller_mode_updated_at
    ) {
      reasonCodes.push('controller_mode_advanced');
    }
  }

  const prBindingRef = checkpointSnapshot.task_ref?.pr_binding ?? null;
  if (prBindingRef) {
    const currentBinding = (snapshot?.state?.pr_bindings ?? []).find((binding) => (
      binding?.task_id === record.task_id
        && binding?.pr_number === prBindingRef.pr_number
        && binding?.status === 'bound'
    )) ?? null;
    if (!currentBinding) {
      reasonCodes.push('pr_binding_missing');
    } else if (
      currentBinding.updated_at !== prBindingRef.updated_at
      || currentBinding.branch_name !== prBindingRef.branch_name
      || currentBinding.base_branch !== prBindingRef.base_branch
    ) {
      reasonCodes.push('pr_binding_advanced');
    }
  }

  return buildInspection(record, reasonCodes);
}

function resolveResumeSafeRefs(snapshot, taskId, controllerId) {
  const task = (snapshot?.state?.managed_tasks ?? []).find((record) => record?.task_id === taskId) ?? null;
  if (!task) {
    throw new Error(`Cannot capture checkpoint for missing task ${taskId}`);
  }

  const taskSpec = (snapshot?.state?.task_specs ?? []).find((record) => record?.task_id === taskId) ?? null;
  if (!taskSpec || taskSpec.state !== 'valid') {
    throw new Error(`Cannot capture checkpoint for ${taskId} without a valid task spec`);
  }

  const runtimeRef = taskSpec.snapshot?.spec?.runtime_ref ?? null;
  const runtimePreflight = runtimeRef == null
    ? null
    : ((snapshot?.state?.runtime_preflights ?? []).find((record) => record?.runtime_ref === runtimeRef) ?? null);
  if (!runtimePreflight || runtimePreflight.status !== 'clean') {
    throw new Error(`Cannot capture checkpoint for ${taskId} without a clean runtime preflight`);
  }

  const controllerMode = (snapshot?.state?.controller_modes ?? []).find(
    (record) => record?.controller_id === controllerId,
  ) ?? null;
  if (!controllerMode) {
    throw new Error(`Cannot capture checkpoint for ${taskId} without controller mode ${controllerId}`);
  }

  const prBinding = (snapshot?.state?.pr_bindings ?? []).find((record) => (
    record?.task_id === taskId && record?.status === 'bound'
  )) ?? null;

  return {
    task,
    taskSpec,
    runtimePreflight,
    controllerMode,
    prBinding,
  };
}

export function createCheckpointStore({
  repository,
  now = () => new Date().toISOString(),
} = {}) {
  return {
    captureCheckpoint({
      taskId,
      controllerId = 'default',
      derivedTrigger = null,
      lifecycleTopStatus = null,
      observedAt = resolveNow(now),
      actionIds = [],
      reason = 'controller_checkpoint',
      createdBy = 'checkpoint_store',
    } = {}) {
      const snapshot = repository.getSnapshot();
      const {
        task,
        taskSpec,
        runtimePreflight,
        controllerMode,
        prBinding,
      } = resolveResumeSafeRefs(snapshot, taskId, controllerId);
      const recordedAt = resolveNow(now);

      const checkpointRecord = createCheckpointRecord({
        checkpoint_id: buildCheckpointId({
          taskId,
          recordedAt,
        }),
        task_id: task.task_id,
        recorded_at: recordedAt,
        created_by: createdBy,
        reason,
        snapshot: {
          schema_version: CHECKPOINT_SCHEMA_VERSION,
          format: CHECKPOINT_FORMAT,
          task_ref: {
            task_id: task.task_id,
            issue_number: task.issue_number ?? null,
            title: task.title,
            branch_name: task.branch_name ?? null,
            worktree_path: task.worktree_path ?? null,
            updated_at: task.updated_at,
            pr_binding: prBinding == null ? null : {
              binding_id: prBinding.binding_id,
              pr_number: prBinding.pr_number,
              branch_name: prBinding.branch_name ?? null,
              base_branch: prBinding.base_branch ?? null,
              updated_at: prBinding.updated_at,
              status: prBinding.status,
            },
          },
          verification_ref: {
            task_spec: {
              task_id: taskSpec.task_id,
              updated_at: taskSpec.updated_at,
              state: taskSpec.state,
              snapshot_schema_version: taskSpec.snapshot?.schema_version ?? 'missing',
            },
            runtime_preflight: {
              runtime_ref: runtimePreflight.runtime_ref,
              recorded_at: runtimePreflight.recorded_at,
              replay_key: runtimePreflight.replay_key,
              status: runtimePreflight.status,
              snapshot_schema_version: runtimePreflight.snapshot?.schema_version ?? 'missing',
            },
          },
          execution_ref: {
            controller_id: controllerMode.controller_id,
            controller_mode: controllerMode.mode,
            controller_mode_updated_at: controllerMode.updated_at,
            derived_trigger: derivedTrigger,
            lifecycle_top_status: lifecycleTopStatus,
            observed_at: observedAt,
            action_ids: actionIds,
          },
        },
      });

      return repository.upsertCheckpoint(checkpointRecord);
    },

    inspectCheckpoint({
      taskId = null,
      checkpointId = null,
    } = {}) {
      const snapshot = repository.getSnapshot();
      const record = resolveCheckpointRecord(snapshot, {
        taskId,
        checkpointId,
      });
      return validateCheckpointRecord(snapshot, record);
    },

    inspectAllCheckpoints() {
      const snapshot = repository.getSnapshot();
      return [...(snapshot.state.checkpoints ?? [])]
        .sort(compareRecordedAtDescending)
        .map((record) => validateCheckpointRecord(snapshot, record));
    },

    loadCheckpointForResume({
      taskId = null,
      checkpointId = null,
    } = {}) {
      const inspection = this.inspectCheckpoint({
        taskId,
        checkpointId,
      });

      if (inspection.state === 'valid') {
        return inspection;
      }

      if (inspection.state === 'stale') {
        throw new Error(`Cannot resume from stale checkpoint: ${inspection.reason_codes.join(', ')}`);
      }

      throw new Error(`Cannot resume from invalid checkpoint: ${inspection.reason_codes.join(', ')}`);
    },
  };
}
