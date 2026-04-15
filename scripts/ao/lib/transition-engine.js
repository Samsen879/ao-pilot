import {
  CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  createControllerLease,
  createHandoffClaimRecord,
  createHandoffDecisionRecord,
  createHandoffRequestRecord,
  createHandoffTransferRecord,
  createManagedTask,
  createOwnershipLease,
  createPrBinding,
} from './state-contracts.js';

export const DEFAULT_OWNERSHIP_LEASE_DURATION_MS = 20 * 60 * 1000;
export const DEFAULT_CONTROLLER_LEASE_DURATION_MS = 5 * 60 * 1000;
export const DEFAULT_HANDOFF_REQUEST_DURATION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_HANDOFF_GRANT_DURATION_MS = 20 * 60 * 1000;

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function sanitizeToken(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_');
}

function addMilliseconds(isoTimestamp, durationMs) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }

  return new Date(date.getTime() + durationMs).toISOString();
}

function illegalTransition(kind, fromStatus, intent) {
  throw new Error(`Illegal ${kind} transition from ${fromStatus ?? 'missing'} via ${intent}`);
}

export function deriveManagedTaskId({ taskId = null, issueNumber = null } = {}) {
  if (typeof taskId === 'string' && taskId.trim() !== '') {
    return taskId.trim();
  }

  const normalizedIssueNumber = Number(issueNumber);
  if (Number.isInteger(normalizedIssueNumber) && normalizedIssueNumber > 0) {
    return `issue-${normalizedIssueNumber}`;
  }

  throw new Error('Missing managed-task identity');
}

export function buildPrBindingId({ taskId, prNumber } = {}) {
  return `binding-${sanitizeToken(taskId)}-pr-${Number(prNumber)}`;
}

export function buildOwnershipLeaseId({ taskId, ownerSessionName } = {}) {
  return `ownership-${sanitizeToken(taskId)}-${sanitizeToken(ownerSessionName)}`;
}

export function buildControllerLeaseId({
  controllerId = CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  holderId,
  incarnationId = null,
} = {}) {
  const segments = [
    'controller',
    sanitizeToken(controllerId),
    sanitizeToken(holderId),
  ];
  if (incarnationId != null) {
    segments.push(sanitizeToken(incarnationId));
  }
  return segments.join('-');
}

export function buildHandoffRequestId({ taskId, requestedAt } = {}) {
  return `handoff-${sanitizeToken(taskId)}-${sanitizeToken(requestedAt)}`;
}

export function buildHandoffClaimId({ requestId, successorSessionName } = {}) {
  return `claim-${sanitizeToken(requestId)}-${sanitizeToken(successorSessionName)}`;
}

export function buildHandoffDecisionId({ requestId, outcome, decidedAt } = {}) {
  return `decision-${sanitizeToken(requestId)}-${sanitizeToken(outcome)}-${sanitizeToken(decidedAt)}`;
}

export function buildHandoffTransferId({ requestId, transferredAt } = {}) {
  return `transfer-${sanitizeToken(requestId)}-${sanitizeToken(transferredAt)}`;
}

