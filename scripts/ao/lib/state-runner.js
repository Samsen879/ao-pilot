import { createCheckpointStore } from './checkpoint-store.js';
import { summarizeAssistActionRecord } from './action-executor.js';
import {
  buildTaskContinuityFromSnapshot,
  summarizeContinuityReports,
} from './continuity.js';
import { buildHistoricalDebtReport } from './debt-report.js';
import { createHandoffProtocol } from './handoff-protocol.js';
import { inspectRepoKnowledgeRecordState } from './repo-knowledge.js';
import { deriveReviewPosture } from './review-contracts.js';
import { buildAoMetricsReport } from './run-metrics.js';
import * as fs from 'node:fs';
import path from 'node:path';

import { createStateRepository } from './state-repository.js';
import {
  inspectTaskGraph,
  terminalEvidenceFromManagedTasks,
} from './task-graph.js';

export const DEFAULT_PROJECT_ID = 'my-project';
export const AO_STATE_SCHEMA_VERSION = 'ao.state.v1alpha1';
export const AO_STATE_REPORT_FORMAT = 'ao_state_report';

function findRepoRoot(startCwd) {
  let currentPath = path.resolve(startCwd);

  while (true) {
    if (fs.existsSync(path.join(currentPath, '.git'))) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

function summarizeControllerModes(controllerModes) {
  return [...(controllerModes ?? [])]
    .map((record) => `${record.controller_id}=${record.mode}`)
    .sort((left, right) => left.localeCompare(right));
}

function summarizeCountMap(keys, records = [], keyName) {
  const summary = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const record of records) {
    const key = record?.[keyName];
    if (key == null || !Object.hasOwn(summary, key)) continue;
    summary[key] += 1;
  }
  return summary;
}

function compareTimestampDescending(left, right) {
  const leftTime = left ? new Date(left).getTime() : 0;
  const rightTime = right ? new Date(right).getTime() : 0;
  return rightTime - leftTime;
}

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function deriveReviewBlockingReason(posture) {
  if (posture === 'review_pending') return 'independent_review_active';
  if (posture === 'review_changes_required') return 'changes_requested';
  if (posture === 'review_escalated') return 'human_escalation_required';
  return null;
}

function latestTaskReviewRecord(snapshot, taskId) {
  return [...(snapshot?.state?.review_records ?? [])]
    .filter((record) => record?.task_id === taskId)
    .sort((left, right) => {
      const byTimestamp = compareIsoDescending(left?.updated_at, right?.updated_at);
      if (byTimestamp !== 0) return byTimestamp;
      return String(right?.review_id ?? '').localeCompare(String(left?.review_id ?? ''));
    })[0] ?? null;
}

function buildTaskReviewInspection(snapshot, taskId) {
  const reviewRecord = latestTaskReviewRecord(snapshot, taskId);
  if (!reviewRecord) return null;

  const posture = deriveReviewPosture(reviewRecord);
  if (posture.posture === 'idle') return null;

  return {
    task_id: reviewRecord.task_id,
    issue_number: reviewRecord.issue_number ?? null,
    review_id: reviewRecord.review_id,
    implementation_session_name: reviewRecord.implementation_session_name ?? null,
    reviewer_session_name: reviewRecord.reviewer_session_name ?? null,
    target_branch: reviewRecord.target_branch ?? null,
    target_head_sha: reviewRecord.target_head_sha ?? null,
    status: reviewRecord.status,
    verdict: reviewRecord.verdict,
    freeze_status: reviewRecord.freeze_status,
    posture: posture.posture,
    freeze_active: posture.freeze_active,
    blocking_reason: deriveReviewBlockingReason(posture.posture),
  };
}

function summarizeReviewInspections(reviewInspections = []) {
  return {
    open_count: reviewInspections.filter((inspection) => inspection.status === 'open').length,
    claimed_count: reviewInspections.filter((inspection) => inspection.status === 'claimed').length,
    passed_count: reviewInspections.filter((inspection) => inspection.status === 'passed').length,
    changes_required_count: reviewInspections.filter((inspection) => inspection.status === 'changes_required').length,
    escalated_count: reviewInspections.filter((inspection) => inspection.status === 'escalated').length,
    freeze_active_count: reviewInspections.filter((inspection) => inspection.freeze_active === true).length,
  };
}

function buildTaskCloseoutInspection({
  snapshot,
  task,
  continuityInspection = null,
  handoffInspection = null,
  reviewInspection = null,
} = {}) {
  const boundPrCount = snapshot.state.pr_bindings.filter(
    (binding) => binding.task_id === task.task_id && binding.status === 'bound',
  ).length;
  const activeOwnershipLeaseCount = snapshot.state.ownership_leases.filter(
    (lease) => lease.task_id === task.task_id && lease.status === 'active',
  ).length;
  const activeHandoffCount = handoffInspection && ['open', 'claimed', 'accepted'].includes(handoffInspection.top_status)
    ? 1
    : 0;

  let closeoutStatus = 'active';
  let recommendedAction = 'continue_management';

  if (task.status === 'retired') {
    closeoutStatus = 'retired';
    recommendedAction = 'none';
  } else if (
    reviewInspection?.freeze_active === true
  ) {
    closeoutStatus = 'hold';
    recommendedAction = 'hold';
  } else if (
    task.status === 'paused'
    && boundPrCount === 0
    && activeOwnershipLeaseCount === 0
    && activeHandoffCount === 0
  ) {
    closeoutStatus = 'ready_to_retire';
    recommendedAction = 'retire_managed_task';
  } else if (
    task.status === 'paused'
    || continuityInspection?.recommended_action === 'hold_for_human'
  ) {
    closeoutStatus = 'hold';
    recommendedAction = 'hold';
  }

  return {
    task_id: task.task_id,
    issue_number: task.issue_number ?? null,
    task_status: task.status,
    continuity_posture: continuityInspection?.posture ?? null,
    continuity_recommended_action: continuityInspection?.recommended_action ?? null,
    bound_pr_count: boundPrCount,
    active_ownership_lease_count: activeOwnershipLeaseCount,
    active_handoff_count: activeHandoffCount,
    closeout_status: closeoutStatus,
    recommended_action: recommendedAction,
    review_posture: reviewInspection?.posture ?? null,
    review_freeze_status: reviewInspection?.freeze_status ?? null,
    review_blocking_reason: reviewInspection?.blocking_reason ?? null,
    review_reviewer_session_name: reviewInspection?.reviewer_session_name ?? null,
    review_target_head_sha: reviewInspection?.target_head_sha ?? null,
  };
}

function buildControllerRuntimeSummary({
  snapshot,
  projectId,
  now,
} = {}) {
  const controllerModes = snapshot.state.controller_modes ?? [];
  const controllerLeases = snapshot.state.controller_leases ?? [];
  const controllerIds = [...new Set([
    ...controllerModes.map((record) => record.controller_id),
    ...controllerLeases.map((record) => record.controller_id),
  ])].sort((left, right) => left.localeCompare(right));

  const currentTime = new Date(now).getTime();
  const controllers = controllerIds.map((controllerId) => {
    const modeRecord = controllerModes.find((record) => record.controller_id === controllerId) ?? null;
    const leases = controllerLeases
      .filter((record) => record.controller_id === controllerId)
      .sort((left, right) => compareTimestampDescending(
        left.heartbeat_at ?? left.released_at ?? left.acquired_at ?? null,
        right.heartbeat_at ?? right.released_at ?? right.acquired_at ?? null,
      ));
    const activeLease = leases.find((record) => record.status === 'active') ?? null;
    const latestLease = activeLease ?? leases[0] ?? null;
    const activeLeaseFresh = activeLease != null && new Date(activeLease.expires_at).getTime() > currentTime;

    let healthStatus = 'idle';
    if (modeRecord?.mode === 'off' && !activeLease) {
      healthStatus = 'off';
    } else if (activeLease) {
      healthStatus = activeLeaseFresh ? 'healthy' : 'stale';
    }

    return {
      project_id: projectId,
      controller_id: controllerId,
      configured_mode: modeRecord?.mode ?? 'off',
      runtime_kind: latestLease?.runtime_kind ?? null,
      health_status: healthStatus,
      lease_status: latestLease?.status ?? 'none',
      holder_id: latestLease?.holder_id ?? null,
      holder_type: latestLease?.holder_type ?? null,
      incarnation_id: latestLease?.incarnation_id ?? null,
      heartbeat_at: latestLease?.heartbeat_at ?? null,
      expires_at: latestLease?.expires_at ?? null,
      lease_timeout_ms: latestLease?.lease_timeout_ms ?? null,
      poll_interval_ms: latestLease?.poll_interval_ms ?? null,
      shutdown_timeout_ms: latestLease?.shutdown_timeout_ms ?? null,
      last_run_started_at: latestLease?.last_run_started_at ?? null,
      last_run_completed_at: latestLease?.last_run_completed_at ?? null,
      last_run_status: latestLease?.last_run_status ?? null,
    };
  });

  return {
    controllers,
    controllerHealth: controllers.map((controller) => (
      `${controller.controller_id}:${controller.health_status}:${controller.runtime_kind ?? 'none'}`
    )),
  };
}

export async function loadAoStateReport({
  cwd = process.cwd(),
  repoRoot = null,
  projectId = DEFAULT_PROJECT_ID,
  auditLimit = 5,
  now = new Date().toISOString(),
  repoInventory = null,
} = {}) {
  const resolvedRepoRoot = repoRoot ?? findRepoRoot(cwd);
  if (!resolvedRepoRoot) {
    throw new Error(`Could not locate repo root from ${cwd}`);
  }

  const repository = createStateRepository({
    repoRoot: resolvedRepoRoot,
    projectId,
  });
  const snapshot = repository.getSnapshot();
  const auditEntries = repository.listAuditEntries();
  const recentEntries = auditLimit == null ? auditEntries : auditEntries.slice(-auditLimit);
  const checkpointInspections = createCheckpointStore({
    repository,
  }).inspectAllCheckpoints();
  const handoffInspections = createHandoffProtocol({
    repository,
    now,
  }).inspectAllHandoffs();
  const validCheckpointCount = checkpointInspections.filter((inspection) => inspection.state === 'valid').length;
  const staleCheckpointCount = checkpointInspections.filter((inspection) => inspection.state === 'stale').length;
  const invalidCheckpointCount = checkpointInspections.filter((inspection) => inspection.state === 'invalid').length;
  const activeHandoffCount = snapshot.state.handoff_requests.filter((request) => (
    ['open', 'accepted'].includes(request.status)
  )).length;
  const repoKnowledgeRecord = (snapshot.state.repo_knowledge ?? []).find(
    (record) => record?.project_id === projectId,
  ) ?? null;
  const repoKnowledgeInspection = inspectRepoKnowledgeRecordState(repoKnowledgeRecord);
  const metricsReport = buildAoMetricsReport({
    projectId,
    repoRoot: resolvedRepoRoot,
    snapshot,
    traceLimit: auditLimit,
  });
  const controllerRuntime = buildControllerRuntimeSummary({
    snapshot,
    projectId,
    now,
  });
  const continuityInspections = snapshot.state.managed_tasks
    .map((task) => buildTaskContinuityFromSnapshot({
      snapshot,
      taskId: task.task_id,
      checkpointInspections,
      handoffInspections,
    }))
    .filter(Boolean);
  const continuityByTaskId = new Map(
    continuityInspections.map((inspection) => [inspection.task_id, inspection]),
  );
  const handoffByTaskId = new Map(
    handoffInspections.map((inspection) => [inspection.task_id, inspection]),
  );
  const reviewInspections = snapshot.state.managed_tasks
    .map((task) => buildTaskReviewInspection(snapshot, task.task_id))
    .filter(Boolean)
    .sort((left, right) => String(left.task_id).localeCompare(String(right.task_id)));
  const reviewByTaskId = new Map(
    reviewInspections.map((inspection) => [inspection.task_id, inspection]),
  );
  const taskInspections = snapshot.state.managed_tasks
    .map((task) => buildTaskCloseoutInspection({
      snapshot,
      task,
      continuityInspection: continuityByTaskId.get(task.task_id) ?? null,
      handoffInspection: handoffByTaskId.get(task.task_id) ?? null,
      reviewInspection: reviewByTaskId.get(task.task_id) ?? null,
    }))
    .sort((left, right) => String(left.task_id).localeCompare(String(right.task_id)));
  const recentActions = [...(snapshot.state.actions ?? [])]
    .sort((left, right) => compareTimestampDescending(
      left?.updated_at ?? left?.created_at ?? null,
      right?.updated_at ?? right?.created_at ?? null,
    ))
    .slice(0, auditLimit)
    .map((record) => summarizeAssistActionRecord(record))
    .filter(Boolean);
  const debtReport = buildHistoricalDebtReport({
    repoRoot: resolvedRepoRoot,
    snapshot,
    taskInspections,
    repoInventory,
    now,
  });
  const taskGraph = inspectTaskGraph({
    tasks: snapshot.state.managed_tasks,
    relations: snapshot.state.task_relations,
    terminalEvidence: terminalEvidenceFromManagedTasks(snapshot.state.managed_tasks),
  });

  return {
    schema_version: AO_STATE_SCHEMA_VERSION,
    report_format: AO_STATE_REPORT_FORMAT,
    project_id: projectId,
    bootstrapped: snapshot.bootstrapped,
    repo_root: resolvedRepoRoot,
    state_root: snapshot.paths.stateRoot,
    schema: snapshot.schema,
    state: snapshot.state,
    summary: {
      managed_task_count: snapshot.state.managed_tasks.length,
      task_graph_healthy: taskGraph.healthy,
      task_graph_finding_count: taskGraph.findings.length,
      pr_binding_count: snapshot.state.pr_bindings.length,
      active_ownership_lease_count: snapshot.state.ownership_leases.filter((lease) => lease.status === 'active').length,
      active_controller_lease_count: snapshot.state.controller_leases.filter((lease) => lease.status === 'active').length,
      action_count: snapshot.state.actions.length,
      active_override_count: snapshot.state.overrides.filter((override) => override.status === 'active').length,
      controller_mode_count: snapshot.state.controller_modes.length,
      controller_modes: summarizeControllerModes(snapshot.state.controller_modes),
      controller_health: controllerRuntime.controllerHealth,
      observation_count: snapshot.state.observations.length,
      controller_cursor_count: snapshot.state.controller_cursors.length,
      checkpoint_count: checkpointInspections.length,
      valid_checkpoint_count: validCheckpointCount,
      stale_checkpoint_count: staleCheckpointCount,
      invalid_checkpoint_count: invalidCheckpointCount,
      handoff_request_count: snapshot.state.handoff_requests.length,
      handoff_claim_count: snapshot.state.handoff_claims.length,
      handoff_decision_count: snapshot.state.handoff_decisions.length,
      handoff_transfer_count: snapshot.state.handoff_transfers.length,
      active_handoff_count: activeHandoffCount,
      controller_run_metric_count: snapshot.state.controller_run_metrics.length,
      execution_attempt_metric_count: snapshot.state.execution_attempt_metrics.length,
      repo_knowledge_count: snapshot.state.repo_knowledge.length,
      repo_knowledge_status: repoKnowledgeInspection.status,
      repo_knowledge_profile_version: repoKnowledgeRecord?.profile_version ?? null,
      repo_knowledge_lint_status: repoKnowledgeRecord?.lint_status ?? null,
      audit_entry_count: auditEntries.length,
    },
    controllers: controllerRuntime.controllers,
    continuity: {
      summary: summarizeContinuityReports(continuityInspections),
      inspections: continuityInspections,
    },
    reviews: {
      summary: summarizeReviewInspections(reviewInspections),
      inspections: reviewInspections,
    },
    tasks: {
      summary: {
        closeout_status_counts: summarizeCountMap(
          ['active', 'hold', 'ready_to_retire', 'retired'],
          taskInspections,
          'closeout_status',
        ),
      },
      inspections: taskInspections,
    },
    task_graph: taskGraph,
    debt: debtReport,
    actions: {
      recent: recentActions,
    },
    checkpoints: {
      inspections: checkpointInspections,
    },
    handoffs: {
      inspections: handoffInspections,
    },
    repo_knowledge: {
      record: repoKnowledgeRecord,
      inspection: repoKnowledgeInspection,
    },
    metrics: {
      summary: metricsReport.summary,
      recent_traces: metricsReport.recent_traces,
    },
    audit: {
      recent_entries: recentEntries,
    },
  };
}
