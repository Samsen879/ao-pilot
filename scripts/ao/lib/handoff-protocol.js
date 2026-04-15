import { createCheckpointStore } from './checkpoint-store.js';
import {
  HANDOFF_CLAIM_FORMAT,
  HANDOFF_CLAIM_SCHEMA_VERSION,
  HANDOFF_DECISION_FORMAT,
  HANDOFF_DECISION_SCHEMA_VERSION,
  HANDOFF_REQUEST_FORMAT,
  HANDOFF_REQUEST_SCHEMA_VERSION,
  HANDOFF_TRANSFER_FORMAT,
  HANDOFF_TRANSFER_SCHEMA_VERSION,
} from './state-contracts.js';
import {
  createHandoffDecisionTransition,
  createHandoffTransferTransition,
  transitionHandoffClaim,
  transitionHandoffRequest,
} from './transition-engine.js';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function sanitizeToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_');
}

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function sortByUpdatedAtDescending(items = [], key = 'updated_at') {
  return [...items].sort((left, right) => {
    const byTimestamp = compareIsoDescending(left?.[key], right?.[key]);
    if (byTimestamp !== 0) return byTimestamp;
    return String(right?.request_id ?? right?.claim_id ?? right?.decision_id ?? right?.transfer_id ?? '')
      .localeCompare(String(left?.request_id ?? left?.claim_id ?? left?.decision_id ?? left?.transfer_id ?? ''));
  });
}

function isExpired(isoTimestamp, now) {
  if (!isoTimestamp) return false;
  return new Date(isoTimestamp).getTime() <= new Date(now).getTime();
}

function latestLeaseForTask(snapshot, taskId) {
  return sortByUpdatedAtDescending(
    (snapshot?.state?.ownership_leases ?? []).filter((lease) => lease?.task_id === taskId),
    'acquired_at',
  )[0] ?? null;
}

function activeLeasesForTask(snapshot, taskId) {
  return (snapshot?.state?.ownership_leases ?? []).filter((lease) => (
    lease?.task_id === taskId && lease?.status === 'active'
  ));
}

function resolveTask(snapshot, {
  taskId = null,
  issueNumber = null,
} = {}) {
  const normalizedIssueNumber = issueNumber == null ? null : Number(issueNumber);
  return (snapshot?.state?.managed_tasks ?? []).find((task) => (
    (taskId && task?.task_id === taskId)
      || (normalizedIssueNumber != null && task?.issue_number === normalizedIssueNumber)
  )) ?? null;
}

function resolveRequest(snapshot, {
  requestId = null,
  taskId = null,
  issueNumber = null,
} = {}) {
  if (requestId) {
    return (snapshot?.state?.handoff_requests ?? []).find((request) => request?.request_id === requestId) ?? null;
  }

  const task = resolveTask(snapshot, { taskId, issueNumber });
  if (!task) return null;
  return sortByUpdatedAtDescending(
    (snapshot?.state?.handoff_requests ?? []).filter((request) => request?.task_id === task.task_id),
  )[0] ?? null;
}

function buildProtocolRequestId(snapshot, taskId, timestamp) {
  const count = (snapshot?.state?.handoff_requests ?? []).filter((request) => request?.task_id === taskId).length + 1;
  return `handoff-${sanitizeToken(taskId)}-${sanitizeToken(timestamp)}-${count}`;
}

function buildProtocolClaimId(snapshot, requestId, successorSessionName, timestamp) {
  const count = (snapshot?.state?.handoff_claims ?? []).filter((claim) => claim?.request_id === requestId).length + 1;
  return `claim-${sanitizeToken(requestId)}-${sanitizeToken(successorSessionName)}-${sanitizeToken(timestamp)}-${count}`;
}

function distinctPendingSuccessors(claims = []) {
  return [...new Set(
    claims
      .filter((claim) => claim?.status === 'pending')
      .map((claim) => claim?.successor_session_name)
      .filter(Boolean),
  )];
}

