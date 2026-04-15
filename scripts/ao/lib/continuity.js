import {
  CONTINUITY_POSTURES,
  CONTINUITY_RECOMMENDED_ACTIONS,
  createContinuityInspection,
} from './continuity-contracts.js';

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function uniqueStrings(values = []) {
  return [...new Set((values ?? [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function activeLeaseForTask(ownershipLeases = []) {
  return (ownershipLeases ?? [])
    .filter((lease) => lease?.status === 'active')
    .sort((left, right) => compareIsoDescending(left?.acquired_at, right?.acquired_at))[0] ?? null;
}

function latestLeaseForTask(ownershipLeases = []) {
  return [...(ownershipLeases ?? [])]
    .sort((left, right) => compareIsoDescending(left?.acquired_at, right?.acquired_at))[0] ?? null;
}

function activeLeaseCount(ownershipLeases = []) {
  return (ownershipLeases ?? []).filter((lease) => lease?.status === 'active').length;
}

function selectPrBinding(snapshot, taskId) {
  return (snapshot?.state?.pr_bindings ?? [])
    .filter((binding) => binding?.task_id === taskId && binding?.status === 'bound')
    .sort((left, right) => compareIsoDescending(left?.updated_at, right?.updated_at))[0] ?? null;
}

function selectAssessment(reconciliationReport, prNumber = null) {
  const assessments = reconciliationReport?.pr_assessments ?? [];
  if (!assessments.length) return null;
  if (prNumber != null) {
    return assessments.find((assessment) => assessment?.pr_number === prNumber) ?? null;
  }
  return assessments[0] ?? null;
}

function selectSelectedClaim(handoffInspection) {
  const selectedClaimId = handoffInspection?.request?.selected_claim_id ?? null;
  const claims = handoffInspection?.claims ?? [];
  if (selectedClaimId) {
    return claims.find((claim) => claim?.claim_id === selectedClaimId) ?? null;
  }
  if (claims.length === 1) {
    return claims[0] ?? null;
  }
  return null;
}

function reasonCodesForCheckpoint(checkpointInspection) {
  if (!checkpointInspection) return ['checkpoint_missing'];
  if (checkpointInspection.state === 'valid') return ['valid_resume_checkpoint'];
  return checkpointInspection.state === 'stale'
    ? ['checkpoint_stale']
    : ['checkpoint_invalid'];
}

function buildBaseMetadata({
  task,
  prBinding,
  reconciliationReport,
  lifecycleReport,
  ownershipLeases,
  handoffInspection,
  checkpointInspection,
} = {}) {
  const activeLease = activeLeaseForTask(ownershipLeases);
  const latestLease = latestLeaseForTask(ownershipLeases);
  const assessment = selectAssessment(reconciliationReport, prBinding?.pr_number ?? null);
  const routingDecision = lifecycleReport?.routing_decision ?? null;
  const selectedClaim = selectSelectedClaim(handoffInspection);

  return {
    activeLease,
    latestLease,
    activeLeaseCount: activeLeaseCount(ownershipLeases),
    assessment,
    ownershipStatus: assessment?.ownership?.status ?? null,
    routingAction: routingDecision?.action ?? null,
    routingReasonCodes: routingDecision?.reason_codes ?? [],
    ownerSessionName: activeLease?.owner_session_name
      ?? assessment?.ownership?.owner_session
      ?? routingDecision?.owner_session
      ?? latestLease?.owner_session_name
      ?? null,
    successorSessionName: selectedClaim?.successor_session_name
      ?? handoffInspection?.request?.successor_session_name
      ?? null,
    checkpointState: checkpointInspection?.state ?? handoffInspection?.checkpoint?.state ?? null,
    checkpointId: checkpointInspection?.checkpoint_id ?? handoffInspection?.checkpoint?.checkpoint_id ?? null,
    handoffRequestId: handoffInspection?.request_id ?? null,
    prNumber: prBinding?.pr_number
      ?? assessment?.pr_number
      ?? lifecycleReport?.scope?.pr_number
      ?? null,
    task,
  };
}

function classifyContinuity(metadata) {
  const {
    task,
    activeLease,
    activeLeaseCount: activeOwners,
    ownershipStatus,
    routingAction,
    routingReasonCodes,
    checkpointState,
    handoffInspection,
  } = metadata;

  if (task?.status === 'retired') {
    return {
      posture: 'retired',
      recommendedAction: 'no_action',
      reasonCodes: ['task_retired'],
    };
  }

  if (
    activeOwners > 1
      || ownershipStatus === 'ambiguous'
      || routingReasonCodes.includes('ownership_ambiguous')
      || handoffInspection?.top_status === 'ambiguous'
      || handoffInspection?.top_status === 'invalid'
  ) {
    const reasonCodes = [];
    if (activeOwners > 1) reasonCodes.push('conflicting_active_owner');
    if (ownershipStatus === 'ambiguous' || routingReasonCodes.includes('ownership_ambiguous')) {
      reasonCodes.push('ownership_ambiguous');
    }
    if (handoffInspection?.top_status === 'ambiguous') reasonCodes.push('handoff_ambiguous');
    if (handoffInspection?.top_status === 'invalid') reasonCodes.push('handoff_invalid');
    return {
      posture: 'ambiguous',
      recommendedAction: 'hold_for_human',
      reasonCodes,
    };
  }

  if (
    handoffInspection?.top_status === 'accepted'
      || handoffInspection?.top_status === 'pending_decision'
      || handoffInspection?.top_status === 'open'
  ) {
    return {
      posture: handoffInspection.top_status === 'accepted' ? 'handoff_granted' : 'handoff_pending',
      recommendedAction: 'handoff_to_successor',
      reasonCodes: uniqueStrings([
        ownershipStatus === 'orphaned' || routingAction === 'handoff_to_successor'
          ? 'ownership_orphaned'
          : null,
        handoffInspection.top_status === 'accepted'
          ? 'accepted_successor_handoff'
          : 'open_successor_handoff',
      ]),
    };
  }

  if (
    activeLease
      || ownershipStatus === 'clear'
      || routingAction === 'continue_current_worker'
  ) {
    return {
      posture: 'active_owner',
      recommendedAction: 'continue_current_worker',
      reasonCodes: ['ownership_clear'],
    };
  }

  if (ownershipStatus === 'stale' || routingAction === 'restore_existing_worker') {
    if (checkpointState === 'valid') {
      return {
        posture: 'restore_ready',
        recommendedAction: 'restore_existing_worker',
        reasonCodes: ['ownership_stale', 'valid_resume_checkpoint'],
      };
    }

    return {
      posture: 'ambiguous',
      recommendedAction: 'hold_for_human',
      reasonCodes: uniqueStrings([
        'ownership_stale',
        ...reasonCodesForCheckpoint(metadata.checkpointInspection),
      ]),
    };
  }

  if (ownershipStatus === 'orphaned' || routingAction === 'handoff_to_successor') {
    return {
      posture: 'orphaned',
      recommendedAction: 'handoff_to_successor',
      reasonCodes: ['ownership_orphaned'],
    };
  }

  if (metadata.latestLease) {
    if (checkpointState === 'valid') {
      return {
        posture: 'restore_ready',
        recommendedAction: 'restore_existing_worker',
        reasonCodes: ['ownership_stale', 'valid_resume_checkpoint'],
      };
    }

    return {
      posture: 'ambiguous',
      recommendedAction: 'hold_for_human',
      reasonCodes: uniqueStrings([
        'ownership_stale',
        ...reasonCodesForCheckpoint(metadata.checkpointInspection),
      ]),
    };
  }

  return {
    posture: 'orphaned',
    recommendedAction: 'handoff_to_successor',
    reasonCodes: ['ownership_orphaned', 'no_owner_history'],
  };
}

export function buildTaskContinuityReport({
  task,
  prBinding = null,
  ownershipLeases = [],
  checkpointInspection = null,
  handoffInspection = null,
  lifecycleReport = null,
  reconciliationReport = null,
} = {}) {
  if (!task) return null;

  const metadata = buildBaseMetadata({
    task,
    prBinding,
    reconciliationReport,
    lifecycleReport,
    ownershipLeases,
    handoffInspection,
    checkpointInspection,
  });
  metadata.handoffInspection = handoffInspection;
  metadata.checkpointInspection = checkpointInspection;

  const classification = classifyContinuity(metadata);

  return createContinuityInspection({
    taskId: task.task_id,
    issueNumber: task.issue_number ?? null,
    prNumber: metadata.prNumber,
    taskStatus: task.status ?? null,
    posture: classification.posture,
    recommendedAction: classification.recommendedAction,
    ownerSessionName: metadata.ownerSessionName,
    successorSessionName: metadata.successorSessionName,
    checkpointId: metadata.checkpointId,
    checkpointState: metadata.checkpointState,
    handoffRequestId: metadata.handoffRequestId,
    reasonCodes: classification.reasonCodes,
  });
}

function selectInspectionByTaskId(inspections, taskId) {
  return (inspections ?? []).find((inspection) => inspection?.task_id === taskId) ?? null;
}

export function buildTaskContinuityFromSnapshot({
  snapshot,
  taskId,
  checkpointInspections = [],
  handoffInspections = [],
  checkpointInspection = undefined,
  handoffInspection = undefined,
  lifecycleReport = null,
  reconciliationReport = null,
} = {}) {
  const task = (snapshot?.state?.managed_tasks ?? []).find((record) => record?.task_id === taskId) ?? null;
  if (!task) return null;

  return buildTaskContinuityReport({
    task,
    prBinding: selectPrBinding(snapshot, taskId),
    ownershipLeases: (snapshot?.state?.ownership_leases ?? []).filter((lease) => lease?.task_id === taskId),
    checkpointInspection: checkpointInspection ?? selectInspectionByTaskId(checkpointInspections, taskId),
    handoffInspection: handoffInspection ?? selectInspectionByTaskId(handoffInspections, taskId),
    lifecycleReport,
    reconciliationReport,
  });
}

export function summarizeContinuityReports(reports = []) {
  const postureCounts = Object.fromEntries(CONTINUITY_POSTURES.map((posture) => [posture, 0]));
  const recommendedActionCounts = Object.fromEntries(
    CONTINUITY_RECOMMENDED_ACTIONS.map((action) => [action, 0]),
  );

  for (const report of reports ?? []) {
    if (report?.posture && postureCounts[report.posture] != null) {
      postureCounts[report.posture] += 1;
    }
    if (report?.recommended_action && recommendedActionCounts[report.recommended_action] != null) {
      recommendedActionCounts[report.recommended_action] += 1;
    }
  }

  return {
    posture_counts: postureCounts,
    recommended_action_counts: recommendedActionCounts,
  };
}
