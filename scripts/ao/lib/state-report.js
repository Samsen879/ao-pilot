function formatList(values) {
  if (!values?.length) return 'none';
  return values.join(', ');
}

function formatControllers(controllers) {
  if (!controllers?.length) return 'none';
  return controllers.map((controller) => (
    `${controller.controller_id}:${controller.health_status}:${controller.configured_mode}:${controller.runtime_kind ?? 'none'}:${controller.holder_id ?? 'unheld'}`
  )).join(', ');
}

function formatContinuitySummary(report) {
  const postureCounts = report.continuity?.summary?.posture_counts ?? null;
  if (!postureCounts) return 'none';
  return [
    `active_owner=${postureCounts.active_owner ?? 0}`,
    `restore_ready=${postureCounts.restore_ready ?? 0}`,
    `handoff_pending=${postureCounts.handoff_pending ?? 0}`,
    `handoff_granted=${postureCounts.handoff_granted ?? 0}`,
    `orphaned=${postureCounts.orphaned ?? 0}`,
    `ambiguous=${postureCounts.ambiguous ?? 0}`,
    `retired=${postureCounts.retired ?? 0}`,
  ].join(', ');
}

function formatContinuityTasks(report) {
  const inspections = report.continuity?.inspections ?? [];
  if (!inspections.length) return 'none';
  return inspections
    .map((inspection) => (
      `${inspection.task_id}=${inspection.posture}->${inspection.recommended_action}`
    ))
    .join(', ');
}

function formatReviewSummary(report) {
  const summary = report.reviews?.summary ?? null;
  if (!summary) return 'none';
  return [
    `open=${summary.open_count ?? 0}`,
    `claimed=${summary.claimed_count ?? 0}`,
    `passed=${summary.passed_count ?? 0}`,
    `changes_required=${summary.changes_required_count ?? 0}`,
    `escalated=${summary.escalated_count ?? 0}`,
    `freeze_active=${summary.freeze_active_count ?? 0}`,
  ].join(', ');
}

function formatReviewTasks(report) {
  const inspections = report.reviews?.inspections ?? [];
  if (!inspections.length) return 'none';
  return inspections
    .map((inspection) => (
      `${inspection.task_id}=${inspection.posture}@${inspection.target_head_sha ?? 'none'} reviewer=${inspection.reviewer_session_name ?? 'none'} freeze=${inspection.freeze_status ?? 'released'} reason=${inspection.blocking_reason ?? 'none'}`
    ))
    .join(', ');
}

function formatTaskCloseoutSummary(report) {
  const counts = report.tasks?.summary?.closeout_status_counts ?? null;
  if (!counts) return 'none';
  return [
    `active=${counts.active ?? 0}`,
    `hold=${counts.hold ?? 0}`,
    `ready_to_retire=${counts.ready_to_retire ?? 0}`,
    `retired=${counts.retired ?? 0}`,
  ].join(', ');
}

function formatTaskCloseoutStatuses(report) {
  const inspections = report.tasks?.inspections ?? [];
  if (!inspections.length) return 'none';
  return inspections
    .map((inspection) => (
      `${inspection.task_id}=${inspection.closeout_status}${inspection.review_posture ? `[${inspection.review_posture}]` : ''}`
    ))
    .join(', ');
}

function formatDebtSummary(report) {
  const counts = report.debt?.summary?.category_counts ?? null;
  if (!counts) return 'none';
  return [
    `keep_evidence=${counts.keep_evidence ?? 0}`,
    `archive_candidate=${counts.archive_candidate ?? 0}`,
    `cleanup_candidate=${counts.cleanup_candidate ?? 0}`,
  ].join(', ');
}

function formatDebtItems(report) {
  const inspections = report.debt?.inspections ?? [];
  if (!inspections.length) return 'none';
  return inspections
    .map((inspection) => (
      `${inspection.item_kind}:${inspection.item_ref}=${inspection.category}/${inspection.recommended_action}`
    ))
    .join(', ');
}

function formatRecentAssistActions(report) {
  const actions = report.actions?.recent ?? [];
  if (!actions.length) return 'none';
  return actions.map((action) => (
    `${action.action_id}=${action.action_kind}/${action.status}/model:${action.model_reason ?? 'unknown'}/exec:${action.execution_reason ?? 'none'}`
  )).join(', ');
}

export function renderAoStateHumanSummary(report) {
  const recentAudit = (report.audit?.recent_entries ?? [])
    .map((entry) => `${entry.entity_kind}.${entry.operation}:${entry.entity_id}`);

  return [
    `state_status: ${report.bootstrapped ? 'bootstrapped' : 'missing'}`,
    `project_id: ${report.project_id}`,
    `state_root: ${report.state_root}`,
    `schema_version: ${report.schema.current_version} of ${report.schema.latest_version}`,
    `managed_tasks: ${report.summary.managed_task_count}`,
    `pr_bindings: ${report.summary.pr_binding_count}`,
    `active_ownership_leases: ${report.summary.active_ownership_lease_count}`,
    `active_controller_leases: ${report.summary.active_controller_lease_count}`,
    `actions: ${report.summary.action_count}`,
    `active_overrides: ${report.summary.active_override_count}`,
    `controller_modes: ${formatList(report.summary.controller_modes)}`,
    `controller_health: ${formatList(report.summary.controller_health)}`,
    `controller_runtime: ${formatControllers(report.controllers)}`,
    `observations: ${report.summary.observation_count}`,
    `controller_cursors: ${report.summary.controller_cursor_count}`,
    `repo_knowledge: ${report.summary.repo_knowledge_status ?? 'missing'} (profiles=${report.summary.repo_knowledge_count ?? 0}, version=${report.summary.repo_knowledge_profile_version ?? 'none'}, lint=${report.summary.repo_knowledge_lint_status ?? 'missing'})`,
    `checkpoints: ${report.summary.checkpoint_count} (valid=${report.summary.valid_checkpoint_count}, stale=${report.summary.stale_checkpoint_count}, invalid=${report.summary.invalid_checkpoint_count})`,
    `handoffs: requests=${report.summary.handoff_request_count ?? 0}, claims=${report.summary.handoff_claim_count ?? 0}, decisions=${report.summary.handoff_decision_count ?? 0}, transfers=${report.summary.handoff_transfer_count ?? 0}, active=${report.summary.active_handoff_count ?? 0}`,
    `continuity: ${formatContinuitySummary(report)}`,
    `continuity_tasks: ${formatContinuityTasks(report)}`,
    `reviews: ${formatReviewSummary(report)}`,
    `review_tasks: ${formatReviewTasks(report)}`,
    `task_closeout: ${formatTaskCloseoutSummary(report)}`,
    `task_closeout_statuses: ${formatTaskCloseoutStatuses(report)}`,
    `debt: ${formatDebtSummary(report)}`,
    `debt_items: ${formatDebtItems(report)}`,
    `assist_actions: ${formatRecentAssistActions(report)}`,
    `audit_entries: ${report.summary.audit_entry_count}`,
    `recent_audit: ${formatList(recentAudit)}`,
  ].join('\n');
}