export function transitionManagedTask({
  intent,
  existingTask = null,
  now = new Date().toISOString(),
  taskId = null,
  issueNumber = null,
  title = null,
  branchName = null,
  worktreePath = null,
  metadata = null,
} = {}) {
  const timestamp = resolveNow(now);
  const resolvedTaskId = existingTask?.task_id ?? deriveManagedTaskId({
    taskId,
    issueNumber: issueNumber ?? existingTask?.issue_number ?? null,
  });
  const resolvedIssueNumber = issueNumber ?? existingTask?.issue_number ?? null;
  const resolvedTitle = title ?? existingTask?.title ?? (resolvedIssueNumber != null ? `Issue #${resolvedIssueNumber}` : resolvedTaskId);
  const nextBranchName = branchName ?? existingTask?.branch_name ?? null;
  const nextWorktreePath = worktreePath ?? existingTask?.worktree_path ?? null;
  const nextMetadata = metadata ?? existingTask?.metadata ?? {};
  const currentStatus = existingTask?.status ?? null;

  switch (intent) {
    case 'enroll':
      if (currentStatus === 'retired') illegalTransition('managed-task', currentStatus, intent);
      return createManagedTask({
        task_id: resolvedTaskId,
        issue_number: resolvedIssueNumber,
        title: resolvedTitle,
        branch_name: nextBranchName,
        worktree_path: nextWorktreePath,
        status: 'active',
        created_at: existingTask?.created_at ?? timestamp,
        updated_at: timestamp,
        metadata: nextMetadata,
      });
    case 'adopt':
      if (!existingTask) illegalTransition('managed-task', currentStatus, intent);
      if (currentStatus === 'retired') illegalTransition('managed-task', currentStatus, intent);
      return createManagedTask({
        task_id: resolvedTaskId,
        issue_number: resolvedIssueNumber,
        title: resolvedTitle,
        branch_name: nextBranchName,
        worktree_path: nextWorktreePath,
        status: 'active',
        created_at: existingTask.created_at,
        updated_at: timestamp,
        metadata: nextMetadata,
      });
    case 'unmanage':
      if (!existingTask || currentStatus === 'retired') illegalTransition('managed-task', currentStatus, intent);
      return createManagedTask({
        task_id: resolvedTaskId,
        issue_number: resolvedIssueNumber,
        title: resolvedTitle,
        branch_name: nextBranchName,
        worktree_path: nextWorktreePath,
        status: 'paused',
        created_at: existingTask.created_at,
        updated_at: timestamp,
        metadata: nextMetadata,
      });
    case 'retire':
      if (!existingTask) illegalTransition('managed-task', currentStatus, intent);
      return createManagedTask({
        task_id: resolvedTaskId,
        issue_number: resolvedIssueNumber,
        title: resolvedTitle,
        branch_name: nextBranchName,
        worktree_path: nextWorktreePath,
        status: 'retired',
        created_at: existingTask.created_at,
        updated_at: timestamp,
        metadata: nextMetadata,
      });
    default:
      throw new Error(`Unsupported managed-task intent: ${intent}`);
  }
}

export function transitionPrBinding({
  intent,
  existingBinding = null,
  now = new Date().toISOString(),
  bindingId = null,
  taskId,
  prNumber = null,
  branchName = null,
  baseBranch = null,
  metadata = null,
  reason = null,
} = {}) {
  const timestamp = resolveNow(now);
  const currentStatus = existingBinding?.status ?? null;

  switch (intent) {
    case 'bind':
      if (currentStatus === 'closed') illegalTransition('pr-binding', currentStatus, intent);
      return createPrBinding({
        binding_id: bindingId ?? existingBinding?.binding_id ?? buildPrBindingId({
          taskId: taskId ?? existingBinding?.task_id,
          prNumber: prNumber ?? existingBinding?.pr_number,
        }),
        task_id: taskId ?? existingBinding?.task_id,
        pr_number: prNumber ?? existingBinding?.pr_number,
        branch_name: branchName ?? existingBinding?.branch_name ?? null,
        base_branch: baseBranch ?? existingBinding?.base_branch ?? null,
        status: 'bound',
        created_at: existingBinding?.created_at ?? timestamp,
        updated_at: timestamp,
        metadata: metadata ?? existingBinding?.metadata ?? {},
      });
    case 'release':
      if (!existingBinding || currentStatus !== 'bound') illegalTransition('pr-binding', currentStatus, intent);
      return createPrBinding({
        ...existingBinding,
        status: 'released',
        updated_at: timestamp,
        metadata: {
          ...(existingBinding.metadata ?? {}),
          release_reason: reason ?? null,
        },
      });
    default:
      throw new Error(`Unsupported PR binding intent: ${intent}`);
  }
}

function transitionLease({
  kind,
  intent,
  existingLease = null,
  factory,
  now = new Date().toISOString(),
  defaultDurationMs,
  reason = null,
  ...fields
} = {}) {
  const timestamp = resolveNow(now);
  const currentStatus = existingLease?.status ?? null;

  switch (intent) {
    case 'acquire':
      if (currentStatus === 'active') illegalTransition(`${kind} lease`, currentStatus, intent);
      return factory({
        ...existingLease,
        ...fields,
        status: 'active',
        acquired_at: timestamp,
        expires_at: fields.expiresAt ?? existingLease?.expires_at ?? addMilliseconds(timestamp, defaultDurationMs),
        released_at: null,
        release_reason: null,
        metadata: fields.metadata ?? existingLease?.metadata ?? {},
      });
    case 'release':
      if (!existingLease || currentStatus !== 'active') illegalTransition(`${kind} lease`, currentStatus, intent);
      return factory({
        ...existingLease,
        status: 'released',
        released_at: timestamp,
        release_reason: reason ?? 'released',
        metadata: existingLease.metadata ?? {},
      });
    case 'expire':
      if (!existingLease || currentStatus !== 'active') illegalTransition(`${kind} lease`, currentStatus, intent);
      return factory({
        ...existingLease,
        status: 'expired',
        released_at: timestamp,
        release_reason: reason ?? 'expired',
        metadata: existingLease.metadata ?? {},
      });
    default:
      throw new Error(`Unsupported ${kind} lease intent: ${intent}`);
  }
}