function inspectHandoffRequest({
  snapshot,
  checkpointStore,
  request,
  now,
} = {}) {
  if (!request) return null;

  const reasonCodes = [];
  const claims = (snapshot?.state?.handoff_claims ?? []).filter((claim) => claim?.request_id === request.request_id);
  const decisions = (snapshot?.state?.handoff_decisions ?? []).filter((decision) => decision?.request_id === request.request_id);
  const transfers = (snapshot?.state?.handoff_transfers ?? []).filter((transfer) => transfer?.request_id === request.request_id);
  const task = resolveTask(snapshot, { taskId: request.task_id });
  const checkpointInspection = checkpointStore.inspectCheckpoint({
    checkpointId: request?.lineage?.checkpoint_id,
  });
  const activeLeases = activeLeasesForTask(snapshot, request.task_id);
  const selectedClaim = request.selected_claim_id == null
    ? null
    : (claims.find((claim) => claim.claim_id === request.selected_claim_id) ?? null);
  const acceptedDecision = request.accepted_decision_id == null
    ? null
    : (decisions.find((decision) => decision.decision_id === request.accepted_decision_id) ?? null);
  const pendingSuccessors = distinctPendingSuccessors(claims);

  if (request.schema_version !== HANDOFF_REQUEST_SCHEMA_VERSION || request.format !== HANDOFF_REQUEST_FORMAT) {
    reasonCodes.push('handoff_request_mixed_version');
  }
  if (!task) {
    reasonCodes.push('handoff_task_missing');
  } else if (task.status === 'retired') {
    reasonCodes.push('handoff_task_retired');
  }
  if (checkpointInspection?.state !== 'valid') {
    reasonCodes.push(
      checkpointInspection?.state === 'stale'
        ? 'handoff_checkpoint_stale'
        : 'handoff_checkpoint_invalid',
    );
  }
  if (activeLeases.length > 1) {
    reasonCodes.push('conflicting_active_owner');
  } else if (
    activeLeases.length === 1
      && request.status !== 'completed'
      && request.lineage?.prior_ownership_lease_id
      && activeLeases[0].lease_id !== request.lineage.prior_ownership_lease_id
      && activeLeases[0].owner_session_name !== selectedClaim?.successor_session_name
  ) {
    reasonCodes.push('conflicting_active_owner');
  }
  if (isExpired(request.expires_at, now) && ['open', 'accepted'].includes(request.status)) {
    reasonCodes.push('handoff_request_expired');
  }

  for (const claim of claims) {
    if (claim.schema_version !== HANDOFF_CLAIM_SCHEMA_VERSION || claim.format !== HANDOFF_CLAIM_FORMAT) {
      reasonCodes.push('handoff_claim_mixed_version');
      break;
    }
  }
  for (const decision of decisions) {
    if (decision.schema_version !== HANDOFF_DECISION_SCHEMA_VERSION || decision.format !== HANDOFF_DECISION_FORMAT) {
      reasonCodes.push('handoff_decision_mixed_version');
      break;
    }
  }
  for (const transfer of transfers) {
    if (transfer.schema_version !== HANDOFF_TRANSFER_SCHEMA_VERSION || transfer.format !== HANDOFF_TRANSFER_FORMAT) {
      reasonCodes.push('handoff_transfer_mixed_version');
      break;
    }
  }

  if (!acceptedDecision && request.status === 'accepted') {
    reasonCodes.push('accepted_decision_missing');
  }
  if (acceptedDecision && isExpired(acceptedDecision.grant_expires_at, now) && transfers.length === 0) {
    reasonCodes.push('expired_grant');
  }
  if (pendingSuccessors.length > 1 && request.status === 'open' && request.accepted_decision_id == null) {
    reasonCodes.push('ambiguous_successor_selection');
  }

  let topStatus = 'open';
  if (reasonCodes.some((code) => (
    code.endsWith('_mixed_version')
      || code === 'handoff_task_missing'
      || code === 'handoff_task_retired'
      || code === 'handoff_checkpoint_invalid'
      || code === 'conflicting_active_owner'
  ))) {
    topStatus = 'invalid';
  } else if (request.status === 'completed' || transfers.length > 0) {
    topStatus = 'completed';
  } else if (request.status === 'rejected') {
    topStatus = 'rejected';
  } else if (
    request.status === 'expired'
      || reasonCodes.includes('handoff_request_expired')
      || reasonCodes.includes('expired_grant')
  ) {
    topStatus = 'expired';
  } else if (reasonCodes.includes('ambiguous_successor_selection')) {
    topStatus = 'ambiguous';
  } else if (request.status === 'accepted' || acceptedDecision) {
    topStatus = 'accepted';
  } else if (pendingSuccessors.length === 1) {
    topStatus = 'pending_decision';
  }

  return {
    task_id: request.task_id,
    request_id: request.request_id,
    top_status: topStatus,
    reason_codes: [...new Set([...request.reason_codes, ...reasonCodes])],
    request,
    claims: sortByUpdatedAtDescending(claims),
    decisions: sortByUpdatedAtDescending(decisions, 'decided_at'),
    transfers: sortByUpdatedAtDescending(transfers, 'transferred_at'),
    checkpoint: checkpointInspection,
  };
}

