import {
  LIFECYCLE_DELIVERY_TRIGGER_PRIORITY,
} from '../lifecycle-contracts.js';
import {
  createProjectScope,
} from '../reconciliation-contracts.js';

export function uniquePrNumbers(prBindings = [], matchedPrs = []) {
  return [...new Set([
    ...(prBindings ?? []).filter((binding) => binding?.status === 'bound').map((binding) => binding?.pr_number),
    ...(matchedPrs ?? []).map((pr) => pr?.pr_number),
  ])].filter((value) => Number.isInteger(value)).sort((left, right) => left - right);
}

export function buildGitHubScope(task, prBindings = []) {
  const prNumbers = uniquePrNumbers(prBindings, []);
  const selectionBasis = [];
  if (prNumbers.length) selectionBasis.push('managed_task_pr_binding');
  if (task?.branch_name) selectionBasis.push('managed_task_branch');

  return createProjectScope({
    prNumbers,
    selectionBasis,
    notes: task?.branch_name ? [`branch:${task.branch_name}`] : [],
  });
}

export function resolveTaskRuntimePreflight(snapshot, task) {
  const taskSpec = snapshot?.state?.task_specs?.find((record) => record?.task_id === task?.task_id) ?? null;
  const runtimeRef = taskSpec?.snapshot?.spec?.runtime_ref ?? null;
  const runtimePreflight = runtimeRef == null
    ? null
    : (snapshot?.state?.runtime_preflights?.find((record) => record?.runtime_ref === runtimeRef) ?? null);
  return {
    taskSpec,
    runtimeRef,
    runtimePreflight,
  };
}

export function resolveLifecyclePrNumber(prBindings = [], matchedPrs = []) {
  const prNumbers = uniquePrNumbers(prBindings, matchedPrs);
  return prNumbers.length === 1 ? prNumbers[0] : null;
}

export function compareDeliveryEventOrder(left, right) {
  const leftObservedAt = String(left?.observed_at ?? '');
  const rightObservedAt = String(right?.observed_at ?? '');
  if (leftObservedAt !== rightObservedAt) {
    return leftObservedAt.localeCompare(rightObservedAt);
  }
  return String(left?.event_id ?? '').localeCompare(String(right?.event_id ?? ''));
}

export function isDeliveryEventCurrentForPr(event, pr) {
  if (!pr || !event || event.pr_number !== pr.pr_number) return false;

  const payload = event.payload ?? {};
  const currentHeadSha = pr.head_sha ?? null;
  const eventHeadSha = event.event_family === 'review_comment'
    ? (payload.commit_oid ?? payload.head_sha ?? null)
    : (payload.head_sha ?? null);

  if (!currentHeadSha || !eventHeadSha) return true;
  return eventHeadSha === currentHeadSha;
}

export function selectCurrentDeliveryEvents({
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
  const aoWorkers = matchedAoWorkers ?? [];
  const prs = matchedPrs ?? [];
  if (
    aoWorkers.length === 0
    || aoWorkers.some((worker) => worker?.freshness?.status === 'stale')
  ) {
    return 'agent_exited';
  }

  const activeDeliveryTriggers = new Set(selectCurrentDeliveryEvents({
    matchedPrs: prs,
    deliveryEvents,
  })
    .map((event) => event?.lifecycle_trigger)
    .filter((trigger) => typeof trigger === 'string' && trigger !== '' && trigger !== 'manual'));

  for (const trigger of LIFECYCLE_DELIVERY_TRIGGER_PRIORITY) {
    if (activeDeliveryTriggers.has(trigger)) {
      return trigger;
    }
  }

  if (prs.some((pr) => pr?.review_status === 'changes_requested')) {
    return 'changes_requested';
  }

  if (prs.some((pr) => pr?.ci_status === 'failing')) {
    return 'ci_failed';
  }

  if (prs.some((pr) => pr?.mergeability === 'conflicting')) {
    return 'merge_conflicts';
  }

  if (prs.some((pr) => (
    pr?.review_status === 'approved'
      && pr?.ci_status === 'passing'
      && pr?.mergeability === 'mergeable'
      && pr?.is_draft === false
  ))) {
    return 'approved_and_green';
  }

  return 'manual';
}