export function transitionOwnershipLease({
  intent,
  existingLease = null,
  now = new Date().toISOString(),
  leaseId = null,
  taskId = null,
  ownerSessionName = null,
  ownerSessionId = null,
  expiresAt = null,
  metadata = null,
  reason = null,
} = {}) {
  return transitionLease({
    kind: 'ownership',
    intent,
    existingLease,
    factory: createOwnershipLease,
    now,
    defaultDurationMs: DEFAULT_OWNERSHIP_LEASE_DURATION_MS,
    reason,
    lease_id: leaseId ?? existingLease?.lease_id,
    task_id: taskId ?? existingLease?.task_id,
    owner_session_name: ownerSessionName ?? existingLease?.owner_session_name,
    owner_session_id: ownerSessionId ?? existingLease?.owner_session_id ?? null,
    expiresAt,
    metadata,
  });
}

export function transitionControllerLease({
  intent,
  existingLease = null,
  now = new Date().toISOString(),
  leaseId = null,
  controllerId = CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  holderId = null,
  holderType = 'session',
  expiresAt = null,
  metadata = null,
  reason = null,
} = {}) {
  return transitionLease({
    kind: 'controller',
    intent,
    existingLease,
    factory: createControllerLease,
    now,
    defaultDurationMs: DEFAULT_CONTROLLER_LEASE_DURATION_MS,
    reason,
    lease_id: leaseId ?? existingLease?.lease_id,
    controller_id: controllerId ?? existingLease?.controller_id,
    holder_id: holderId ?? existingLease?.holder_id,
    holder_type: holderType ?? existingLease?.holder_type ?? 'session',
    expiresAt,
    metadata,
  });
}

