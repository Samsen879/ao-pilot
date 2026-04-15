import { createHash, randomUUID } from 'node:crypto';

import {
  CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  createActionRecord,
  createControllerLease,
  createControllerModeRecord,
  createPolicyDecisionRecord,
} from './state-contracts.js';
import { createCheckpointStore } from './checkpoint-store.js';
import { createStateRepository } from './state-repository.js';
import {
  buildControllerLeaseId,
} from './transition-engine.js';
import {
  ingestManagedTaskPollEvents,
} from './event-ingest.js';
import { loadAoProjectObservation } from './ao-observation-source.js';
import { createDoctorPrScope, createDoctorProjectScope } from './doctor-contracts.js';
import { buildDoctorReport as buildDoctorReportModel } from './doctor-engine.js';
import { loadDoctorLocalState } from './doctor-local-state-source.js';
import { loadGitHubObservationSet } from './github-observation-source.js';
import {
  LIFECYCLE_DELIVERY_TRIGGER_PRIORITY,
  createLifecyclePrScope,
  createLifecycleProjectScope,
} from './lifecycle-contracts.js';
import {
  applyReviewGateToLifecycleReport,
  buildLifecycleReport as buildLifecycleReportModel,
} from './lifecycle-engine.js';
import {
  buildAssistActionModel,
  executeAssistActions,
  summarizeAssistActionRecord,
} from './action-executor.js';
import { buildTaskContinuityFromSnapshot } from './continuity.js';
import { buildDecisionChainReport } from './decision-chain.js';
import { deriveReviewPosture } from './review-contracts.js';
import { buildControllerRunMetric } from './run-metrics.js';
import {
  buildPolicyInputForAction,
  evaluatePolicyDecision,
} from './policy-engine.js';
import {
  createPrScope,
  createProjectScope,
} from './reconciliation-contracts.js';
import { reconcileObservations as reconcileObservationModels } from './reconciliation-engine.js';
import {
  buildCurrentProcessMetadata,
  matchesRecordedProcessIdentity,
} from './state-storage.js';

export const DEFAULT_PROJECT_ID = 'my-project';
export const CONTROLLER_MUTATION_MODES = ['observe', 'shadow', 'assist'];
export const DEFAULT_CONTROLLER_POLL_INTERVAL_MS = 30 * 1000;
export const DEFAULT_CONTROLLER_SHUTDOWN_TIMEOUT_MS = 10 * 1000;
export const DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_CONTROLLER_HEARTBEAT_INTERVAL_MS = 1000;
const CURRENT_PROCESS_COMPAT_STARTED_AT = new Date().toISOString();

class ControllerStopRequestedError extends Error {
  constructor(stepName) {
    super(`Controller shutdown requested during ${stepName}.`);
    this.name = 'ControllerStopRequestedError';
    this.code = 'controller_stop_requested';
    this.stepName = stepName;
  }
}