export function createHandoffProtocol({
  repository,
  now = () => new Date().toISOString(),
} = {}) {
  const checkpointStore = createCheckpointStore({
    repository,
    now,
  });

  function resolveSnapshot() {
    return repository.getSnapshot();
  }

  function resolveTaskOrThrow(identity) {
    const snapshot = resolveSnapshot();
    const task = resolveTask(snapshot, identity);
    if (!task) {
      throw new Error(`Missing managed task for ${identity.taskId ?? identity.issueNumber}`);
    }
    return {
      snapshot,
      task,
    };
  }

  function assertRequestable(snapshot, task, timestamp, allowDuplicateTaskRequest = false) {
    const activeRequests = (snapshot?.state?.handoff_requests ?? []).filter((request) => (
      request?.task_id === task.task_id && ['open', 'accepted'].includes(request?.status)
    ));
    if (activeRequests.length > 0 && !allowDuplicateTaskRequest) {
      throw new Error(`Active handoff request already exists for ${task.task_id}`);
    }

    const activeLeases = activeLeasesForTask(snapshot, task.task_id);
    if (activeLeases.length > 1) {
      throw new Error(`Cannot request handoff for ${task.task_id} with conflicting active owners`);
    }
    if (activeLeases.length === 1 && !isExpired(activeLeases[0].expires_at, timestamp)) {
      throw new Error(`Cannot request handoff for ${task.task_id} while ownership lease remains active`);
    }
  }

  return {
    requestHandoff({
      taskId = null,
      issueNumber = null,
      requestedBySessionName = null,
      requestedBySessionId = null,
      operatorSessionName = null,
      operatorSessionId = null,
      successorSessionName = null,
      successorSessionId = null,
      reason = null,
      allowDuplicateTaskRequest = false,
    } = {}) {
      const timestamp = resolveNow(now);
      const { snapshot, task } = resolveTaskOrThrow({ taskId, issueNumber });
      assertRequestable(snapshot, task, timestamp, allowDuplicateTaskRequest);

      const checkpoint = checkpointStore.loadCheckpointForResume({
        taskId: task.task_id,
      });
      const latestLease = latestLeaseForTask(snapshot, task.task_id);
      const activeBinding = (snapshot.state.pr_bindings ?? []).find((binding) => (
        binding?.task_id === task.task_id && binding?.status === 'bound'
      )) ?? null;

      const request = transitionHandoffRequest({
        intent: 'create',
        now: timestamp,
        requestId: buildProtocolRequestId(snapshot, task.task_id, timestamp),
        taskId: task.task_id,
        requestedBySessionName,
        requestedBySessionId,
        operatorSessionName,
        operatorSessionId,
        successorSessionName,
        successorSessionId,
        reason,
        lineage: {
          checkpoint_id: checkpoint.checkpoint_id,
          checkpoint_recorded_at: checkpoint.record.recorded_at,
          checkpoint_state: checkpoint.state,
          prior_ownership_lease_id: latestLease?.lease_id ?? null,
          prior_owner_session_name: latestLease?.owner_session_name ?? null,
          prior_owner_session_id: latestLease?.owner_session_id ?? null,
          prior_ownership_status: latestLease?.status ?? null,
          pr_binding_id: activeBinding?.binding_id ?? null,
          pr_number: activeBinding?.pr_number ?? null,
        },
      });

      return repository.upsertHandoffRequest(request);
    },

    claimHandoff({
      requestId = null,
      taskId = null,
      issueNumber = null,
      successorSessionName,
      successorSessionId = null,
      reason = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const request = resolveRequest(snapshot, {
        requestId,
        taskId,
        issueNumber,
      });

      if (!request) {
        throw new Error('Missing handoff request');
      }

      const existingClaims = (snapshot.state.handoff_claims ?? []).filter((claim) => claim.request_id === request.request_id);
      if (request.status !== 'open') {
        return repository.upsertHandoffClaim(transitionHandoffClaim({
          intent: 'block',
          claimId: buildProtocolClaimId(snapshot, request.request_id, successorSessionName, timestamp),
          now: timestamp,
          requestId: request.request_id,
          taskId: request.task_id,
          successorSessionName,
          successorSessionId,
          reason,
          reasonCodes: ['request_not_open'],
        }));
      }
      if (request.successor_session_name && request.successor_session_name !== successorSessionName) {
        return repository.upsertHandoffClaim(transitionHandoffClaim({
          intent: 'block',
          now: timestamp,
          requestId: request.request_id,
          taskId: request.task_id,
          successorSessionName,
          successorSessionId,
          reason,
          reasonCodes: ['successor_not_authorized'],
        }));
      }

      const duplicateClaim = existingClaims.find((claim) => (
        claim.successor_session_name === successorSessionName
          && ['pending', 'accepted'].includes(claim.status)
      ));
      if (duplicateClaim) {
        return repository.upsertHandoffClaim(transitionHandoffClaim({
          intent: 'block',
          claimId: buildProtocolClaimId(snapshot, request.request_id, successorSessionName, timestamp),
          now: timestamp,
          requestId: request.request_id,
          taskId: request.task_id,
          successorSessionName,
          successorSessionId,
          reason,
          reasonCodes: ['duplicate_successor_claim'],
        }));
      }

      return repository.upsertHandoffClaim(transitionHandoffClaim({
        intent: 'create',
        claimId: buildProtocolClaimId(snapshot, request.request_id, successorSessionName, timestamp),
        now: timestamp,
        requestId: request.request_id,
        taskId: request.task_id,
        successorSessionName,
        successorSessionId,
        reason,
      }));
    },

    acceptHandoff({
      requestId,
      claimId = null,
      operatorSessionName,
      operatorSessionId = null,
      reason = null,
      grantExpiresAt = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const request = resolveRequest(snapshot, { requestId });
      if (!request) {
        throw new Error('Missing handoff request');
      }

      const claims = (snapshot.state.handoff_claims ?? []).filter((claim) => (
        claim.request_id === request.request_id && claim.status === 'pending'
      ));
      const claim = claimId
        ? claims.find((record) => record.claim_id === claimId) ?? null
        : (claims.length === 1 ? claims[0] : null);
      if (!claim) {
        throw new Error(`Ambiguous successor selection for ${request.request_id}`);
      }

      const decision = createHandoffDecisionTransition({
        requestId: request.request_id,
        claimId: claim.claim_id,
        taskId: request.task_id,
        outcome: 'accept',
        now: timestamp,
        operatorSessionName,
        operatorSessionId,
        successorSessionName: claim.successor_session_name,
        successorSessionId: claim.successor_session_id,
        grantExpiresAt,
        reason,
      });
      repository.upsertHandoffDecision(decision);
      repository.upsertHandoffClaim(transitionHandoffClaim({
        intent: 'accept',
        existingClaim: claim,
        now: timestamp,
        operatorSessionName,
        operatorSessionId,
        decisionId: decision.decision_id,
      }));

      return repository.upsertHandoffRequest(transitionHandoffRequest({
        intent: 'accept',
        existingRequest: request,
        now: timestamp,
        selectedClaimId: claim.claim_id,
        acceptedDecisionId: decision.decision_id,
      }));
    },

    rejectHandoff({
      requestId,
      claimId = null,
      operatorSessionName,
      operatorSessionId = null,
      reason = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const request = resolveRequest(snapshot, { requestId });
      if (!request) {
        throw new Error('Missing handoff request');
      }

      const decision = createHandoffDecisionTransition({
        requestId: request.request_id,
        claimId,
        taskId: request.task_id,
        outcome: 'reject',
        now: timestamp,
        operatorSessionName,
        operatorSessionId,
        reason,
      });
      repository.upsertHandoffDecision(decision);

      if (claimId) {
        const claim = (snapshot.state.handoff_claims ?? []).find((record) => record.claim_id === claimId) ?? null;
        if (claim) {
          repository.upsertHandoffClaim(transitionHandoffClaim({
            intent: 'reject',
            existingClaim: claim,
            now: timestamp,
            operatorSessionName,
            operatorSessionId,
            decisionId: decision.decision_id,
          }));
        }
      }

      return repository.upsertHandoffRequest(transitionHandoffRequest({
        intent: 'reject',
        existingRequest: request,
        now: timestamp,
      }));
    },

    expireHandoff({
      requestId,
      operatorSessionName,
      operatorSessionId = null,
      reason = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const snapshot = resolveSnapshot();
      const request = resolveRequest(snapshot, { requestId });
      if (!request) {
        throw new Error('Missing handoff request');
      }

      const decision = createHandoffDecisionTransition({
        requestId: request.request_id,
        taskId: request.task_id,
        outcome: 'expire',
        now: timestamp,
        operatorSessionName,
        operatorSessionId,
        reason,
      });
      repository.upsertHandoffDecision(decision);

      return repository.upsertHandoffRequest(transitionHandoffRequest({
        intent: 'expire',
        existingRequest: request,
        now: timestamp,
      }));
    },

    inspectTaskHandoff({
      taskId = null,
      issueNumber = null,
      requestId = null,
    } = {}) {
      const snapshot = resolveSnapshot();
      return inspectHandoffRequest({
        snapshot,
        checkpointStore,
        request: resolveRequest(snapshot, {
          taskId,
          issueNumber,
          requestId,
        }),
        now: resolveNow(now),
      });
    },

    inspectAllHandoffs() {
      const snapshot = resolveSnapshot();
      return sortByUpdatedAtDescending(snapshot.state.handoff_requests ?? [])
        .map((request) => inspectHandoffRequest({
          snapshot,
          checkpointStore,
          request,
          now: resolveNow(now),
        }))
        .filter(Boolean);
    },

    resolveAcceptedHandoff({
      taskId,
      successorSessionName,
      requestId = null,
    } = {}) {
      const inspections = this.inspectAllHandoffs()
        .filter((inspection) => inspection?.task_id === taskId)
        .filter((inspection) => requestId == null || inspection?.request_id === requestId)
        .filter((inspection) => inspection?.top_status === 'accepted')
        .filter((inspection) => (
          inspection?.request?.selected_claim_id
            ? inspection.claims.some((claim) => (
              claim.claim_id === inspection.request.selected_claim_id
                && claim.successor_session_name === successorSessionName
            ))
            : inspection.request?.successor_session_name === successorSessionName
        ));

      if (inspections.length > 1) {
        throw new Error(`Ambiguous accepted handoff for ${taskId}`);
      }

      return inspections[0] ?? null;
    },

    completeAcceptedHandoff({
      taskId,
      successorSessionName,
      successorSessionId = null,
      successorOwnershipLeaseId,
      successorOwnershipLease,
      transferredBy = null,
      reason = null,
      requestId = null,
    } = {}) {
      const timestamp = resolveNow(now);
      const acceptedInspection = this.resolveAcceptedHandoff({
        taskId,
        successorSessionName,
        requestId,
      });
      if (!acceptedInspection) {
        return null;
      }

      const request = acceptedInspection.request;
      const claim = acceptedInspection.claims.find((record) => record.claim_id === request.selected_claim_id) ?? null;
      const decision = acceptedInspection.decisions.find((record) => record.decision_id === request.accepted_decision_id) ?? null;
      if (!claim || !decision) {
        throw new Error(`Accepted handoff metadata is incomplete for ${taskId}`);
      }
      if (isExpired(decision.grant_expires_at, timestamp)) {
        throw new Error(`Accepted handoff grant expired for ${taskId}`);
      }

      const transfer = createHandoffTransferTransition({
        requestId: request.request_id,
        claimId: claim.claim_id,
        decisionId: decision.decision_id,
        taskId,
        checkpointId: request.lineage.checkpoint_id,
        previousOwnershipLeaseId: request.lineage.prior_ownership_lease_id,
        previousOwnerSessionName: request.lineage.prior_owner_session_name,
        previousOwnerSessionId: request.lineage.prior_owner_session_id,
        successorOwnershipLeaseId,
        successorSessionName,
        successorSessionId,
        now: timestamp,
        transferredBy,
        reason,
        metadata: {
          successor_lease: successorOwnershipLease ?? null,
        },
      });
      repository.upsertHandoffTransfer(transfer);
      repository.upsertHandoffRequest(transitionHandoffRequest({
        intent: 'complete',
        existingRequest: request,
        now: timestamp,
        completedTransferId: transfer.transfer_id,
      }));

      return transfer;
    },
  };
}
