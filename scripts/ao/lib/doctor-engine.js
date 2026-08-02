import {
  DOCTOR_REPORT_FORMAT,
  DOCTOR_SCHEMA_VERSION,
  createDoctorFinding,
  createDoctorSuggestion,
} from './doctor-contracts.js';
import { createHandoffProtocol } from './handoff-protocol.js';
import { RUNTIME_PREFLIGHT_SCHEMA_VERSION } from './runtime-contracts.js';
import { CONTROL_PLANE_LATEST_VERSION } from './state-contracts.js';
import { TASK_SPEC_SCHEMA_VERSION } from './task-spec.js';

const RECONCILIATION_FINDING_SOURCE_AREAS = {
  no_orchestrator_session: 'ao',
  multiple_orchestrator_sessions: 'ao',
  stale_orchestrator_session: 'ao',
  stale_worker_session: 'ao',
  multiple_candidate_workers: 'ao',
  ao_github_branch_disagreement: 'cross_source',
  orphan_open_pr: 'cross_source',
  review_blocked: 'github',
  ci_blocked: 'github',
  merge_conflict_blocked: 'github',
  mergeability_unknown: 'github',
  release_readiness_ambiguous: 'cross_source',
};

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function buildSuggestionTemplates(scope, { runtimeStore = null } = {}) {
  const projectId = scope?.project_id ?? 'my-project';
  const runtimeStoreArgument = runtimeStore == null || String(runtimeStore).trim() === ''
    ? ''
    : ` --runtime-store ${shellQuote(String(runtimeStore).trim())}`;
  const reconcileCommand = scope?.mode === 'pr' && Number.isInteger(scope?.pr_number)
    ? `node scripts/ao-reconcile.js --pr ${scope.pr_number} --json --strict`
    : `node scripts/ao-reconcile.js --project ${projectId} --json`;

  return {
    ao_runtime_status: {
      action_class: 'runtime_check',
      summary: 'Inspect AO runtime status.',
      commands: [`ao-pilot status --project ${projectId} --json${runtimeStoreArgument}`],
      rationale: 'AO runtime visibility or continuity needs direct inspection.',
    },
    ao_artifact_review: {
      action_class: 'artifact_review',
      summary: 'Inspect local AO artifact leftovers.',
      commands: [
        'test -d ao-artifacts && find ao-artifacts -maxdepth 2 -mindepth 1 | head',
        'test -e .ao-current-issue && ls -ld .ao-current-issue',
        'test -e ao-task-state.json && ls -ld ao-task-state.json',
        'test -e ao-queue.txt && ls -ld ao-queue.txt',
      ],
      rationale: 'Artifact leftovers may affect continuity diagnosis.',
    },
    git_branch_context: {
      action_class: 'git_check',
      summary: 'Inspect the current branch and HEAD context.',
      commands: [
        'git branch --show-current',
        'git rev-parse HEAD',
        'git status --short',
      ],
      rationale: 'Local branch posture may not match the diagnosis target.',
    },
    git_status: {
      action_class: 'git_check',
      summary: 'Inspect current worktree changes.',
      commands: ['git status --short'],
      rationale: 'Dirty local changes may affect continuity handling.',
    },
    git_upstream: {
      action_class: 'git_check',
      summary: 'Inspect upstream tracking state.',
      commands: ['git rev-parse --abbrev-ref --symbolic-full-name @{u}'],
      rationale: 'Missing upstream tracking weakens branch continuity diagnosis.',
    },
    human_review: {
      action_class: 'human_review',
      summary: 'Escalate to human review.',
      commands: [],
      rationale: 'The diagnosis remains ambiguous or blocked.',
    },
    reconcile_scope: {
      action_class: 'reconcile',
      summary: 'Re-run the phase-1 reconciliation command for this scope.',
      commands: [reconcileCommand],
      rationale: 'Cross-source truth should be refreshed before continuing.',
    },
  };
}

