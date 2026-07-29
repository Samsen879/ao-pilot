import {
  DEFAULT_CONTROLLER_SHUTDOWN_TIMEOUT_MS,
} from './constants.js';

const stopRequestedAtMap = new WeakMap();

function canStoreStopSignalExternally(stopSignal) {
  return (typeof stopSignal === 'object' && stopSignal !== null) || typeof stopSignal === 'function';
}

export class ControllerStopRequestedError extends Error {
  constructor(stepName) {
    super(`Controller shutdown requested during ${stepName}.`);
    this.name = 'ControllerStopRequestedError';
    this.code = 'controller_stop_requested';
    this.stepName = stepName;
  }
}

export class ControllerShutdownTimeoutError extends Error {
  constructor(stepName) {
    super(`Controller shutdown timed out during ${stepName}.`);
    this.name = 'ControllerShutdownTimeoutError';
    this.code = 'controller_shutdown_timeout';
    this.stepName = stepName;
  }
}

export function isStopRequested(stopSignal) {
  return stopSignal?.aborted === true;
}

export function ensureStopRequestedAt(stopSignal) {
  if (!stopSignal) return new Date().toISOString();
  if (typeof stopSignal.requested_at === 'string' && stopSignal.requested_at.trim() !== '') {
    return stopSignal.requested_at;
  }
  if (canStoreStopSignalExternally(stopSignal) && stopRequestedAtMap.has(stopSignal)) {
    return stopRequestedAtMap.get(stopSignal);
  }
  const timestamp = new Date().toISOString();
  try {
    stopSignal.requested_at = timestamp;
  } catch {
    if (canStoreStopSignalExternally(stopSignal)) {
      stopRequestedAtMap.set(stopSignal, timestamp);
    }
    return timestamp;
  }
  if (typeof stopSignal.requested_at === 'string' && stopSignal.requested_at.trim() !== '') {
    return stopSignal.requested_at;
  }
  if (canStoreStopSignalExternally(stopSignal)) {
    stopRequestedAtMap.set(stopSignal, timestamp);
  }
  return timestamp;
}

export function isAbortSignalError(error, abortSignal) {
  return abortSignal?.aborted === true && (
    error === abortSignal.reason
      || error?.name === 'AbortError'
      || error?.code === 'ABORT_ERR'
      || error?.message === abortSignal.reason?.message
  );
}

export function isControllerStopRequestedError(error) {
  return error?.code === 'controller_stop_requested';
}

export function isControllerShutdownTimeoutError(error) {
  return error?.code === 'controller_shutdown_timeout';
}

export async function runStepWithShutdownBudget(
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

export async function waitForNextPass({
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