export function transitionHandoffRequest({
  intent,
  existingRequest = null,
  now = new Date().toISOString(),
  requestId = null,
  taskId = null,
  requestedBySessionName = null,
  requestedBySessionId = null,
  operatorSessionName = null,
  operatorSessionId = null,
  successorSessionName = null,
  successorSessionId = null,
  reason = null,
  expiresAt = null,
  selectedClaimId = null,
  acceptedDecisionId = null,
  completedTransferId = null,
  reasonCodes = null,
  lineage = null,
  metadata = null,
} = {}) {
  const timestamp = resolveNow(now);
  const currentStatus = existingRequest?.status ?? null;

  switch (intent) {
    case 'create':
      if (existingRequest && ['open', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-request', currentStatus, intent);
      }
      return createHandoffRequestRecord({
        request_id: requestId ?? existingRequest?.request_id ?? buildHandoffRequestId({
          taskId,
          requestedAt: timestamp,
        }),
        task_id: taskId ?? existingRequest?.task_id,
        status: 'open',
        created_at: existingRequest?.created_at ?? timestamp,
        updated_at: timestamp,
        requested_by_session_name: requestedBySessionName ?? existingRequest?.requested_by_session_name,
        requested_by_session_id: requestedBySessionId ?? existingRequest?.requested_by_session_id,
        operator_session_name: operatorSessionName ?? existingRequest?.operator_session_name,
        operator_session_id: operatorSessionId ?? existingRequest?.operator_session_id,
        successor_session_name: successorSessionName ?? existingRequest?.successor_session_name,
        successor_session_id: successorSessionId ?? existingRequest?.successor_session_id,
        reason: reason ?? existingRequest?.reason ?? null,
        expires_at: expiresAt ?? existingRequest?.expires_at ?? addMilliseconds(timestamp, DEFAULT_HANDOFF_REQUEST_DURATION_MS),
        selected_claim_id: null,
        accepted_decision_id: null,
        completed_transfer_id: null,
        reason_codes: reasonCodes ?? existingRequest?.reason_codes ?? [],
        lineage: lineage ?? existingRequest?.lineage,
        metadata: metadata ?? existingRequest?.metadata ?? {},
      });
    case 'accept':
      if (!existingRequest || !['open', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-request', currentStatus, intent);
      }
      return createHandoffRequestRecord({
        ...existingRequest,
        status: 'accepted',
        updated_at: timestamp,
        selected_claim_id: selectedClaimId ?? existingRequest.selected_claim_id,
        accepted_decision_id: acceptedDecisionId ?? existingRequest.accepted_decision_id,
        reason_codes: reasonCodes ?? existingRequest.reason_codes ?? [],
      });
    case 'reject':
      if (!existingRequest || !['open', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-request', currentStatus, intent);
      }
      return createHandoffRequestRecord({
        ...existingRequest,
        status: 'rejected',
        updated_at: timestamp,
        reason_codes: reasonCodes ?? existingRequest.reason_codes ?? [],
      });
    case 'expire':
      if (!existingRequest || ['completed', 'rejected', 'expired'].includes(currentStatus)) {
        illegalTransition('handoff-request', currentStatus, intent);
      }
      return createHandoffRequestRecord({
        ...existingRequest,
        status: 'expired',
        updated_at: timestamp,
        reason_codes: reasonCodes ?? existingRequest.reason_codes ?? [],
      });
    case 'complete':
      if (!existingRequest || currentStatus !== 'accepted') {
        illegalTransition('handoff-request', currentStatus, intent);
      }
      return createHandoffRequestRecord({
        ...existingRequest,
        status: 'completed',
        updated_at: timestamp,
        completed_transfer_id: completedTransferId ?? existingRequest.completed_transfer_id,
        reason_codes: reasonCodes ?? existingRequest.reason_codes ?? [],
      });
    default:
      throw new Error(`Unsupported handoff-request intent: ${intent}`);
  }
}

export function transitionHandoffClaim({
  intent,
  existingClaim = null,
  now = new Date().toISOString(),
  claimId = null,
  requestId = null,
  taskId = null,
  successorSessionName = null,
  successorSessionId = null,
  operatorSessionName = null,
  operatorSessionId = null,
  decisionId = null,
  reason = null,
  reasonCodes = null,
  metadata = null,
} = {}) {
  const timestamp = resolveNow(now);
  const currentStatus = existingClaim?.status ?? null;

  switch (intent) {
    case 'create':
      if (existingClaim && ['pending', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-claim', currentStatus, intent);
      }
      return createHandoffClaimRecord({
        claim_id: claimId ?? existingClaim?.claim_id ?? buildHandoffClaimId({
          requestId,
          successorSessionName,
        }),
        request_id: requestId ?? existingClaim?.request_id,
        task_id: taskId ?? existingClaim?.task_id,
        status: 'pending',
        created_at: existingClaim?.created_at ?? timestamp,
        updated_at: timestamp,
        successor_session_name: successorSessionName ?? existingClaim?.successor_session_name,
        successor_session_id: successorSessionId ?? existingClaim?.successor_session_id,
        operator_session_name: operatorSessionName ?? existingClaim?.operator_session_name,
        operator_session_id: operatorSessionId ?? existingClaim?.operator_session_id,
        decision_id: decisionId ?? existingClaim?.decision_id ?? null,
        reason: reason ?? existingClaim?.reason ?? null,
        reason_codes: reasonCodes ?? existingClaim?.reason_codes ?? [],
        metadata: metadata ?? existingClaim?.metadata ?? {},
      });
    case 'block':
      return createHandoffClaimRecord({
        claim_id: claimId ?? existingClaim?.claim_id ?? buildHandoffClaimId({
          requestId,
          successorSessionName,
        }),
        request_id: requestId ?? existingClaim?.request_id,
        task_id: taskId ?? existingClaim?.task_id,
        status: 'blocked',
        created_at: existingClaim?.created_at ?? timestamp,
        updated_at: timestamp,
        successor_session_name: successorSessionName ?? existingClaim?.successor_session_name,
        successor_session_id: successorSessionId ?? existingClaim?.successor_session_id,
        operator_session_name: operatorSessionName ?? existingClaim?.operator_session_name,
        operator_session_id: operatorSessionId ?? existingClaim?.operator_session_id,
        decision_id: decisionId ?? existingClaim?.decision_id ?? null,
        reason: reason ?? existingClaim?.reason ?? null,
        reason_codes: reasonCodes ?? existingClaim?.reason_codes ?? [],
        metadata: metadata ?? existingClaim?.metadata ?? {},
      });
    case 'accept':
      if (!existingClaim || !['pending', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-claim', currentStatus, intent);
      }
      return createHandoffClaimRecord({
        ...existingClaim,
        status: 'accepted',
        updated_at: timestamp,
        operator_session_name: operatorSessionName ?? existingClaim.operator_session_name,
        operator_session_id: operatorSessionId ?? existingClaim.operator_session_id,
        decision_id: decisionId ?? existingClaim.decision_id,
        reason_codes: reasonCodes ?? existingClaim.reason_codes ?? [],
      });
    case 'reject':
      if (!existingClaim || !['pending', 'accepted'].includes(currentStatus)) {
        illegalTransition('handoff-claim', currentStatus, intent);
      }
      return createHandoffClaimRecord({
        ...existingClaim,
        status: 'rejected',
        updated_at: timestamp,
        operator_session_name: operatorSessionName ?? existingClaim.operator_session_name,
        operator_session_id: operatorSessionId ?? existingClaim.operator_session_id,
        decision_id: decisionId ?? existingClaim.decision_id,
        reason_codes: reasonCodes ?? existingClaim.reason_codes ?? [],
      });
    case 'expire':
      if (!existingClaim || ['blocked', 'rejected', 'expired'].includes(currentStatus)) {
        illegalTransition('handoff-claim', currentStatus, intent);
      }
      return createHandoffClaimRecord({
        ...existingClaim,
        status: 'expired',
        updated_at: timestamp,
        operator_session_name: operatorSessionName ?? existingClaim.operator_session_name,
        operator_session_id: operatorSessionId ?? existingClaim.operator_session_id,
        decision_id: decisionId ?? existingClaim.decision_id,
        reason_codes: reasonCodes ?? existingClaim.reason_codes ?? [],
      });
    default:
      throw new Error(`Unsupported handoff-claim intent: ${intent}`);
  }
}

export function createHandoffDecisionTransition({
  requestId,
  claimId = null,
  taskId,
  outcome,
  now = new Date().toISOString(),
  operatorSessionName,
  operatorSessionId = null,
  successorSessionName = null,
  successorSessionId = null,
  grantExpiresAt = null,
  reason = null,
  reasonCodes = [],
  metadata = {},
} = {}) {
  const timestamp = resolveNow(now);
  return createHandoffDecisionRecord({
    decision_id: buildHandoffDecisionId({
      requestId,
      outcome,
      decidedAt: timestamp,
    }),
    request_id: requestId,
    claim_id: claimId,
    task_id: taskId,
    outcome,
    decided_at: timestamp,
    operator_session_name: operatorSessionName,
    operator_session_id: operatorSessionId,
    successor_session_name: successorSessionName,
    successor_session_id: successorSessionId,
    grant_expires_at: grantExpiresAt ?? (outcome === 'accept'
      ? addMilliseconds(timestamp, DEFAULT_HANDOFF_GRANT_DURATION_MS)
      : null),
    reason,
    reason_codes: reasonCodes,
    metadata,
  });
}

export function createHandoffTransferTransition({
  requestId,
  claimId,
  decisionId,
  taskId,
  checkpointId,
  previousOwnershipLeaseId = null,
  previousOwnerSessionName = null,
  previousOwnerSessionId = null,
  successorOwnershipLeaseId,
  successorSessionName,
  successorSessionId = null,
  now = new Date().toISOString(),
  transferredBy = null,
  reason = null,
  metadata = {},
} = {}) {
  const timestamp = resolveNow(now);
  return createHandoffTransferRecord({
    transfer_id: buildHandoffTransferId({
      requestId,
      transferredAt: timestamp,
    }),
    request_id: requestId,
    claim_id: claimId,
    decision_id: decisionId,
    task_id: taskId,
    checkpoint_id: checkpointId,
    previous_ownership_lease_id: previousOwnershipLeaseId,
    previous_owner_session_name: previousOwnerSessionName,
    previous_owner_session_id: previousOwnerSessionId,
    successor_ownership_lease_id: successorOwnershipLeaseId,
    successor_session_name: successorSessionName,
    successor_session_id: successorSessionId,
    transferred_at: timestamp,
    transferred_by: transferredBy,
    reason,
    metadata,
  });
}
