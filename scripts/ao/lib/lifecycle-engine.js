import {
  LIFECYCLE_REPORT_FORMAT,
  LIFECYCLE_SCHEMA_VERSION,
  createLifecycleAction,
  createLifecycleFinding,
} from './lifecycle-contracts.js';
import {
  collectGateBlockerCodes,
  createGateSnapshot,
  getGate,
} from './gate-model.js';
import {
  LEGACY_RELEASE_DISPOSITIONS,
  RELEASE_JUDGMENT_KIND,
  createReleaseReadyDecision,
  createReleaseVocabularyDeprecationFinding,
} from './release-judgment.js';

export const RELEASE_READY_ACTIONS = Object.freeze({
  RELEASE_READY: RELEASE_JUDGMENT_KIND,
  NOTIFY_HUMAN: LEGACY_RELEASE_DISPOSITIONS.NOTIFY_HUMAN_READY,
  AUTO_MERGE: LEGACY_RELEASE_DISPOSITIONS.AUTO_MERGE_READY_PR,
});
export const DEFAULT_RELEASE_READY_ACTION = RELEASE_READY_ACTIONS.RELEASE_READY;

export function normalizeReleaseReadyAction(value = DEFAULT_RELEASE_READY_ACTION) {
  const normalized = String(value ?? DEFAULT_RELEASE_READY_ACTION).trim();
  if (!Object.values(RELEASE_READY_ACTIONS).includes(normalized)) {
    throw new Error(`Unsupported release-ready action: ${value}`);
  }
  return normalized;
}

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

function uniqueStrings(values) {
  return [...new Set((values ?? [])
    .filter((value) => value != null)
    .map((value) => String(value))
    .filter((value) => value !== ''))];
}