function deriveReconciliationHealth(reconciliationReport) {
  if (!reconciliationReport) return 'failed';

  const sourceStates = Object.values(reconciliationReport.source_health ?? {});
  if (sourceStates.some((state) => state === 'failed' || state === 'degraded')) {
    return 'degraded';
  }

  return 'ok';
}

function deriveGitHealth(localState) {
  if (!localState?.git_observable) return 'failed';
  if (!localState.repo_root || !localState.head_sha) return 'degraded';
  if (localState.upstream_tracking !== 'present') return 'degraded';
  return 'ok';
}

function deriveWorktreeHealth(localState) {
  if (!localState?.git_observable) return 'failed';
  if (
    localState.worktree_dirty == null
    || localState.staged_changes == null
    || localState.unstaged_changes == null
  ) {
    return 'failed';
  }
  return 'ok';
}

function deriveSourceHealth(reconciliationReport, localState) {
  return {
    reconciliation: deriveReconciliationHealth(reconciliationReport),
    ao: reconciliationReport?.source_health?.ao ?? 'failed',
    github: reconciliationReport?.source_health?.github ?? 'failed',
    git: deriveGitHealth(localState),
    worktree: deriveWorktreeHealth(localState),
  };
}

function mapReconciliationFindingSourceArea(code) {
  return RECONCILIATION_FINDING_SOURCE_AREAS[code] ?? 'cross_source';
}

function mapReconciliationSuggestionIds(code) {
  if (['no_orchestrator_session', 'multiple_orchestrator_sessions', 'stale_orchestrator_session', 'stale_worker_session'].includes(code)) {
    return ['ao_runtime_status'];
  }
  if (['review_blocked', 'ci_blocked', 'merge_conflict_blocked'].includes(code)) {
    return ['human_review'];
  }
  if ([
    'orphan_open_pr',
    'multiple_candidate_workers',
    'ao_github_branch_disagreement',
    'release_readiness_ambiguous',
    'mergeability_unknown',
  ].includes(code)) {
    return ['reconcile_scope', 'human_review'];
  }
  return ['reconcile_scope'];
}

function preserveReconciliationFindings(reconciliationReport) {
  return (reconciliationReport?.findings ?? []).map((finding) => createDoctorFinding({
    code: finding.code,
    severity: finding.severity,
    origin: 'reconciliation',
    source_area: mapReconciliationFindingSourceArea(finding.code),
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    summary: finding.summary,
    details: finding.details ?? [],
    evidence_refs: finding.evidence_refs ?? [],
    suggestion_ids: mapReconciliationSuggestionIds(finding.code),
  }));
}

function deriveExpectedTarget(scope, reconciliationReport) {
  const assessments = reconciliationReport?.pr_assessments ?? [];
  if (scope?.mode === 'pr') {
    return {
      targetCount: assessments.length,
      branchName: assessments[0]?.branch_name ?? null,
    };
  }
  if (assessments.length === 1) {
    return {
      targetCount: 1,
      branchName: assessments[0]?.branch_name ?? null,
    };
  }
  return {
    targetCount: assessments.length,
    branchName: null,
  };
}

