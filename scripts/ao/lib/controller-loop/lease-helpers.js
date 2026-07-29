import { createControllerLease } from '../state-contracts.js';
import {
  buildControllerLeaseId,
} from '../transition-engine.js';
import {
  matchesRecordedProcessIdentity,
} from '../state-storage.js';
import {
  DEFAULT_CONTROLLER_HEARTBEAT_INTERVAL_MS,
  DEFAULT_CONTROLLER_LEASE_TIMEOUT_MS,
} from './constants.js';
import {
  addMilliseconds,
  resolveNow,
} from './time.js';

export const CURRENT_PROCESS_COMPAT_STARTED_AT = new Date().toISOString();

export function resolveHolderIdentity({
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

export function normalizeControllerMetadataValue(value) {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : null;
}

export function canRecoverSameHolderLease(
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

export function isControllerLeaseStale(lease, now) {
  if (!lease || lease.status !== 'active') return false;
  return new Date(lease.expires_at).getTime() <= new Date(now).getTime();
}

export function resolveHeartbeatIntervalMs(heartbeatIntervalMs, leaseTimeoutMs) {
  if (Number.isInteger(heartbeatIntervalMs) && heartbeatIntervalMs > 0) {
    return heartbeatIntervalMs;
  }
  return Math.max(
    25,
    Math.min(DEFAULT_CONTROLLER_HEARTBEAT_INTERVAL_MS, Math.floor(leaseTimeoutMs / 3)),
  );
}

export function buildActiveControllerLease({
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

export function buildReleasedControllerLease(existingLease, {
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

export function buildExpiredControllerLease(existingLease, {
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