function sameReleaseDecision(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function normalizeLifecycleReleaseDecision(releaseDecision) {
  return releaseDecision == null
    ? {
        disposition: 'no_release_action',
        basis: [],
        authoritative: false,
      }
    : {
        ...releaseDecision,
        basis: uniqueStrings(releaseDecision.basis ?? []),
      };
}

function resolveReviewGateReleaseDecision({
  releaseDecision,
  reviewRequired = false,
  reviewInspection = null,
  currentHeadSha = null,
} = {}) {
  const originalReleaseDecision = releaseDecision ?? {
    disposition: 'no_release_action',
    basis: [],
    authoritative: false,
  };
  const normalizedReleaseDecision = normalizeLifecycleReleaseDecision(releaseDecision);
  if (!reviewRequired && reviewInspection == null) {
    return originalReleaseDecision;
  }

  const reviewPosture = reviewInspection?.posture ?? 'idle';
  const reviewTargetSha = reviewInspection?.target_head_sha ?? null;
  const targetMismatch = (
    currentHeadSha != null
      && reviewTargetSha != null
      && reviewTargetSha !== currentHeadSha
  );

  if (reviewPosture === 'review_escalated') {
    return {
      disposition: 'human_gate',
      basis: ['review_escalated'],
      authoritative: false,
    };
  }

  if (reviewPosture === 'review_changes_required') {
    return {
      disposition: 'no_release_action',
      basis: ['review_changes_required'],
      authoritative: true,
    };
  }

  if (reviewPosture === 'review_pending') {
    return {
      disposition: 'await_review',
      basis: [targetMismatch ? 'review_target_mismatch' : 'review_pending'],
      authoritative: true,
    };
  }

  if (reviewPosture === 'review_passed') {
    if (targetMismatch) {
      return {
        disposition: 'await_review',
        basis: ['review_target_mismatch'],
        authoritative: true,
      };
    }

    return originalReleaseDecision;
  }

  if (
    reviewRequired
    && Object.values(RELEASE_READY_ACTIONS).includes(normalizedReleaseDecision.disposition)
  ) {
    return {
      disposition: 'await_review',
      basis: ['review_missing'],
      authoritative: true,
    };
  }

  return originalReleaseDecision;
}

function deriveDoctorControlStatus(doctorReport) {
  const doctorFindings = (doctorReport?.findings ?? []).filter((finding) => finding.origin === 'doctor');

  if (doctorFindings.some((finding) => finding.severity === 'blocker')) return 'blocked';
  if (doctorFindings.some((finding) => finding.severity === 'ambiguous')) return 'ambiguous';
  if (doctorFindings.some((finding) => finding.severity === 'warning')) return 'warning';
  return 'healthy';
}

function deriveInputHealth(sourceHealth) {
  if (!sourceHealth) return 'failed';

  const states = Object.values(sourceHealth);
  if (!states.length) return 'failed';
  if (states.some((state) => state === 'failed')) return 'failed';
  if (states.some((state) => state === 'degraded')) return 'degraded';
  return 'ok';
}

function deriveLifecycleSourceHealth(reconciliationReport, doctorReport) {
  return {
    reconciliation: deriveInputHealth(reconciliationReport?.source_health),
    doctor: deriveInputHealth(doctorReport?.source_health),
  };
}

function selectSingleAssessment(scope, reconciliationReport) {
  const assessments = reconciliationReport?.pr_assessments ?? [];
  if (scope?.mode === 'pr') return assessments[0] ?? null;
  if (assessments.length === 1) return assessments[0];
  return null;
}

function extractTypedReleaseData(assessment) {
  const releaseReadiness = assessment?.release_readiness ?? {};
  const gates = createGateSnapshot(releaseReadiness.gates ?? {});
  const blockerCodes = uniqueStrings([
    ...(releaseReadiness.blocker_codes ?? []),
    ...(releaseReadiness.blockers ?? []),
    ...collectGateBlockerCodes(gates),
  ]);
  const reasonCodes = uniqueStrings(Object.values(gates).flatMap((gate) => gate.reason_codes ?? []));

  return {
    gates,
    blockerCodes,
    reasonCodes,
    hasTypedGates: Object.keys(gates).length > 0,
  };
}

function resolveTypedReleaseDisposition(assessment) {
  const { gates, blockerCodes, reasonCodes, hasTypedGates } = extractTypedReleaseData(assessment);
  if (!hasTypedGates) return null;

  const releaseGate = getGate(gates, 'release');
  if (releaseGate?.state === 'blocked' || blockerCodes.length) {
    if (blockerCodes.includes('ci_blocked')) {
      return {
        disposition: 'await_ci',
        basis: blockerCodes,
        authoritative: true,
      };
    }

    if (blockerCodes.includes('review_blocked')) {
      return {
        disposition: 'await_review',
        basis: blockerCodes,
        authoritative: true,
      };
    }

    if (blockerCodes.includes('merge_conflict_blocked')) {
      return {
        disposition: 'await_mergeability',
        basis: blockerCodes,
        authoritative: true,
      };
    }

    return {
      disposition: 'no_release_action',
      basis: blockerCodes.length ? blockerCodes : (releaseGate?.reason_codes ?? reasonCodes),
      authoritative: false,
    };
  }

  const ciGate = getGate(gates, 'ci');
  if (ciGate?.state === 'blocked' || ciGate?.state === 'pending' || blockerCodes.includes('ci_blocked')) {
    return {
      disposition: 'await_ci',
      basis: blockerCodes.includes('ci_blocked') ? blockerCodes : reasonCodes,
      authoritative: true,
    };
  }

  const reviewGate = getGate(gates, 'review');
  if (reviewGate?.state === 'blocked' || reviewGate?.state === 'pending' || blockerCodes.includes('review_blocked')) {
    return {
      disposition: 'await_review',
      basis: blockerCodes.includes('review_blocked') ? blockerCodes : reasonCodes,
      authoritative: true,
    };
  }

  const mergeabilityGate = getGate(gates, 'mergeability');
  if (mergeabilityGate?.state === 'blocked' || mergeabilityGate?.state === 'ambiguous' || blockerCodes.includes('merge_conflict_blocked')) {
    return {
      disposition: 'await_mergeability',
      basis: blockerCodes.includes('merge_conflict_blocked') ? blockerCodes : reasonCodes,
      authoritative: true,
    };
  }

  return null;
}

function preserveReconciliationFindings(reconciliationReport) {
  return (reconciliationReport?.findings ?? []).map((finding) => createLifecycleFinding({
    code: finding.code,
    severity: finding.severity,
    origin: 'reconciliation',
    source_area: RECONCILIATION_FINDING_SOURCE_AREAS[finding.code] ?? 'cross_source',
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    summary: finding.summary,
    details: finding.details ?? [],
    evidence_refs: finding.evidence_refs ?? [],
    action_ids: [],
  }));
}

function preserveDoctorFindings(doctorReport) {
  return (doctorReport?.findings ?? [])
    .filter((finding) => finding.origin === 'doctor')
    .map((finding) => createLifecycleFinding({
      code: finding.code,
      severity: finding.severity,
      origin: 'doctor',
      source_area: finding.source_area,
      subject_type: finding.subject_type,
      subject_id: finding.subject_id,
      summary: finding.summary,
      details: finding.details ?? [],
      evidence_refs: finding.evidence_refs ?? [],
      action_ids: [],
    }));
}

function buildRoutingDecision({
  scope,
  assessment,
  doctorControlStatus,
  sourceHealth,
}) {
  if (Object.values(sourceHealth).some((state) => state === 'failed')) {
    return {
      action: 'hold_for_human',
      owner_session: null,
      target_pr_number: scope?.pr_number ?? null,
      reason_codes: ['source_failure'],
      authoritative: false,
    };
  }

  if (scope?.mode === 'project') {
    if (scope.trigger === 'manual') {
      return {
        action: 'no_action',
        owner_session: null,
        target_pr_number: null,
        reason_codes: ['project_scope_advisory_only'],
        authoritative: false,
      };
    }

    return {
      action: 'hold_for_human',
      owner_session: null,
      target_pr_number: null,
      reason_codes: ['trigger_requires_pr_scope'],
      authoritative: false,
    };
  }

  if (!assessment) {
    return {
      action: 'hold_for_human',
      owner_session: null,
      target_pr_number: scope?.pr_number ?? null,
      reason_codes: ['missing_pr_assessment'],
      authoritative: false,
    };
  }

  if (doctorControlStatus === 'blocked') {
    return {
      action: 'hold_for_human',
      owner_session: assessment.ownership?.owner_session ?? null,
      target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
      reason_codes: ['doctor_blocks_control'],
      authoritative: false,
    };
  }

  if (doctorControlStatus === 'ambiguous') {
    return {
      action: 'hold_for_human',
      owner_session: assessment.ownership?.owner_session ?? null,
      target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
      reason_codes: ['doctor_ambiguous'],
      authoritative: false,
    };
  }

  switch (assessment.ownership?.status) {
    case 'clear':
      return {
        action: 'continue_current_worker',
        owner_session: assessment.ownership?.owner_session ?? null,
        target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
        reason_codes: ['ownership_clear'],
        authoritative: true,
      };
    case 'stale':
      return {
        action: 'restore_existing_worker',
        owner_session: assessment.ownership?.owner_session ?? null,
        target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
        reason_codes: ['ownership_stale'],
        authoritative: true,
      };
    case 'orphaned':
      return {
        action: 'handoff_to_successor',
        owner_session: null,
        target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
        reason_codes: ['ownership_orphaned'],
        authoritative: true,
      };
    case 'ambiguous':
    case 'unknown':
    default:
      return {
        action: 'hold_for_human',
        owner_session: assessment.ownership?.owner_session ?? null,
        target_pr_number: assessment.pr_number ?? scope?.pr_number ?? null,
        reason_codes: ['ownership_ambiguous'],
        authoritative: false,
      };
  }
}

function buildReleaseDecision({
  scope,
  assessment,
  reconciliationReport,
  doctorControlStatus,
  sourceHealth,
  currentHeadSha = null,
  releaseReadyAction = DEFAULT_RELEASE_READY_ACTION,
}) {
  if (scope?.mode === 'project') {
    return {
      disposition: 'not_applicable',
      basis: ['project_scope_advisory_only'],
      authoritative: false,
    };
  }

  if (Object.values(sourceHealth).some((state) => state === 'failed')) {
    return {
      disposition: 'human_gate',
      basis: ['source_failure'],
      authoritative: false,
    };
  }

  if (!assessment) {
    return {
      disposition: 'human_gate',
      basis: ['missing_pr_assessment'],
      authoritative: false,
    };
  }

  if (doctorControlStatus === 'blocked') {
    return {
      disposition: 'no_release_action',
      basis: ['doctor_blocks_control'],
      authoritative: false,
    };
  }

  if (doctorControlStatus === 'ambiguous') {
    return {
      disposition: 'human_gate',
      basis: ['doctor_ambiguous'],
      authoritative: false,
    };
  }

  const releaseStatus = assessment.release_readiness?.status ?? 'unknown';
  const basis = assessment.release_readiness?.basis ?? [];
  const typedReleaseDecision = resolveTypedReleaseDisposition(assessment);

  if (scope?.trigger === 'bugbot_comments') {
    return {
      disposition: 'await_review',
      basis: ['bugbot_comments'],
      authoritative: true,
    };
  }

  if (
    releaseStatus === 'ready'
    && reconciliationReport?.top_status === 'healthy'
    && ['approved_and_green', 'manual'].includes(scope?.trigger)
  ) {
    if (releaseReadyAction === RELEASE_READY_ACTIONS.RELEASE_READY) {
      return createReleaseReadyDecision();
    }
    if (releaseReadyAction === RELEASE_READY_ACTIONS.AUTO_MERGE) {
      return {
        disposition: RELEASE_READY_ACTIONS.AUTO_MERGE,
        basis: ['ready_for_auto_merge'],
        expected_head_sha: currentHeadSha,
        authoritative: true,
      };
    }
    return {
      disposition: RELEASE_READY_ACTIONS.NOTIFY_HUMAN,
      basis: ['ready_for_human_notification'],
      authoritative: true,
    };
  }

  if (typedReleaseDecision) {
    return typedReleaseDecision;
  }

  if (releaseStatus === 'blocked') {
    if (basis.includes('ci_blocked')) {
      return {
        disposition: 'await_ci',
        basis,
        authoritative: true,
      };
    }
    if (basis.includes('review_blocked')) {
      return {
        disposition: 'await_review',
        basis,
        authoritative: true,
      };
    }
    if (basis.includes('merge_conflict_blocked') || basis.includes('mergeability_unknown')) {
      return {
        disposition: 'await_mergeability',
        basis,
        authoritative: true,
      };
    }
    return {
      disposition: 'no_release_action',
      basis,
      authoritative: false,
    };
  }

  if (releaseStatus === 'ambiguous') {
    return {
      disposition: 'human_gate',
      basis,
      authoritative: false,
    };
  }

  if (releaseStatus === 'not_applicable') {
    return {
      disposition: 'not_applicable',
      basis,
      authoritative: true,
    };
  }

  return {
    disposition: 'no_release_action',
    basis,
    authoritative: false,
  };
}

function buildLifecycleFindings({
  scope,
  routingDecision,
  releaseDecision,
}) {
  const findings = [];

  if (scope?.mode === 'project') {
    findings.push(createLifecycleFinding({
      code: 'project_scope_advisory_only',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'project',
      subject_id: scope.project_id,
      summary: 'Project mode lifecycle output is advisory only.',
      details: ['Project mode does not produce authoritative worker or release decisions.'],
      evidence_refs: [],
      action_ids: [],
    }));
  }

  if (routingDecision.reason_codes.includes('trigger_requires_pr_scope')) {
    findings.push(createLifecycleFinding({
      code: 'trigger_requires_pr_scope',
      severity: 'ambiguous',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'trigger',
      subject_id: scope.trigger,
      summary: 'This trigger requires explicit PR scope for authoritative control decisions.',
      details: ['Project mode cannot resolve this trigger authoritatively.'],
      evidence_refs: [],
      action_ids: ['human_gate'],
    }));
  }

  if (routingDecision.reason_codes.includes('ownership_clear')) {
    findings.push(createLifecycleFinding({
      code: 'worker_continuation_clear',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'session',
      subject_id: routingDecision.owner_session,
      summary: 'Current worker ownership continuity is clear.',
      details: [routingDecision.owner_session ?? 'unknown-session'],
      evidence_refs: [],
      action_ids: ['continue_worker'],
    }));
  }

  if (routingDecision.reason_codes.includes('ownership_stale')) {
    findings.push(createLifecycleFinding({
      code: 'worker_restore_recommended',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'session',
      subject_id: routingDecision.owner_session,
      summary: 'Prior worker restoration is recommended.',
      details: [routingDecision.owner_session ?? 'unknown-session'],
      evidence_refs: [],
      action_ids: ['restore_worker'],
    }));
  }

  if (routingDecision.reason_codes.includes('ownership_orphaned')) {
    findings.push(createLifecycleFinding({
      code: 'successor_handoff_recommended',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'pr',
      subject_id: routingDecision.target_pr_number,
      summary: 'A successor worker handoff is recommended.',
      details: ['Ownership continuity is no longer present for this PR.'],
      evidence_refs: [],
      action_ids: ['handoff_worker'],
    }));
  }

  if (routingDecision.reason_codes.includes('ownership_ambiguous')) {
    findings.push(createLifecycleFinding({
      code: 'ownership_control_ambiguous',
      severity: 'ambiguous',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'ownership',
      subject_id: routingDecision.target_pr_number,
      summary: 'Lifecycle control cannot determine a safe owner.',
      details: ['Ownership continuity remains ambiguous.'],
      evidence_refs: [],
      action_ids: ['human_gate'],
    }));
  }

  if (routingDecision.reason_codes.includes('doctor_blocks_control')) {
    findings.push(createLifecycleFinding({
      code: 'doctor_blocks_control',
      severity: 'blocker',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'source',
      subject_id: routingDecision.target_pr_number,
      summary: 'Doctor diagnosis blocks lifecycle control from continuing.',
      details: ['Local continuity diagnosis must be resolved before control can proceed.'],
      evidence_refs: [],
      action_ids: ['hold_local_control', 'notify_human_blocked'],
    }));
  }

  if (releaseDecision.disposition === 'await_ci') {
    findings.push(createLifecycleFinding({
      code: 'release_waiting_on_ci',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'Release-facing progress is waiting on CI.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['hold_ci'],
    }));
  }

  if (releaseDecision.disposition === 'await_review') {
    findings.push(createLifecycleFinding({
      code: 'release_waiting_on_review',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'Release-facing progress is waiting on review resolution.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['hold_review'],
    }));
  }

  if (releaseDecision.basis?.includes('review_changes_required')) {
    findings.push(createLifecycleFinding({
      code: 'review_changes_required',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'Independent review returned this task to implementation.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['continue_worker'],
    }));
  }

  if (releaseDecision.disposition === 'await_mergeability') {
    findings.push(createLifecycleFinding({
      code: 'release_waiting_on_mergeability',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'Release-facing progress is waiting on mergeability.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['hold_mergeability'],
    }));
  }

  if (releaseDecision.disposition === RELEASE_JUDGMENT_KIND) {
    findings.push(createLifecycleFinding({
      code: 'release_ready_or_preflight_authorized',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'release_judgment',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'AO authorizes OR to begin a fresh release preflight.',
      details: ['This judgment claims no merge, external effect, or human approval.'],
      evidence_refs: [],
      action_ids: [RELEASE_JUDGMENT_KIND],
    }));
  }

  if (releaseDecision.disposition === LEGACY_RELEASE_DISPOSITIONS.NOTIFY_HUMAN_READY) {
    findings.push(createLifecycleFinding({
      code: 'release_ready_human_notification',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'PR appears ready for explicit human notification.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['notify_human_ready'],
    }));
  }

  if (releaseDecision.disposition === 'auto_merge_ready_pr') {
    findings.push(createLifecycleFinding({
      code: 'release_ready_auto_merge',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'PR appears ready for policy-selected automatic merge.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['auto_merge_ready_pr'],
    }));
  }

  if (releaseDecision.disposition === 'human_gate') {
    findings.push(createLifecycleFinding({
      code: 'release_control_human_gate',
      severity: 'ambiguous',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'release_control',
      subject_id: scope?.pr_number ?? null,
      summary: 'Release-facing judgment still requires a human.',
      details: releaseDecision.basis,
      evidence_refs: [],
      action_ids: ['human_gate', 'notify_human_blocked'],
    }));
  }

  const deprecationFinding = createReleaseVocabularyDeprecationFinding(
    releaseDecision.disposition,
    { subjectId: scope?.pr_number ?? null },
  );
  if (deprecationFinding) {
    findings.push(createLifecycleFinding(deprecationFinding));
  }

  return findings;
}

function buildActionTemplates(scope) {
  const projectId = scope?.project_id ?? 'my-project';
  const prNumber = scope?.pr_number;
  const reconcileCommand = Number.isInteger(prNumber)
    ? `node scripts/ao-reconcile.js --pr ${prNumber} --json --strict`
    : `node scripts/ao-reconcile.js --project ${projectId} --json`;
  const doctorCommand = Number.isInteger(prNumber)
    ? `node scripts/ao-doctor.js --pr ${prNumber}`
    : `node scripts/ao-doctor.js --project ${projectId}`;

  return {
    continue_worker: {
      action_class: 'continue_worker',
      summary: 'Continue the current worker owner.',
      commands: [`ao-pilot status --project ${projectId} --json`],
      rationale: 'Ownership continuity is clear enough to continue the current worker.',
    },
    restore_worker: {
      action_class: 'restore_worker',
      summary: 'Restore the previously identified worker.',
      commands: [`ao-pilot status --project ${projectId} --json`, reconcileCommand],
      rationale: 'The prior owner is still identifiable, but continuity is stale.',
    },
    handoff_worker: {
      action_class: 'handoff_worker',
      summary: 'Continue through a successor worker.',
      commands: [reconcileCommand, doctorCommand],
      rationale: 'Ownership continuity no longer points to a live specific owner.',
    },
    release_ready: {
      action_class: 'release_judgment',
      summary: 'Authorize OR to begin release preflight.',
      commands: [],
      rationale: 'AO judged the evidence ready for a fresh OR preflight; no merge, external effect, or human approval is claimed.',
    },
    notify_human_ready: {
      action_class: 'notify_human',
      summary: 'Notify the human that the PR appears ready.',
      commands: [
        `gh pr view ${prNumber} --json mergeable,reviewDecision,isDraft,url`,
        `ao-pilot status --project ${projectId} --json`,
      ],
      rationale: 'Human approval remains required even when the PR appears ready.',
    },
    notify_human_blocked: {
      action_class: 'notify_human',
      summary: 'Record a generic notification intent because AO is blocked.',
      commands: [],
      rationale: 'AO cannot safely continue without explicit human input; delivery is delegated to an injected transport.',
    },
    auto_merge_ready_pr: {
      action_class: 'merge_pr',
      summary: 'Merge the release-ready AO-managed PR.',
      commands: [
        `gh pr view ${prNumber} --json number,state,headRefOid,reviewDecision,mergeStateStatus,isDraft,statusCheckRollup,url`,
        `gh pr merge ${prNumber} --squash --delete-branch`,
      ],
      rationale: 'The configured release-ready policy selected guarded automatic merge.',
    },
    hold_ci: {
      action_class: 'hold',
      summary: 'Hold until CI is green.',
      commands: [`gh pr checks ${prNumber}`],
      rationale: 'Required CI state is not yet ready.',
    },
    hold_review: {
      action_class: 'hold',
      summary: 'Hold until review is resolved.',
      commands: [`gh pr view ${prNumber} --json reviewDecision,url`],
      rationale: 'Review state remains unresolved.',
    },
    hold_mergeability: {
      action_class: 'hold',
      summary: 'Hold until mergeability is resolved.',
      commands: [`gh pr view ${prNumber} --json mergeable,isDraft,url`],
      rationale: 'Mergeability is still blocking release-facing progress.',
    },
    hold_local_control: {
      action_class: 'hold',
      summary: 'Hold until local continuity diagnosis is resolved.',
      commands: [doctorCommand],
      rationale: 'Doctor reported a blocking local control condition.',
    },
    human_gate: {
      action_class: 'human_gate',
      summary: 'Escalate to explicit human judgment.',
      commands: [reconcileCommand, doctorCommand],
      rationale: 'Automation cannot safely resolve the current ambiguity.',
    },
  };
}

function buildActions(findings, scope) {
  const actionTemplates = buildActionTemplates(scope);
  const actionIds = [...new Set(findings.flatMap((finding) => finding.action_ids ?? []))];

  return actionIds
    .map((id) => {
      const template = actionTemplates[id];
      if (!template) return null;
      return createLifecycleAction({
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

function deriveTopStatus({
  scope,
  sourceHealth,
  routingDecision,
  releaseDecision,
}) {
  if (Object.values(sourceHealth).some((state) => state === 'failed')) return 'source_failure';
  if (
    routingDecision.reason_codes.includes('trigger_requires_pr_scope')
    || routingDecision.reason_codes.includes('ownership_ambiguous')
    || routingDecision.reason_codes.includes('doctor_ambiguous')
    || releaseDecision.disposition === 'human_gate'
  ) {
    return 'human_gate';
  }
  if (routingDecision.action === 'handoff_to_successor') return 'handoff';
  if (
    routingDecision.reason_codes.includes('doctor_blocks_control')
    || ['await_ci', 'await_review', 'await_mergeability'].includes(releaseDecision.disposition)
  ) {
    return 'hold';
  }
  if (scope?.mode === 'project') return 'observe';
  return 'continue';
}

export function applyReviewGateToLifecycleReport({
  lifecycleReport,
  reviewRequired = false,
  reviewInspection = null,
  currentHeadSha = null,
} = {}) {
  if (!lifecycleReport) return lifecycleReport;

  const nextReleaseDecision = resolveReviewGateReleaseDecision({
    releaseDecision: lifecycleReport.release_decision,
    reviewRequired,
    reviewInspection,
    currentHeadSha,
  });
  if (sameReleaseDecision(lifecycleReport.release_decision, nextReleaseDecision)) {
    return lifecycleReport;
  }

  const normalizedRoutingDecision = {
    action: lifecycleReport?.routing_decision?.action ?? 'no_action',
    owner_session: lifecycleReport?.routing_decision?.owner_session ?? null,
    target_pr_number: lifecycleReport?.routing_decision?.target_pr_number ?? lifecycleReport?.scope?.pr_number ?? null,
    reason_codes: lifecycleReport?.routing_decision?.reason_codes ?? [],
    authoritative: lifecycleReport?.routing_decision?.authoritative ?? false,
  };
  const nextFindings = [
    ...(lifecycleReport.findings ?? []).filter((finding) => finding?.origin !== 'lifecycle'),
    ...buildLifecycleFindings({
      scope: lifecycleReport.scope,
      routingDecision: normalizedRoutingDecision,
      releaseDecision: nextReleaseDecision,
    }),
  ];
  const nextActions = buildActions(nextFindings, lifecycleReport.scope);

  return {
    ...lifecycleReport,
    top_status: deriveTopStatus({
      scope: lifecycleReport.scope,
      sourceHealth: lifecycleReport.source_health ?? {},
      routingDecision: normalizedRoutingDecision,
      releaseDecision: nextReleaseDecision,
    }),
    release_decision: nextReleaseDecision,
    findings: nextFindings,
    actions: nextActions,
  };
}

export function buildLifecycleReport({
  scope,
  reconciliationReport,
  doctorReport,
  reviewRequired = false,
  reviewInspection = null,
  currentHeadSha = null,
  releaseReadyAction = DEFAULT_RELEASE_READY_ACTION,
} = {}) {
  const normalizedReleaseReadyAction = normalizeReleaseReadyAction(releaseReadyAction);
  const sourceHealth = deriveLifecycleSourceHealth(reconciliationReport, doctorReport);
  const doctorControlStatus = deriveDoctorControlStatus(doctorReport);
  const assessment = selectSingleAssessment(scope, reconciliationReport);
  const routingDecision = buildRoutingDecision({
    scope,
    assessment,
    doctorControlStatus,
    sourceHealth,
  });
  const releaseDecision = buildReleaseDecision({
    scope,
    assessment,
    reconciliationReport,
    doctorControlStatus,
    sourceHealth,
    currentHeadSha,
    releaseReadyAction: normalizedReleaseReadyAction,
  });
  const findings = [
    ...preserveReconciliationFindings(reconciliationReport),
    ...preserveDoctorFindings(doctorReport),
    ...buildLifecycleFindings({
      scope,
      routingDecision,
      releaseDecision,
    }),
  ];
  const actions = buildActions(findings, scope);

  const lifecycleReport = {
    schema_version: LIFECYCLE_SCHEMA_VERSION,
    report_format: LIFECYCLE_REPORT_FORMAT,
    engine_version: 'phase3-lifecycle',
    observed_at: doctorReport?.observed_at ?? reconciliationReport?.observed_at ?? new Date().toISOString(),
    project_id: scope?.project_id ?? reconciliationReport?.project_id ?? doctorReport?.project_id ?? 'unknown-project',
    scope,
    top_status: deriveTopStatus({
      scope,
      sourceHealth,
      routingDecision,
      releaseDecision,
    }),
    source_health: sourceHealth,
    reconciliation_summary: {
      top_status: reconciliationReport?.top_status ?? null,
      selected_pr_numbers: reconciliationReport?.scope?.selected_pr_numbers ?? [],
      ownership_status: assessment?.ownership?.status ?? null,
      release_status: assessment?.release_readiness?.status ?? null,
    },
    doctor_summary: {
      top_status: doctorReport?.top_status ?? null,
      finding_codes: (doctorReport?.findings ?? []).map((finding) => finding.code),
    },
    routing_decision: routingDecision,
    release_decision: releaseDecision,
    release_vocabulary: {
      schema_version: 'ao.release-vocabulary.v1',
      configured_action: normalizedReleaseReadyAction,
      current_judgment: RELEASE_JUDGMENT_KIND,
    },
    findings,
    actions,
  };

  return applyReviewGateToLifecycleReport({
    lifecycleReport,
    reviewRequired,
    reviewInspection,
    currentHeadSha,
  });
}