class ControllerShutdownTimeoutError extends Error {
  constructor(stepName) {
    super(`Controller shutdown timed out during ${stepName}.`);
    this.name = 'ControllerShutdownTimeoutError';
    this.code = 'controller_shutdown_timeout';
    this.stepName = stepName;
  }
}

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function addMilliseconds(isoTimestamp, durationMs) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp: ${isoTimestamp}`);
  }

  return new Date(date.getTime() + durationMs).toISOString();
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
  return {
    review_id: reviewRecord.review_id,
    task_id: reviewRecord.task_id,
    issue_number: reviewRecord.issue_number ?? null,
    implementation_session_name: reviewRecord.implementation_session_name ?? null,
    reviewer_session_name: reviewRecord.reviewer_session_name ?? null,
    target_branch: reviewRecord.target_branch ?? null,
    target_head_sha: reviewRecord.target_head_sha ?? null,
    status: reviewRecord.status,
    verdict: reviewRecord.verdict,
    freeze_status: reviewRecord.freeze_status,
    posture: posture.posture,
    freeze_active: posture.freeze_active,
  };
}

function resolveCurrentHeadSha(githubObservation, prNumber) {
  if (!Number.isInteger(Number(prNumber))) return null;
  return (githubObservation?.prs ?? []).find((pr) => pr?.pr_number === Number(prNumber))?.head_sha ?? null;
}

function resolveHolderIdentity({
  holderId = null,
  holderType = null,
} = {}) {
  const normalizedHolderId = typeof holderId === 'string' && holderId.trim() !== ''
    ? holderId.trim()
    : null;
  const sessionNameHolderId = typeof process.env.AO_SESSION_NAME === 'string' && process.env.AO_SESSION_NAME.trim() !== ''
    ? process.env.AO_SESSION_NAME.trim()
    : null;
  const sessionIdHolderId = typeof process.env.AO_SESSION_ID === 'string' && process.env.AO_SESSION_ID.trim() !== ''
    ? process.env.AO_SESSION_ID.trim()
    : null;
  const sessionHolderId = sessionNameHolderId ?? sessionIdHolderId;
  const resolvedHolderId = normalizedHolderId ?? sessionHolderId;

  if (resolvedHolderId == null) {
    throw new Error('Controller holder identity required when AO_SESSION_NAME/AO_SESSION_ID are unset. Pass an explicit holderId.');
  }

  return {
    holderId: resolvedHolderId,
    holderType: holderType
      ?? process.env.AO_CALLER_TYPE
      ?? (normalizedHolderId != null && sessionHolderId == null ? 'manual' : 'session'),
  };
}

function normalizeControllerMetadataValue(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

function canRecoverSameHolderLease(
  existingLease,
  {
    processId = process.pid,
    processStartedAt = null,
  } = {},
) {
  if (!existingLease || existingLease.status !== 'active') {
    return false;
  }
  const metadata = existingLease?.metadata ?? {};
  const priorProcessId = Number(metadata?.process_pid);
  if (!Number.isInteger(priorProcessId) || priorProcessId <= 0) {
    return false;
  }
  if (!matchesRecordedProcessIdentity(metadata)) {
    return true;
  }

  const recordedStartToken = normalizeControllerMetadataValue(metadata?.process_start_token);
  if (recordedStartToken != null) {
    return false;
  }

  const currentProcessId = Number(processId);
  const recordedProcessStartedAt = normalizeControllerMetadataValue(metadata?.process_started_at);
  const normalizedProcessStartedAt = normalizeControllerMetadataValue(processStartedAt);
  return Number.isInteger(currentProcessId)
    && currentProcessId > 0
    && priorProcessId === currentProcessId
    && recordedProcessStartedAt != null
    && normalizedProcessStartedAt != null
    && recordedProcessStartedAt !== normalizedProcessStartedAt;
}
function isControllerLeaseStale(lease, now) {
  if (!lease || lease.status !== 'active') return false;
  return new Date(lease.expires_at).getTime() <= new Date(now).getTime();
}

function isStopRequested(stopSignal) {
  return stopSignal?.aborted === true;
}

function ensureStopRequestedAt(stopSignal) {
  if (!stopSignal) return new Date().toISOString();
  if (typeof stopSignal.requested_at === 'string' && stopSignal.requested_at.trim() !== '') {
    return stopSignal.requested_at;
  }
  const timestamp = new Date().toISOString();
  stopSignal.requested_at = timestamp;
  return timestamp;
}

function isAbortSignalError(error, abortSignal) {
  return abortSignal?.aborted === true && (
    error === abortSignal.reason
      || error?.name === 'AbortError'
      || error?.code === 'ABORT_ERR'
      || error?.message === abortSignal.reason?.message
  );
}

function isControllerStopRequestedError(error) {
  return error?.code === 'controller_stop_requested';
}

function isControllerShutdownTimeoutError(error) {
  return error?.code === 'controller_shutdown_timeout';
}

function resolveHeartbeatIntervalMs(heartbeatIntervalMs, leaseTimeoutMs) {
  if (Number.isInteger(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    return heartbeatIntervalMs;
  }
  return Math.max(
    25,
    Math.min(DEFAULT_CONTROLLER_HEARTBEAT_INTERVAL_MS, Math.floor(leaseTimeoutMs / 3)),
  );
}

async function runStepWithShutdownBudget(
  stepName,
  execute,
  {
    stopSignal = null,
    shutdownTimeoutMs = DEFAULT_CONTROLLER_SHUTDOWN_TIMEOUT_MS,
  } = {},
) {
  const abortController = new AbortController();
  let settled = false;
  let timerId = null;
  let deadlineMs = null;

  const stopWatcher = new Promise((resolve, reject) => {
    function poll() {
      if (settled) {
        resolve();
        return;
      }
      if (!isStopRequested(stopSignal)) {
        timerId = setTimeout(poll, 5);
        return;
      }

      if (deadlineMs == null) {
        const requestedAtMs = new Date(ensureStopRequestedAt(stopSignal)).getTime();
        deadlineMs = requestedAtMs + shutdownTimeoutMs;
        abortController.abort(new ControllerStopRequestedError(stepName));
      }

      if (Date.now() >= deadlineMs) {
        reject(new ControllerShutdownTimeoutError(stepName));
        return;
      }

      timerId = setTimeout(poll, 5);
    }

    poll();
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => execute({
        abortSignal: abortController.signal,
      })),
      stopWatcher,
    ]);
  } catch (error) {
    if (isAbortSignalError(error, abortController.signal)) {
      throw abortController.signal.reason;
    }
    throw error;
  } finally {
    settled = true;
    if (timerId != null) {
      clearTimeout(timerId);
    }
  }
}

function buildActiveControllerLease({
  existingLease = null,
  leaseId,
  controllerId,
  holderId,
  holderType,
  incarnationId = null,
  metadata = null,
  now,
  runtimeKind,
  pollIntervalMs = null,
  shutdownTimeoutMs = null,
  leaseTimeoutMs = DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
  lastRunStartedAt = null,
  lastRunCompletedAt = null,
  lastRunStatus = 'running',
} = {}) {
  const timestamp = resolveNow(now);

  return createControllerLease({
    ...existingLease,
    lease_id: leaseId ?? existingLease?.lease_id ?? buildControllerLeaseId({
      controllerId,
      holderId,
      incarnationId,
    }),
    controller_id: controllerId ?? existingLease?.controller_id,
    holder_id: holderId ?? existingLease?.holder_id,
    holder_type: holderType ?? existingLease?.holder_type,
    incarnation_id: incarnationId ?? existingLease?.incarnation_id ?? null,
    status: 'active',
    acquired_at: existingLease?.acquired_at ?? timestamp,
    heartbeat_at: timestamp,
    expires_at: addMilliseconds(timestamp, leaseTimeoutMs ?? existingLease?.lease_timeout_ms ?? DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS),
    lease_timeout_ms: leaseTimeoutMs ?? existingLease?.lease_timeout_ms ?? DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
    runtime_kind: runtimeKind ?? existingLease?.runtime_kind ?? 'oneshot',
    poll_interval_ms: pollIntervalMs ?? existingLease?.poll_interval_ms ?? null,
    shutdown_timeout_ms: shutdownTimeoutMs ?? existingLease?.shutdown_timeout_ms ?? null,
    last_run_started_at: lastRunStartedAt ?? existingLease?.last_run_started_at ?? null,
    last_run_completed_at: lastRunCompletedAt ?? existingLease?.last_run_completed_at ?? null,
    last_run_status: lastRunStatus ?? existingLease?.last_run_status ?? null,
    released_at: null,
    release_reason: null,
    metadata: {
      ...(existingLease?.metadata ?? {}),
      ...(metadata ?? {}),
    },
  });
}

function buildReleasedControllerLease(existingLease, {
  now,
  reason,
  lastRunCompletedAt = null,
  lastRunStatus = null,
} = {}) {
  const timestamp = resolveNow(now);

  return createControllerLease({
    ...existingLease,
    status: 'released',
    released_at: timestamp,
    release_reason: reason ?? 'released',
    last_run_completed_at: lastRunCompletedAt ?? existingLease?.last_run_completed_at ?? timestamp,
    last_run_status: lastRunStatus ?? existingLease?.last_run_status ?? 'completed',
  });
}

function buildExpiredControllerLease(existingLease, {
  now,
  reason,
} = {}) {
  const timestamp = resolveNow(now);

  return createControllerLease({
    ...existingLease,
    status: 'expired',
    released_at: timestamp,
    release_reason: reason ?? 'expired',
  });
}

async function acquireControllerLeadership({
  repository,
  controllerId,
  now,
  runtimeKind,
  holderId = null,
  holderType = null,
  leaseIncarnationId,
  processId = process.pid,
  processStartedAt = CURRENT_PROCESS_COMPAT_STARTED_AT,
  pollIntervalMs = null,
  shutdownTimeoutMs = null,
  leaseTimeoutMs = DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
  lockTimeoutMs = 1000,
  lockRetryMs = 10,
  lastRunStartedAt = null,
  lastRunCompletedAt = null,
  lastRunStatus = 'running',
} = {}) {
  const timestamp = resolveNow(now);
  const resolvedHolder = resolveHolderIdentity({
    holderId,
    holderType,
  });
  const requestedLeaseId = buildControllerLeaseId({
    controllerId,
    holderId: resolvedHolder.holderId,
    incarnationId: leaseIncarnationId,
  });

  return repository.mutateControllerLeasesAtomically({
    entityId: requestedLeaseId,
    summary: `Persisted controller lease ${requestedLeaseId}.`,
    timeoutMs: lockTimeoutMs,
    retryMs: lockRetryMs,
    mutate: async ({
      findActiveLeaseForController,
      findControllerLeaseById,
      upsertControllerLease,
    }) => {
      const activeLease = findActiveLeaseForController(controllerId);
      let effectiveLeaseId = requestedLeaseId;
      let effectiveIncarnationId = leaseIncarnationId;

      if (activeLease && activeLease.lease_id !== requestedLeaseId) {
        if (
          activeLease.holder_id === resolvedHolder.holderId
          && canRecoverSameHolderLease(activeLease, {
            processId,
            processStartedAt,
          })
          && !isControllerLeaseStale(activeLease, timestamp)
        ) {
          effectiveLeaseId = activeLease.lease_id;
          effectiveIncarnationId = activeLease.incarnation_id ?? effectiveIncarnationId;
        } else if (!isControllerLeaseStale(activeLease, timestamp)) {
          throw new Error(
            `Controller ${controllerId} already has an active lease held by ${activeLease.holder_id}.`,
          );
        } else {
          upsertControllerLease(buildExpiredControllerLease(activeLease, {
            now: timestamp,
            reason: 'stale_leader_reclaimed',
          }));
        }
      }

      const existingLease = findControllerLeaseById(effectiveLeaseId);
      const lease = upsertControllerLease(buildActiveControllerLease({
        existingLease,
        leaseId: effectiveLeaseId,
        controllerId,
        holderId: resolvedHolder.holderId,
        holderType: resolvedHolder.holderType,
        incarnationId: effectiveIncarnationId,
        metadata: buildCurrentProcessMetadata({
          pid: processId,
          startedAt: processStartedAt,
        }),
        now: timestamp,
        runtimeKind,
        pollIntervalMs,
        shutdownTimeoutMs,
        leaseTimeoutMs,
        lastRunStartedAt,
        lastRunCompletedAt,
        lastRunStatus,
      }));

      return {
        value: lease,
        entityId: lease.lease_id,
        summary: `Persisted controller lease ${lease.lease_id}.`,
        details: lease,
      };
    },
  });
}

async function renewControllerLeadership({
  repository,
  leaseId,
  controllerId,
  holderId,
  holderType,
  leaseIncarnationId,
  processId = process.pid,
  processStartedAt = CURRENT_PROCESS_COMPAT_STARTED_AT,
  now,
  runtimeKind,
  pollIntervalMs = null,
  shutdownTimeoutMs = null,
  leaseTimeoutMs = DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
  lockTimeoutMs = 1000,
  lockRetryMs = 10,
  lastRunStartedAt = null,
  lastRunCompletedAt = null,
  lastRunStatus = 'running',
} = {}) {
  const timestamp = resolveNow(now);
  return repository.mutateControllerLeasesAtomically({
    entityId: leaseId,
    summary: `Persisted controller lease ${leaseId}.`,
    timeoutMs: lockTimeoutMs,
    retryMs: lockRetryMs,
    mutate: async ({
      findControllerLeaseById,
      upsertControllerLease,
    }) => {
      const existingLease = findControllerLeaseById(leaseId);
      if (!existingLease || existingLease.status !== 'active') {
        throw new Error(`Controller lease ${leaseId} is no longer active.`);
      }
      if (existingLease.incarnation_id !== leaseIncarnationId) {
        throw new Error(`Controller lease ${leaseId} is no longer held by incarnation ${leaseIncarnationId}.`);
      }

      const lease = upsertControllerLease(buildActiveControllerLease({
        existingLease,
        leaseId,
        controllerId,
        holderId,
        holderType,
        incarnationId: leaseIncarnationId,
        metadata: buildCurrentProcessMetadata({
          pid: processId,
          startedAt: processStartedAt,
        }),
        now: timestamp,
        runtimeKind,
        pollIntervalMs,
        shutdownTimeoutMs,
        leaseTimeoutMs,
        lastRunStartedAt,
        lastRunCompletedAt,
        lastRunStatus,
      }));

      return {
        value: lease,
        entityId: lease.lease_id,
        summary: `Persisted controller lease ${lease.lease_id}.`,
        details: lease,
      };
    },
  });
}

async function releaseControllerLeadership({
  repository,
  leaseId,
  leaseIncarnationId,
  now,
  reason,
  lockTimeoutMs = 1000,
  lockRetryMs = 10,
  lastRunCompletedAt = null,
  lastRunStatus = null,
} = {}) {
  const timestamp = resolveNow(now);
  return repository.mutateControllerLeasesAtomically({
    entityId: leaseId,
    summary: `Persisted controller lease ${leaseId}.`,
    timeoutMs: lockTimeoutMs,
    retryMs: lockRetryMs,
    mutate: async ({
      findControllerLeaseById,
      upsertControllerLease,
    }) => {
      const existingLease = findControllerLeaseById(leaseId);
      if (!existingLease || existingLease.status !== 'active') {
        return {
          value: existingLease ?? null,
          entityId: leaseId,
          summary: `Skipped controller lease release ${leaseId}.`,
          details: existingLease ?? {},
        };
      }
      if (existingLease.incarnation_id !== leaseIncarnationId) {
        return {
          value: existingLease,
          entityId: leaseId,
          summary: `Skipped controller lease release ${leaseId} for superseded incarnation.`,
          details: existingLease,
        };
      }

      const lease = upsertControllerLease(buildReleasedControllerLease(existingLease, {
        now: timestamp,
        reason,
        lastRunCompletedAt,
        lastRunStatus,
      }));

      return {
        value: lease,
        entityId: lease.lease_id,
        summary: `Persisted controller lease ${lease.lease_id}.`,
        details: lease,
      };
    },
  });
}

function startControllerHeartbeat({
  repository,
  controllerId,
  leaseId,
  holderId,
  holderType,
  leaseIncarnationId,
  processStartedAt = CURRENT_PROCESS_COMPAT_STARTED_AT,
  runtimeKind,
  pollIntervalMs = null,
  shutdownTimeoutMs = null,
  leaseTimeoutMs = DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
  heartbeatIntervalMs = null,
  lockTimeoutMs = 1000,
  lockRetryMs = 10,
  now,
} = {}) {
  const intervalMs = resolveHeartbeatIntervalMs(heartbeatIntervalMs, leaseTimeoutMs);
  let active = true;
  let timerId = null;
  let inflightPromise = null;
  let lastError = null;

  async function renewHeartbeat() {
    if (!active) return;
    inflightPromise = renewControllerLeadership({
      repository,
      leaseId,
      controllerId,
      holderId,
      holderType,
      leaseIncarnationId,
      processStartedAt,
      now,
      runtimeKind,
      pollIntervalMs,
      shutdownTimeoutMs,
      leaseTimeoutMs,
      lockTimeoutMs,
      lockRetryMs,
      lastRunStatus: 'running',
    }).catch((error) => {
      lastError = error;
      active = false;
      throw error;
    }).finally(() => {
      inflightPromise = null;
    });

    await inflightPromise;
  }

  function scheduleNextTick() {
    if (!active) return;
    timerId = setTimeout(async () => {
      try {
        await renewHeartbeat();
      } catch {
        // lastError is already captured by renewHeartbeat; keep the failure observable via getError().
      } finally {
        scheduleNextTick();
      }
    }, intervalMs);
  }

  scheduleNextTick();

  return {
    async stop() {
      active = false;
      if (timerId != null) {
        clearTimeout(timerId);
      }
      if (inflightPromise) {
        await inflightPromise;
      }
    },
    getError() {
      return lastError;
    },
  };
}

async function waitForNextPass({
  intervalMs,
  stopSignal = null,
} = {}) {
  const remaining = Number(intervalMs);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return;
  }

  let elapsedMs = 0;
  while (elapsedMs < remaining) {
    if (stopSignal?.aborted) return;
    const sleepMs = Math.min(remaining - elapsedMs, 100);
    await new Promise((resolve) => {
      setTimeout(resolve, sleepMs);
    });
    elapsedMs += sleepMs;
  }
}

function hashText(value) {
  return createHash('sha1').update(value).digest('hex');
}

function uniquePrNumbers(prBindings = [], matchedPrs = []) {
  return [...new Set([
    ...(prBindings ?? []).filter((binding) => binding.status === 'bound').map((binding) => binding.pr_number),
    ...(matchedPrs ?? []).map((pr) => pr.pr_number),
  ])].filter((value) => Number.isInteger(value)).sort((left, right) => left - right);
}

function buildGitHubScope(task, prBindings = []) {
  const prNumbers = uniquePrNumbers(prBindings, []);
  const selectionBasis = [];
  if (prNumbers.length) selectionBasis.push('managed_task_pr_binding');
  if (task.branch_name) selectionBasis.push('managed_task_branch');

  return createProjectScope({
    prNumbers,
    selectionBasis,
    notes: task.branch_name ? [`branch:${task.branch_name}`] : [],
  });
}

function resolveTaskRuntimePreflight(snapshot, task) {
  const taskSpec = snapshot.state.task_specs.find((record) => record.task_id === task.task_id) ?? null;
  const runtimeRef = taskSpec?.snapshot?.spec?.runtime_ref ?? null;
  const runtimePreflight = runtimeRef == null
    ? null
    : (snapshot.state.runtime_preflights.find((record) => record.runtime_ref === runtimeRef) ?? null);
  return {
    taskSpec,
    runtimeRef,
    runtimePreflight,
  };
}

function resolveLifecyclePrNumber(prBindings = [], matchedPrs = []) {
  const prNumbers = uniquePrNumbers(prBindings, matchedPrs);
  return prNumbers.length === 1 ? prNumbers[0] : null;
}

function compareDeliveryEventOrder(left, right) {
  const leftObservedAt = String(left?.observed_at ?? '');
  const rightObservedAt = String(right?.observed_at ?? '');
  if (leftObservedAt !== rightObservedAt) {
    return leftObservedAt.localeCompare(rightObservedAt);
  }
  return String(left?.event_id ?? '').localeCompare(String(right?.event_id ?? ''));
}

function isDeliveryEventCurrentForPr(event, pr) {
  if (!pr || event?.pr_number !== pr.pr_number) return false;

  const payload = event.payload ?? {};
  const currentHeadSha = pr.head_sha ?? null;
  const eventHeadSha = event.event_family === 'review_comment'
    ? (payload.commit_oid ?? payload.head_sha ?? null)
    : (payload.head_sha ?? null);

  if (!currentHeadSha || !eventHeadSha) return true;
  return eventHeadSha === currentHeadSha;
}

function selectCurrentDeliveryEvents({
  matchedPrs = [],
  deliveryEvents = [],
} = {}) {
  const latestByFamily = new Map();

  for (const pr of matchedPrs ?? []) {
    const prEvents = (deliveryEvents ?? [])
      .filter((event) => isDeliveryEventCurrentForPr(event, pr))
      .sort(compareDeliveryEventOrder);
    const latestReviewCommentEvent = prEvents
      .filter((event) => event.event_family === 'review_comment')
      .at(-1) ?? null;

    for (const family of ['pr', 'check', 'review']) {
      const latestEvent = prEvents.filter((event) => event.event_family === family).at(-1) ?? null;
      if (!latestEvent) continue;
      latestByFamily.set(`${pr.pr_number}:${family}`, latestEvent);
    }

    if (latestReviewCommentEvent) {
      latestByFamily.set(`${pr.pr_number}:review_comment`, latestReviewCommentEvent);
    }
  }

  return [...latestByFamily.values()].sort(compareDeliveryEventOrder);
}

export function deriveLifecycleTriggerForTask({
  matchedAoWorkers = [],
  matchedPrs = [],
  deliveryEvents = [],
} = {}) {
  if (
    matchedAoWorkers.length === 0
    || matchedAoWorkers.some((worker) => worker.freshness?.status === 'stale')
  ) {
    return 'agent_exited';
  }

  const activeDeliveryTriggers = new Set(selectCurrentDeliveryEvents({
    matchedPrs,
    deliveryEvents,
  })
    .map((event) => event.lifecycle_trigger)
    .filter((trigger) => typeof trigger === 'string' && trigger !== '' && trigger !== 'manual'));

  for (const trigger of LIFECYCLE_DELIVERY_TRIGGER_PRIORITY) {
    if (activeDeliveryTriggers.has(trigger)) {
      return trigger;
    }
  }

  if (matchedPrs.some((pr) => pr.review_status === 'changes_requested')) {
    return 'changes_requested';
  }

  if (matchedPrs.some((pr) => pr.ci_status === 'failing')) {
    return 'ci_failed';
  }

  if (matchedPrs.some((pr) => pr.mergeability === 'conflicting')) {
    return 'merge_conflicts';
  }

  if (matchedPrs.some((pr) => (
    pr.review_status === 'approved'
      && pr.ci_status === 'passing'
      && pr.mergeability === 'mergeable'
      && pr.is_draft === false
  ))) {
    return 'approved_and_green';
  }

  return 'manual';
}

async function persistShadowActions({
  repository,
  task,
  controllerId,
  mode = 'shadow',
  derivedTrigger,
  lifecycleReport,
  prNumber,
  now,
} = {}) {
  const snapshot = repository.getSnapshot().state;
  const knownActionIds = new Set(snapshot.actions.map((record) => record.action_id));
  const knownPolicyDecisionIds = new Set(snapshot.policy_decisions.map((record) => record.decision_id));
  const actionIds = [];
  const policyDecisionIds = [];
  const blockedActionIds = [];
  const deniedActionIds = [];
  const downgradedActionIds = [];
  const requestedBy = mode === 'assist' ? 'assist_controller' : 'shadow_controller';
  const credentialProvenances = snapshot.credential_provenances ?? [];
  const { runtimeRef, runtimePreflight } = resolveTaskRuntimePreflight({ state: snapshot }, task);

  for (const action of lifecycleReport.actions) {
    const actionModel = buildAssistActionModel({
      controllerId,
      task,
      prNumber,
      derivedTrigger,
      lifecycleTopStatus: lifecycleReport.top_status ?? null,
      runtimeRef,
      runtimePreflight,
      action,
    });
    const policyInput = buildPolicyInputForAction({
      task,
      prNumber,
      action,
    });
    const policyResult = evaluatePolicyDecision({
      input: policyInput,
      credentialProvenances,
    });
    const policyFingerprint = hashText(JSON.stringify({
      policy_version: policyResult.policy_version,
      input: policyResult.input,
      decision: policyResult.decision,
      findings: policyResult.findings,
    }));
    const policyDecisionId = `policy-${task.task_id}-${action.id}-${policyFingerprint.slice(0, 12)}`;
    const actionFingerprint = hashText(JSON.stringify({
      controllerId,
      derivedTrigger,
      prNumber,
      top_status: lifecycleReport.top_status,
      routing_decision: lifecycleReport.routing_decision,
      release_decision: lifecycleReport.release_decision,
      action: {
        id: action.id,
        action_class: action.action_class,
        commands: action.commands,
        rationale: action.rationale,
        policy_inputs: policyResult.input,
      },
      policy_decision: policyResult.decision,
      policy_fingerprint: policyFingerprint,
    }));
    const actionId = `proposal-${task.task_id}-${action.id}-${actionFingerprint.slice(0, 12)}`;
    const actionStatus = policyResult.decision === 'allow' ? 'proposed' : 'blocked';

    actionIds.push(actionId);
    policyDecisionIds.push(policyDecisionId);
    if (policyResult.decision !== 'allow') {
      blockedActionIds.push(actionId);
      if (policyResult.decision === 'deny') {
        deniedActionIds.push(actionId);
      } else if (policyResult.decision === 'downgrade') {
        downgradedActionIds.push(actionId);
      }
    }

    if (!knownPolicyDecisionIds.has(policyDecisionId)) {
      repository.upsertPolicyDecision(createPolicyDecisionRecord({
        decision_id: policyDecisionId,
        task_id: task.task_id,
        action_id: actionId,
        action_kind: action.id,
        subject_kind: 'action',
        decision: policyResult.decision,
        policy_version: policyResult.policy_version,
        input_fingerprint: policyFingerprint,
        recorded_at: now,
        summary: policyResult.summary,
        findings: policyResult.findings,
        input: policyResult.input,
        result: policyResult,
      }));
      knownPolicyDecisionIds.add(policyDecisionId);
    }

    if (knownActionIds.has(actionId)) {
      continue;
    }
    knownActionIds.add(actionId);

    repository.upsertAction(createActionRecord({
      action_id: actionId,
      task_id: task.task_id,
      action_kind: action.id,
      status: actionStatus,
      requested_by: requestedBy,
      reason: action.summary,
      created_at: now,
      updated_at: now,
      payload: {
        controller_id: controllerId,
        derived_trigger: derivedTrigger,
        fingerprint: actionFingerprint,
        pr_number: prNumber,
        top_status: lifecycleReport.top_status,
        routing_decision: lifecycleReport.routing_decision,
        release_decision: lifecycleReport.release_decision,
        action_class: action.action_class,
        commands: action.commands,
        rationale: action.rationale,
        action_model: actionModel,
        runtime_preflight: actionModel.runtime_preflight,
        policy_decision_id: policyDecisionId,
        policy: {
          decision: policyResult.decision,
          policy_version: policyResult.policy_version,
          summary: policyResult.summary,
          findings: policyResult.findings,
          input: policyResult.input,
        },
      },
    }));
    repository.appendAuditEntry({
      entityKind: 'action',
      entityId: actionId,
      operation: policyResult.decision === 'allow' ? 'proposed' : 'policy_blocked',
      actor: requestedBy,
      summary: policyResult.decision === 'allow'
        ? `Recorded proposed action ${actionId}.`
        : `Policy blocked action ${actionId}.`,
      details: {
        action_id: actionId,
        action_kind: action.id,
        task_id: task.task_id,
        controller_id: controllerId,
        pr_number: prNumber,
        risk_class: actionModel.risk_class,
        policy_decision: policyResult.decision,
        policy_decision_id: policyDecisionId,
      },
      recordedAt: now,
    });
  }

  return {
    count: actionIds.length,
    actionIds,
    policyDecisionIds,
    policyDecisionCount: policyDecisionIds.length,
    policyBlockedActionIds: blockedActionIds,
    policyBlockedActionCount: blockedActionIds.length,
    deniedActionIds,
    deniedActionCount: deniedActionIds.length,
    downgradedActionIds,
    downgradedActionCount: downgradedActionIds.length,
  };
}

async function resolveLifecycleReportForTask({
  task,
  prNumber,
  derivedTrigger,
  aoObservation,
  githubObservation,
  cwd,
  projectId,
  deps,
} = {}) {
  const reconciliationScope = prNumber != null
    ? createPrScope(prNumber)
    : createProjectScope({
        prNumbers: [],
        selectionBasis: task.branch_name ? ['managed_task_branch'] : [],
        notes: task.branch_name ? [`branch:${task.branch_name}`] : [],
      });
  const reconciliationReport = deps.reconcileObservations({
    scope: reconciliationScope,
    aoObservation,
    githubObservation,
  });
  const localState = await deps.loadDoctorLocalState({
    cwd,
  });
  const doctorReport = deps.buildDoctorReport({
    scope: prNumber != null
      ? createDoctorPrScope({ projectId, prNumber })
      : createDoctorProjectScope({ projectId }),
    reconciliationReport,
    localState,
    controlPlaneSnapshot: deps.controlPlaneSnapshot ?? null,
  });
  const reviewInspection = buildTaskReviewInspection(deps.controlPlaneSnapshot ?? null, task.task_id);
  const reviewRequired = reviewInspection != null;
  const lifecycleReport = deps.buildLifecycleReport({
        scope: prNumber != null
          ? createLifecyclePrScope({ projectId, prNumber, trigger: derivedTrigger })
          : createLifecycleProjectScope({ projectId, trigger: derivedTrigger }),
        reconciliationReport,
        doctorReport,
        reviewRequired,
        reviewInspection,
        currentHeadSha: resolveCurrentHeadSha(githubObservation, prNumber),
  });
  const decisionChain = buildDecisionChainReport({
    scope: lifecycleReport.scope,
    reconciliationReport,
    doctorReport,
    lifecycleReport,
  });

  return {
    lifecycleReport: {
      ...lifecycleReport,
      decision_chain: decisionChain,
    },
    reconciliationReport,
    doctorReport,
    decisionChain,
  };
}

function resolveLoopMode(repository, controllerId, mode) {
  if (mode != null) {
    if (!CONTROLLER_MUTATION_MODES.includes(mode)) {
      throw new Error(`Unsupported controller mode: ${mode}`);
    }
    return mode;
  }

  const snapshot = repository.getSnapshot();
  const currentMode = snapshot.state.controller_modes.find((record) => record.controller_id === controllerId)?.mode ?? 'off';
  if (!CONTROLLER_MUTATION_MODES.includes(currentMode)) {
    throw new Error(`Controller ${controllerId} must be set to observe, shadow, or assist`);
  }

  return currentMode;
}

function persistModeOverride(repository, controllerId, mode, now) {
  if (mode == null) return;
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: controllerId,
    mode,
    updated_at: now,
    updated_by: 'ao_controller',
    reason: 'Controller loop mode override.',
  }));
}

async function executeControllerPass({
  repository,
  checkpointStore,
  services,
  cwd,
  projectId,
  controllerId,
  issueNumber,
  resolvedMode,
  timestamp,
  stopSignal = null,
  shutdownTimeoutMs = DEFAULT_CONTROLLER_SHUTDOWN_TIMEOUT_MS,
} = {}) {
  await runStepWithShutdownBudget('ensure_runtime_preflights', ({ abortSignal }) => services.ensureRuntimePreflights({
    repository,
    cwd,
    now: timestamp,
    abortSignal,
  }), {
    stopSignal,
    shutdownTimeoutMs,
  });

  const aoObservation = await runStepWithShutdownBudget('load_ao_project_observation', ({ abortSignal }) => services.loadAoProjectObservation({
    projectId,
    now: timestamp,
    abortSignal,
  }), {
    stopSignal,
    shutdownTimeoutMs,
  });
  const snapshot = repository.getSnapshot();
  const activeTasks = snapshot.state.managed_tasks.filter((task) => (
    task.status === 'active'
      && (issueNumber == null || task.issue_number === Number(issueNumber))
  ));
  const taskResults = [];
  let ingestedObservationCount = 0;
  let deliveryEventCount = 0;
  let proposedActionCount = 0;
  let executedActionCount = 0;
  let blockedActionCount = 0;
  let policyDecisionCount = 0;
  let policyBlockedActionCount = 0;
  let deniedActionCount = 0;
  let downgradedActionCount = 0;

  for (const task of activeTasks) {
    const currentSnapshot = repository.getSnapshot();
    const prBindings = currentSnapshot.state.pr_bindings.filter((binding) => binding.task_id === task.task_id);
    const githubObservation = await runStepWithShutdownBudget('load_github_observation', ({ abortSignal }) => services.loadGitHubObservationSet({
      scope: buildGitHubScope(task, prBindings),
      now: timestamp,
      abortSignal,
    }), {
      stopSignal,
      shutdownTimeoutMs,
    });
    const ingestResult = ingestManagedTaskPollEvents({
      repository,
      controllerId,
      task,
      prBindings,
      aoObservation,
      githubObservation,
      now: timestamp,
    });
    ingestedObservationCount += ingestResult.ingested_count;
    deliveryEventCount += ingestResult.delivery_event_count ?? 0;
    const derivedTrigger = deriveLifecycleTriggerForTask({
      matchedAoWorkers: ingestResult.matchedAoWorkers,
      matchedPrs: ingestResult.matchedPrs,
      deliveryEvents: ingestResult.deliveryEvents,
    });
    const prNumber = resolveLifecyclePrNumber(prBindings, ingestResult.matchedPrs);

    let lifecycleTopStatus = null;
    let proposedActionIds = [];
    let executedActionIds = [];
    let blockedActionIds = [];
    let policyDecisionIds = [];
    let policyBlockedActionIds = [];
    let deniedActionIds = [];
    let downgradedActionIds = [];
    let lifecycleReport = null;
    let decisionChain = null;
    let routingDecision = null;
    let releaseDecision = null;
    let continuity = null;

    if (resolvedMode === 'shadow' || resolvedMode === 'assist') {
      const resolvedLifecycle = await runStepWithShutdownBudget('resolve_lifecycle_report', ({ abortSignal }) => (
        services.resolveLifecycleReport
          ? services.resolveLifecycleReport({
              task,
              prNumber,
              derivedTrigger,
              aoObservation,
              githubObservation,
              cwd,
              projectId,
              abortSignal,
            })
          : resolveLifecycleReportForTask({
              task,
              prNumber,
              derivedTrigger,
              aoObservation,
              githubObservation,
              cwd,
              projectId,
              deps: {
                ...services,
                abortSignal,
                controlPlaneSnapshot: repository.getSnapshot(),
              },
          })
      ), {
        stopSignal,
        shutdownTimeoutMs,
      });
      const controlPlaneSnapshot = repository.getSnapshot();
      const reviewInspection = buildTaskReviewInspection(controlPlaneSnapshot, task.task_id);
      const reviewRequired = reviewInspection != null;
      const originalLifecycleReport = resolvedLifecycle.lifecycleReport ?? resolvedLifecycle;
      lifecycleReport = applyReviewGateToLifecycleReport({
        lifecycleReport: originalLifecycleReport,
        reviewRequired,
        reviewInspection,
        currentHeadSha: resolveCurrentHeadSha(githubObservation, prNumber),
      });
      decisionChain = lifecycleReport === originalLifecycleReport
        ? (resolvedLifecycle.decisionChain
          ?? lifecycleReport.decision_chain
          ?? buildDecisionChainReport({
            scope: prNumber != null
              ? createLifecyclePrScope({ projectId, prNumber, trigger: derivedTrigger })
              : createLifecycleProjectScope({ projectId, trigger: derivedTrigger }),
            reconciliationReport: resolvedLifecycle.reconciliationReport ?? null,
            doctorReport: resolvedLifecycle.doctorReport ?? null,
            lifecycleReport,
          }))
        : buildDecisionChainReport({
          scope: prNumber != null
            ? createLifecyclePrScope({ projectId, prNumber, trigger: derivedTrigger })
            : createLifecycleProjectScope({ projectId, trigger: derivedTrigger }),
          reconciliationReport: resolvedLifecycle.reconciliationReport ?? null,
          doctorReport: resolvedLifecycle.doctorReport ?? null,
          lifecycleReport,
        });
      routingDecision = lifecycleReport.routing_decision ?? null;
      releaseDecision = lifecycleReport.release_decision ?? null;
      lifecycleTopStatus = lifecycleReport.top_status ?? null;
      continuity = buildTaskContinuityFromSnapshot({
        snapshot: repository.getSnapshot(),
        taskId: task.task_id,
        lifecycleReport,
        reconciliationReport: resolvedLifecycle.reconciliationReport ?? null,
      });
      const proposalResult = await persistShadowActions({
        repository,
        task,
        controllerId,
        mode: resolvedMode,
        derivedTrigger,
        lifecycleReport,
        prNumber,
        now: timestamp,
      });
      proposedActionIds = proposalResult.actionIds;
      proposedActionCount += proposalResult.count;
      policyDecisionIds = proposalResult.policyDecisionIds;
      policyDecisionCount += proposalResult.policyDecisionCount;
      policyBlockedActionIds = proposalResult.policyBlockedActionIds;
      policyBlockedActionCount += proposalResult.policyBlockedActionCount;
      deniedActionIds = proposalResult.deniedActionIds;
      deniedActionCount += proposalResult.deniedActionCount;
      downgradedActionIds = proposalResult.downgradedActionIds;
      downgradedActionCount += proposalResult.downgradedActionCount;

      if (resolvedMode === 'assist') {
        const executionResult = await runStepWithShutdownBudget('execute_assist_actions', ({ abortSignal }) => executeAssistActions({
          repository,
          controllerId,
          task,
          actionIds: proposalResult.actionIds,
          now: timestamp,
          abortSignal,
        }), {
          stopSignal,
          shutdownTimeoutMs,
        });
        executedActionIds = executionResult.executedActionIds;
        blockedActionIds = executionResult.blockedActionIds;
        executedActionCount += executedActionIds.length;
        blockedActionCount += blockedActionIds.length;
      }
    }

    try {
      checkpointStore.captureCheckpoint({
        taskId: task.task_id,
        controllerId,
        derivedTrigger,
        lifecycleTopStatus,
        observedAt: timestamp,
        actionIds: [...proposedActionIds, ...executedActionIds],
        reason: 'controller_loop_checkpoint',
        createdBy: 'ao_controller',
      });
    } catch (error) {
      repository.appendAuditEntry({
        entityKind: 'checkpoint',
        entityId: task.task_id,
        operation: 'skip',
        actor: 'ao_controller',
        summary: `Skipped checkpoint for ${task.task_id}.`,
        details: {
          error: error.message,
        },
        recordedAt: timestamp,
      });
    }

    const actionRecords = [...new Set(proposedActionIds)]
      .map((actionId) => repository.getSnapshot().state.actions.find((record) => record.action_id === actionId) ?? null)
      .filter(Boolean);
    const assistActions = actionRecords
      .map((record) => summarizeAssistActionRecord(record))
      .filter(Boolean);
    repository.upsertControllerRunMetric(buildControllerRunMetric({
      task,
      controllerId,
      controllerMode: resolvedMode,
      triggerKind: derivedTrigger,
      lifecycleTopStatus,
      startedAt: timestamp,
      completedAt: timestamp,
      observationCount: ingestResult.ingested_count,
      deliveryEventCount: ingestResult.delivery_event_count ?? 0,
      proposedActionCount: proposedActionIds.length,
      executedActionCount: executedActionIds.length,
      blockedActionCount: blockedActionIds.length,
      policyDecisionCount: policyDecisionIds.length,
      policyBlockedActionCount: policyBlockedActionIds.length,
      deniedActionCount: deniedActionIds.length,
      downgradedActionCount: downgradedActionIds.length,
      actionRecords,
      prNumber,
    }));

    taskResults.push({
      task_id: task.task_id,
      issue_number: task.issue_number,
      derived_trigger: derivedTrigger,
      new_observation_count: ingestResult.ingested_count,
      new_delivery_event_count: ingestResult.delivery_event_count ?? 0,
      proposed_action_count: proposedActionIds.length,
      proposed_action_ids: proposedActionIds,
      executed_action_count: executedActionIds.length,
      executed_action_ids: executedActionIds,
      blocked_action_count: blockedActionIds.length,
      blocked_action_ids: blockedActionIds,
      policy_decision_count: policyDecisionIds.length,
      policy_decision_ids: policyDecisionIds,
      policy_blocked_action_count: policyBlockedActionIds.length,
      policy_blocked_action_ids: policyBlockedActionIds,
      denied_action_count: deniedActionIds.length,
      denied_action_ids: deniedActionIds,
      downgraded_action_count: downgradedActionIds.length,
      downgraded_action_ids: downgradedActionIds,
      lifecycle_top_status: lifecycleTopStatus,
      continuity,
      decision_chain: decisionChain,
      routing_decision: routingDecision,
      release_decision: releaseDecision,
      key_findings: decisionChain?.key_findings ?? [],
      blocking_reasons: decisionChain?.blocking_reasons ?? [],
      next_actions: decisionChain?.next_actions ?? [],
      next_commands: decisionChain?.next_commands ?? [],
      assist_actions: assistActions,
    });
  }

  return {
    observed_at: timestamp,
    managed_task_count: activeTasks.length,
    processed_task_count: taskResults.length,
    ingested_observation_count: ingestedObservationCount,
    delivery_event_count: deliveryEventCount,
    proposed_action_count: proposedActionCount,
    executed_action_count: executedActionCount,
    blocked_action_count: blockedActionCount,
    policy_decision_count: policyDecisionCount,
    policy_blocked_action_count: policyBlockedActionCount,
    denied_action_count: deniedActionCount,
    downgraded_action_count: downgradedActionCount,
    task_results: taskResults,
  };
}

export async function runControllerLoop({
  repoRoot,
  cwd = repoRoot,
  projectId = DEFAULT_PROJECT_ID,
  controllerId = CONTROL_PLANE_DEFAULT_CONTROLLER_ID,
  holderId = null,
  holderType = null,
  mode = null,
  issueNumber = null,
  now = () => new Date().toISOString(),
  continuous = false,
  pollIntervalMs = DEFAULT_CONTROLLER_POLL_INTERVAL_MS,
  shutdownTimeoutMs = DEFAULT_CONTROLLER_SHUTDOWN_TIMEOUT_MS,
  leaseTimeoutMs = DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
  heartbeatIntervalMs = null,
  leaseIncarnationId = randomUUID(),
  controllerLeaseLockTimeoutMs = 1000,
  controllerLeaseLockRetryMs = 10,
  maxPasses = null,
  stopSignal = null,
  deps = {},
} = {}) {
  const services = {
    loadAoProjectObservation,
    loadGitHubObservationSet,
    loadDoctorLocalState,
    reconcileObservations: reconcileObservationModels,
    buildDoctorReport: buildDoctorReportModel,
    buildLifecycleReport: buildLifecycleReportModel,
    resolveLifecycleReport: null,
    ensureRuntimePreflights: ({ repository: activeRepository, cwd: activeCwd, now: activeNow }) => activeRepository.ensureRuntimePreflights({
      cwd: activeCwd,
      now: activeNow,
    }),
    wait: ({ intervalMs, stopSignal: activeStopSignal }) => waitForNextPass({
      intervalMs,
      stopSignal: activeStopSignal,
    }),
    shouldContinue: ({ stopSignal: activeStopSignal }) => activeStopSignal?.aborted !== true,
    ...deps,
  };

  const repository = createStateRepository({
    repoRoot,
    projectId,
  });
  let activeTimestamp = resolveNow(now);
  const checkpointStore = createCheckpointStore({
    repository,
    now: () => activeTimestamp,
  });
  const resolvedMode = resolveLoopMode(repository, controllerId, mode);
  const runtimeKind = continuous ? 'continuous' : 'oneshot';

  const aggregate = {
    observed_at: activeTimestamp,
    managed_task_count: 0,
    processed_task_count: 0,
    ingested_observation_count: 0,
    delivery_event_count: 0,
    proposed_action_count: 0,
    executed_action_count: 0,
    blocked_action_count: 0,
    policy_decision_count: 0,
    policy_blocked_action_count: 0,
    denied_action_count: 0,
    downgraded_action_count: 0,
    task_results: [],
  };
  let passCount = 0;
  let stopReason = 'completed';
  let currentLeaseId = null;
  let currentHolder = null;
  let currentLeaseStatus = 'completed';
  let currentLeaseIncarnationId = typeof leaseIncarnationId === 'string' && leaseIncarnationId.trim() !== ''
    ? leaseIncarnationId.trim()
    : randomUUID();
  const controllerProcessStartedAt = CURRENT_PROCESS_COMPAT_STARTED_AT;

  try {
    if (isStopRequested(stopSignal)) {
      stopReason = 'stop_requested';
    }

    while (true) {
      if (stopReason !== 'completed' && passCount === 0) {
        break;
      }
      activeTimestamp = passCount === 0 ? activeTimestamp : resolveNow(now);
      const activeLease = await acquireControllerLeadership({
        repository,
        controllerId,
        now: activeTimestamp,
        runtimeKind,
        holderId,
        holderType,
        leaseIncarnationId: currentLeaseIncarnationId,
        processStartedAt: controllerProcessStartedAt,
        pollIntervalMs: continuous ? pollIntervalMs : null,
        shutdownTimeoutMs: continuous ? shutdownTimeoutMs : null,
        leaseTimeoutMs,
        lockTimeoutMs: controllerLeaseLockTimeoutMs,
        lockRetryMs: controllerLeaseLockRetryMs,
        lastRunStartedAt: activeTimestamp,
        lastRunStatus: 'running',
      });
      currentLeaseId = activeLease.lease_id;
      currentLeaseIncarnationId = activeLease.incarnation_id ?? currentLeaseIncarnationId;
      currentHolder = {
        holderId: activeLease.holder_id,
        holderType: activeLease.holder_type,
      };
      currentLeaseStatus = 'running';
      persistModeOverride(repository, controllerId, mode, activeTimestamp);
      const heartbeat = startControllerHeartbeat({
        repository,
        controllerId,
        leaseId: currentLeaseId,
        holderId: currentHolder.holderId,
        holderType: currentHolder.holderType,
        leaseIncarnationId: currentLeaseIncarnationId,
        processStartedAt: controllerProcessStartedAt,
        runtimeKind,
        pollIntervalMs: continuous ? pollIntervalMs : null,
        shutdownTimeoutMs: continuous ? shutdownTimeoutMs : null,
        leaseTimeoutMs,
        heartbeatIntervalMs,
        lockTimeoutMs: controllerLeaseLockTimeoutMs,
        lockRetryMs: controllerLeaseLockRetryMs,
        now,
      });

      try {
        const passResult = await executeControllerPass({
          repository,
          checkpointStore,
          services,
          cwd,
          projectId,
          controllerId,
          issueNumber,
          resolvedMode,
          timestamp: activeTimestamp,
          stopSignal,
          shutdownTimeoutMs,
        });
        const completedAt = resolveNow(now);
        passCount += 1;
        aggregate.observed_at = completedAt;
        aggregate.managed_task_count = passResult.managed_task_count;
        aggregate.processed_task_count += passResult.processed_task_count;
        aggregate.ingested_observation_count += passResult.ingested_observation_count;
        aggregate.delivery_event_count += passResult.delivery_event_count;
        aggregate.proposed_action_count += passResult.proposed_action_count;
        aggregate.executed_action_count += passResult.executed_action_count;
        aggregate.blocked_action_count += passResult.blocked_action_count;
        aggregate.policy_decision_count += passResult.policy_decision_count;
        aggregate.policy_blocked_action_count += passResult.policy_blocked_action_count;
        aggregate.denied_action_count += passResult.denied_action_count;
        aggregate.downgraded_action_count += passResult.downgraded_action_count;
        aggregate.task_results.push(...passResult.task_results);

        await renewControllerLeadership({
          repository,
          leaseId: currentLeaseId,
          controllerId,
          holderId: currentHolder.holderId,
          holderType: currentHolder.holderType,
          leaseIncarnationId: currentLeaseIncarnationId,
          processStartedAt: controllerProcessStartedAt,
          now: completedAt,
          runtimeKind,
          pollIntervalMs: continuous ? pollIntervalMs : null,
          shutdownTimeoutMs: continuous ? shutdownTimeoutMs : null,
          leaseTimeoutMs,
          lockTimeoutMs: controllerLeaseLockTimeoutMs,
          lockRetryMs: controllerLeaseLockRetryMs,
          lastRunStartedAt: activeTimestamp,
          lastRunCompletedAt: completedAt,
          lastRunStatus: 'completed',
        });
        currentLeaseStatus = 'completed';
      } catch (error) {
        const heartbeatError = heartbeat.getError();
        if (heartbeatError) {
          throw heartbeatError;
        }
        if (isControllerShutdownTimeoutError(error)) {
          stopReason = 'shutdown_timeout';
          currentLeaseStatus = 'stopping';
          break;
        }
        if (isControllerStopRequestedError(error)) {
          stopReason = 'stop_requested';
          currentLeaseStatus = 'stopping';
          break;
        }
        currentLeaseStatus = 'failed';
        throw error;
      } finally {
        await heartbeat.stop();
      }

      if (!continuous) {
        break;
      }
      if (Number.isInteger(maxPasses) && passCount >= maxPasses) {
        stopReason = 'max_passes';
        break;
      }
      if (!services.shouldContinue({ stopSignal })) {
        stopReason = 'stop_requested';
        break;
      }
      await services.wait({
        intervalMs: pollIntervalMs,
        stopSignal,
      });
      if (!services.shouldContinue({ stopSignal })) {
        stopReason = 'stop_requested';
        break;
      }
    }
  } catch (error) {
    if (currentLeaseId) {
      currentLeaseStatus = 'failed';
      await renewControllerLeadership({
        repository,
        leaseId: currentLeaseId,
        controllerId,
        holderId: currentHolder?.holderId,
        holderType: currentHolder?.holderType,
        leaseIncarnationId: currentLeaseIncarnationId,
        processStartedAt: controllerProcessStartedAt,
        now: resolveNow(now),
        runtimeKind,
        pollIntervalMs: continuous ? pollIntervalMs : null,
        shutdownTimeoutMs: continuous ? shutdownTimeoutMs : null,
        leaseTimeoutMs,
        lockTimeoutMs: controllerLeaseLockTimeoutMs,
        lockRetryMs: controllerLeaseLockRetryMs,
        lastRunStatus: 'failed',
      }).catch(() => null);
    }
    throw error;
  } finally {
    if (currentLeaseId) {
      await releaseControllerLeadership({
        repository,
        leaseId: currentLeaseId,
        leaseIncarnationId: currentLeaseIncarnationId,
        now: resolveNow(now),
        reason: continuous ? `controller_runtime_${stopReason}` : 'controller_loop_complete',
        lockTimeoutMs: controllerLeaseLockTimeoutMs,
        lockRetryMs: controllerLeaseLockRetryMs,
        lastRunStatus: currentLeaseStatus,
      }).catch(() => null);
    }
  }

  return {
    project_id: projectId,
    controller_id: controllerId,
    mode: resolvedMode,
    observed_at: aggregate.observed_at,
    runtime_kind: runtimeKind,
    stop_reason: stopReason,
    pass_count: passCount,
    managed_task_count: aggregate.managed_task_count,
    processed_task_count: aggregate.processed_task_count,
    ingested_observation_count: aggregate.ingested_observation_count,
    delivery_event_count: aggregate.delivery_event_count,
    proposed_action_count: aggregate.proposed_action_count,
    executed_action_count: aggregate.executed_action_count,
    blocked_action_count: aggregate.blocked_action_count,
    policy_decision_count: aggregate.policy_decision_count,
    policy_blocked_action_count: aggregate.policy_blocked_action_count,
    denied_action_count: aggregate.denied_action_count,
    downgraded_action_count: aggregate.downgraded_action_count,
    task_results: aggregate.task_results,
  };
}