function buildTaskSpecFindings({ controlPlaneSnapshot, projectId }) {
  const findings = [];
  if (!controlPlaneSnapshot?.bootstrapped) return findings;

  const currentVersion = Number(controlPlaneSnapshot?.schema?.current_version ?? 0);
  if (currentVersion < CONTROL_PLANE_LATEST_VERSION) {
    findings.push(createDoctorFinding({
      code: 'task_spec_state_schema_stale',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'control_plane',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'Control-plane TaskSpec state is on an older schema version.',
      details: [`current_version: ${currentVersion}`, `latest_version: ${CONTROL_PLANE_LATEST_VERSION}`],
      evidence_refs: [],
      suggestion_ids: ['human_review'],
    }));
  }

  const taskSpecsByTaskId = new Map((controlPlaneSnapshot?.state?.task_specs ?? []).map((record) => [record?.task_id, record]));
  for (const task of controlPlaneSnapshot?.state?.managed_tasks ?? []) {
    const taskSpecRecord = taskSpecsByTaskId.get(task?.task_id);

    if (!taskSpecRecord) {
      findings.push(createDoctorFinding({
        code: 'task_spec_missing',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task is missing durable TaskSpec state.',
        details: [task?.title ?? task?.task_id ?? 'unknown-task'],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
      continue;
    }

    if (taskSpecRecord?.snapshot?.schema_version !== TASK_SPEC_SCHEMA_VERSION) {
      findings.push(createDoctorFinding({
        code: 'task_spec_mixed_version',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task has a mixed-version TaskSpec snapshot.',
        details: [
          `snapshot_schema_version: ${taskSpecRecord?.snapshot?.schema_version ?? 'missing'}`,
          `expected_schema_version: ${TASK_SPEC_SCHEMA_VERSION}`,
        ],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
      continue;
    }

    if (
      taskSpecRecord?.state !== 'valid'
      || taskSpecRecord?.snapshot?.valid === false
      || (taskSpecRecord?.snapshot?.findings?.length ?? 0) > 0
    ) {
      findings.push(createDoctorFinding({
        code: 'task_spec_invalid',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task has invalid TaskSpec state.',
        details: (taskSpecRecord?.snapshot?.findings ?? []).map((finding) => finding.code),
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    }
  }

  return findings;
}

function buildRuntimePreflightFindings({ controlPlaneSnapshot, projectId }) {
  const findings = [];
  if (!controlPlaneSnapshot?.bootstrapped) return findings;

  const taskSpecsByTaskId = new Map(
    (controlPlaneSnapshot?.state?.task_specs ?? []).map((record) => [record?.task_id, record]),
  );
  const runtimePreflightsByRef = new Map(
    (controlPlaneSnapshot?.state?.runtime_preflights ?? []).map((record) => [record?.runtime_ref, record]),
  );

  for (const task of controlPlaneSnapshot?.state?.managed_tasks ?? []) {
    const taskSpecRecord = taskSpecsByTaskId.get(task?.task_id);
    if (
      !taskSpecRecord
      || taskSpecRecord?.state !== 'valid'
      || taskSpecRecord?.snapshot?.schema_version !== TASK_SPEC_SCHEMA_VERSION
    ) {
      continue;
    }

    const runtimeRef = taskSpecRecord?.snapshot?.spec?.runtime_ref ?? null;
    if (!runtimeRef) continue;

    const runtimePreflightRecord = runtimePreflightsByRef.get(runtimeRef);
    if (!runtimePreflightRecord) {
      findings.push(createDoctorFinding({
        code: 'runtime_preflight_missing',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task is missing durable runtime preflight state.',
        details: [`runtime_ref: ${runtimeRef}`],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
      continue;
    }

    if (runtimePreflightRecord?.snapshot?.schema_version !== RUNTIME_PREFLIGHT_SCHEMA_VERSION) {
      findings.push(createDoctorFinding({
        code: 'runtime_preflight_mixed_version',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task has a mixed-version runtime preflight snapshot.',
        details: [
          `snapshot_schema_version: ${runtimePreflightRecord?.snapshot?.schema_version ?? 'missing'}`,
          `expected_schema_version: ${RUNTIME_PREFLIGHT_SCHEMA_VERSION}`,
        ],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
      continue;
    }

    if (runtimePreflightRecord.status === 'unsupported_provider') {
      findings.push(createDoctorFinding({
        code: 'runtime_preflight_unsupported_provider',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task runtime preflight resolved to an unsupported provider.',
        details: [`runtime_ref: ${runtimeRef}`],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
      continue;
    }

    if (runtimePreflightRecord.status === 'missing_dependency') {
      findings.push(createDoctorFinding({
        code: 'runtime_preflight_missing_dependency',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: task?.task_id ?? projectId,
        summary: 'Managed task runtime preflight is blocked by missing bootstrap requirements.',
        details: (runtimePreflightRecord?.snapshot?.checks ?? [])
          .filter((item) => item?.status === 'missing')
          .map((item) => item.requirement_id),
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    }
  }

  return findings;
}

function buildHandoffFindings({ controlPlaneSnapshot, projectId }) {
  if (!controlPlaneSnapshot?.bootstrapped) return [];

  const inspections = createHandoffProtocol({
    repository: {
      getSnapshot: () => controlPlaneSnapshot,
    },
  }).inspectAllHandoffs();

  const findings = [];
  for (const inspection of inspections) {
    if (inspection?.top_status === 'invalid') {
      findings.push(createDoctorFinding({
        code: 'handoff_state_invalid',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: inspection.task_id ?? projectId,
        summary: 'Managed task has invalid successor handoff state.',
        details: inspection.reason_codes ?? [],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    } else if (inspection?.top_status === 'ambiguous') {
      findings.push(createDoctorFinding({
        code: 'handoff_successor_ambiguous',
        severity: 'ambiguous',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: inspection.task_id ?? projectId,
        summary: 'Managed task has ambiguous successor selection.',
        details: inspection.reason_codes ?? [],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    } else if (inspection?.top_status === 'expired') {
      findings.push(createDoctorFinding({
        code: 'handoff_grant_expired',
        severity: 'blocker',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: inspection.task_id ?? projectId,
        summary: 'Managed task has expired handoff authority.',
        details: inspection.reason_codes ?? [],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    } else if (inspection?.top_status === 'accepted' || inspection?.top_status === 'pending_decision') {
      findings.push(createDoctorFinding({
        code: inspection.top_status === 'accepted' ? 'handoff_transfer_pending' : 'handoff_decision_pending',
        severity: 'warning',
        origin: 'doctor',
        source_area: 'control_plane',
        subject_type: 'task',
        subject_id: inspection.task_id ?? projectId,
        summary: inspection.top_status === 'accepted'
          ? 'Managed task is waiting for successor transfer completion.'
          : 'Managed task is waiting for an explicit handoff decision.',
        details: inspection.reason_codes ?? [],
        evidence_refs: [],
        suggestion_ids: ['human_review'],
      }));
    }
  }

  return findings;
}

function buildDoctorOnlyFindings({
  scope,
  reconciliationReport,
  localState,
  sourceHealth,
  projectId,
  controlPlaneSnapshot,
}) {
  const findings = [];

  if (sourceHealth.git === 'failed') {
    findings.push(createDoctorFinding({
      code: 'local_git_not_observable',
      severity: 'ambiguous',
      origin: 'doctor',
      source_area: 'git',
      subject_type: 'source',
      subject_id: projectId,
      summary: 'Local git state could not be observed reliably.',
      details: [localState?.git_error ?? 'Git probing failed.'],
      evidence_refs: [],
      suggestion_ids: ['git_branch_context'],
    }));
  }

  if (sourceHealth.worktree === 'failed') {
    findings.push(createDoctorFinding({
      code: 'worktree_not_observable',
      severity: 'ambiguous',
      origin: 'doctor',
      source_area: 'worktree',
      subject_type: 'worktree',
      subject_id: localState?.repo_root ?? projectId,
      summary: 'Worktree state could not be observed reliably.',
      details: ['Worktree status data is incomplete or unavailable.'],
      evidence_refs: [],
      suggestion_ids: ['git_status'],
    }));
  }

  if (localState?.worktree_dirty === true) {
    findings.push(createDoctorFinding({
      code: 'dirty_worktree',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'worktree',
      subject_type: 'worktree',
      subject_id: localState.repo_root,
      summary: 'Current worktree has local modifications.',
      details: ['Local dirty state may affect continuity diagnosis.'],
      evidence_refs: [],
      suggestion_ids: ['git_status'],
    }));
  }

  if (localState?.staged_changes === true) {
    findings.push(createDoctorFinding({
      code: 'staged_changes_present',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'worktree',
      subject_type: 'worktree',
      subject_id: localState.repo_root,
      summary: 'Staged changes are present in the current worktree.',
      details: ['Staged changes may change the local continuity context.'],
      evidence_refs: [],
      suggestion_ids: ['git_status'],
    }));
  }

  if (localState?.detached_head === true) {
    findings.push(createDoctorFinding({
      code: 'detached_head',
      severity: 'blocker',
      origin: 'doctor',
      source_area: 'git',
      subject_type: 'branch',
      subject_id: localState.head_sha,
      summary: 'Current repo is in detached HEAD state.',
      details: ['Detached HEAD prevents stable branch continuity handling.'],
      evidence_refs: [],
      suggestion_ids: ['git_branch_context'],
    }));
  }

  if (localState?.upstream_tracking === 'missing') {
    findings.push(createDoctorFinding({
      code: 'missing_upstream_tracking',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'git',
      subject_type: 'branch',
      subject_id: localState.current_branch,
      summary: 'Current branch has no upstream tracking branch.',
      details: ['Upstream tracking is missing for the current branch.'],
      evidence_refs: [],
      suggestion_ids: ['git_upstream'],
    }));
  }

  const expectedTarget = deriveExpectedTarget(scope, reconciliationReport);
  if (scope?.mode === 'project' && expectedTarget.targetCount === 0) {
    findings.push(createDoctorFinding({
      code: 'doctor_scope_empty',
      severity: 'info',
      origin: 'doctor',
      source_area: 'cross_source',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'Project diagnosis has no active AO-linked targets.',
      details: ['No active target was resolved from the reconciliation report.'],
      evidence_refs: [],
      suggestion_ids: [],
    }));
  }

  if (scope?.mode === 'project' && expectedTarget.targetCount > 1) {
    findings.push(createDoctorFinding({
      code: 'doctor_scope_multiple_targets',
      severity: 'info',
      origin: 'doctor',
      source_area: 'cross_source',
      subject_type: 'project',
      subject_id: projectId,
      summary: 'Project diagnosis has multiple active targets.',
      details: ['Branch-alignment findings are suppressed when more than one target is active.'],
      evidence_refs: [],
      suggestion_ids: [],
    }));
  }

  const shouldCheckBranchAlignment = scope?.mode === 'pr'
    || (scope?.mode === 'project' && expectedTarget.targetCount === 1);
  const branchMismatch = shouldCheckBranchAlignment
    && localState?.current_branch
    && expectedTarget.branchName
    && localState.current_branch !== expectedTarget.branchName;

  if (branchMismatch) {
    findings.push(createDoctorFinding({
      code: 'current_branch_mismatch',
      severity: 'ambiguous',
      origin: 'doctor',
      source_area: 'git',
      subject_type: 'branch',
      subject_id: localState.current_branch,
      summary: 'Current local branch does not match the expected diagnosis branch.',
      details: [`expected: ${expectedTarget.branchName}`, `current: ${localState.current_branch}`],
      evidence_refs: [],
      suggestion_ids: ['git_branch_context', 'reconcile_scope'],
    }));

    if (scope?.mode === 'pr') {
      findings.push(createDoctorFinding({
        code: 'pr_scope_not_linked_to_current_branch',
        severity: 'ambiguous',
        origin: 'doctor',
        source_area: 'cross_source',
        subject_type: 'pr',
        subject_id: scope.pr_number,
        summary: 'Explicit PR scope does not align with the current local branch.',
        details: [`expected: ${expectedTarget.branchName}`, `current: ${localState.current_branch}`],
        evidence_refs: [],
        suggestion_ids: ['git_branch_context', 'reconcile_scope'],
      }));
    }
  }

  if ((localState?.ao_artifact_paths ?? []).length > 0) {
    findings.push(createDoctorFinding({
      code: 'ao_artifact_leftovers',
      severity: 'info',
      origin: 'doctor',
      source_area: 'artifacts',
      subject_type: 'artifact',
      subject_id: projectId,
      summary: 'AO artifact leftovers are present in the local repo.',
      details: localState.ao_artifact_paths,
      evidence_refs: [],
      suggestion_ids: ['ao_artifact_review'],
    }));

    if (branchMismatch) {
      findings.push(createDoctorFinding({
        code: 'ao_artifact_scope_conflict',
        severity: 'warning',
        origin: 'doctor',
        source_area: 'artifacts',
        subject_type: 'artifact',
        subject_id: projectId,
        summary: 'AO artifact leftovers appear inconsistent with the current diagnosis scope.',
        details: localState.ao_artifact_paths,
        evidence_refs: [],
        suggestion_ids: ['ao_artifact_review', 'human_review'],
      }));
    }
  }

  return [
    ...findings,
    ...buildTaskSpecFindings({
      controlPlaneSnapshot,
      projectId,
    }),
    ...buildRuntimePreflightFindings({
      controlPlaneSnapshot,
      projectId,
    }),
    ...buildHandoffFindings({
      controlPlaneSnapshot,
      projectId,
    }),
  ];
}

function buildSuggestions(findings, scope, options = {}) {
  const suggestionTemplates = buildSuggestionTemplates(scope, options);
  const ids = [...new Set(findings.flatMap((finding) => finding.suggestion_ids ?? []))];

  return ids
    .map((id) => {
      const template = suggestionTemplates[id];
      if (!template) return null;
      return createDoctorSuggestion({
        id,
        ...template,
      });
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.action_class !== right.action_class) {
        return left.action_class.localeCompare(right.action_class);
      }
      return left.id.localeCompare(right.id);
    });
}

function deriveTopStatus(sourceHealth, findings) {
  if (Object.values(sourceHealth).some((value) => value === 'failed')) return 'source_failure';
  if (findings.some((finding) => finding.severity === 'blocker')) return 'blocked';
  if (findings.some((finding) => finding.severity === 'ambiguous')) return 'ambiguous';
  if (findings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'healthy';
}

export function buildDoctorReport({
  scope,
  reconciliationReport,
  localState,
  controlPlaneSnapshot = null,
  runtimeStore = null,
} = {}) {
  const projectId = scope?.project_id ?? reconciliationReport?.project_id ?? 'unknown-project';
  const sourceHealth = deriveSourceHealth(reconciliationReport, localState);
  const reconciliationFindings = preserveReconciliationFindings(reconciliationReport);
  const doctorFindings = buildDoctorOnlyFindings({
    scope,
    reconciliationReport,
    localState,
    sourceHealth,
    projectId,
    controlPlaneSnapshot,
  });
  const findings = [...reconciliationFindings, ...doctorFindings];
  const suggestions = buildSuggestions(findings, scope, { runtimeStore });

  return {
    schema_version: DOCTOR_SCHEMA_VERSION,
    report_format: DOCTOR_REPORT_FORMAT,
    engine_version: 'phase2-doctor',
    observed_at: reconciliationReport?.observed_at ?? new Date().toISOString(),
    project_id: projectId,
    scope,
    top_status: deriveTopStatus(sourceHealth, findings),
    source_health: sourceHealth,
    reconciliation_summary: {
      top_status: reconciliationReport?.top_status ?? null,
      automation_disposition: reconciliationReport?.automation_disposition ?? null,
      selected_pr_numbers: reconciliationReport?.scope?.selected_pr_numbers ?? [],
      finding_codes: (reconciliationReport?.findings ?? []).map((finding) => finding.code),
    },
    local_state: localState,
    findings,
    suggestions,
  };
}
