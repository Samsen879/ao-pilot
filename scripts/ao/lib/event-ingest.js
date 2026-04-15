import { createHash } from 'node:crypto';

import {
  createControllerCursorRecord,
  createDeliveryEventRecord,
  createObservationRecord,
} from './state-contracts.js';

function hashPayload(payload) {
  return createHash('sha1')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function sortWorkers(workers = []) {
  return [...workers]
    .map((worker) => ({
      session_name: worker.session_name ?? null,
      session_runtime_id: worker.session_runtime_id ?? null,
      issue_number: worker.issue_number ?? null,
      branch_name: worker.branch_name ?? null,
      pr_number: worker.pr_number ?? null,
      lifecycle_state: worker.lifecycle_state ?? null,
      last_seen_at: worker.last_seen_at ?? null,
      freshness_status: worker.freshness?.status ?? null,
    }))
    .sort((left, right) => String(left.session_name ?? '').localeCompare(String(right.session_name ?? '')));
}

function sortPrs(prs = []) {
  return [...prs]
    .map((pr) => ({
      pr_number: pr.pr_number ?? null,
      state: pr.state ?? null,
      head_branch: pr.head_branch ?? null,
      head_sha: pr.head_sha ?? null,
      review_status: pr.review_status ?? null,
      ci_status: pr.ci_status ?? null,
      mergeability: pr.mergeability ?? null,
      is_draft: pr.is_draft ?? null,
      url: pr.url ?? null,
      reviews: sortReviews(pr.reviews),
    }))
    .sort((left, right) => Number(left.pr_number ?? 0) - Number(right.pr_number ?? 0));
}

function sortReviews(reviews = []) {
  return [...(reviews ?? [])]
    .map((review) => ({
      review_id: review.review_id ?? null,
      state: review.state ?? null,
      author_login: review.author_login ?? null,
      submitted_at: review.submitted_at ?? null,
      commit_oid: review.commit_oid ?? null,
    }))
    .sort((left, right) => {
      if (String(left.submitted_at ?? '') !== String(right.submitted_at ?? '')) {
        return String(left.submitted_at ?? '').localeCompare(String(right.submitted_at ?? ''));
      }
      return String(left.review_id ?? '').localeCompare(String(right.review_id ?? ''));
    });
}

export function matchAoWorkers(task, prBindings = [], aoObservation = {}) {
  const activePrNumbers = new Set((prBindings ?? [])
    .filter((binding) => binding.status === 'bound')
    .map((binding) => binding.pr_number));

  return (aoObservation.workers ?? []).filter((worker) => (
    (task.issue_number != null && worker.issue_number === task.issue_number)
      || (task.branch_name && worker.branch_name === task.branch_name)
      || (worker.pr_number != null && activePrNumbers.has(worker.pr_number))
  ));
}

export function matchGitHubPrs(task, prBindings = [], githubObservation = {}) {
  const activePrNumbers = new Set((prBindings ?? [])
    .filter((binding) => binding.status === 'bound')
    .map((binding) => binding.pr_number));

  return (githubObservation.prs ?? []).filter((pr) => (
    activePrNumbers.has(pr.pr_number)
      || (task.branch_name && pr.head_branch === task.branch_name)
  ));
}

function buildAoPayload(task, matchedWorkers) {
  return {
    task_id: task.task_id,
    issue_number: task.issue_number ?? null,
    branch_name: task.branch_name ?? null,
    worktree_path: task.worktree_path ?? null,
    workers: sortWorkers(matchedWorkers),
  };
}

function buildGitHubPayload(task, matchedPrs) {
  return {
    task_id: task.task_id,
    issue_number: task.issue_number ?? null,
    branch_name: task.branch_name ?? null,
    prs: sortPrs(matchedPrs),
  };
}

function ingestSingleObservation({
  repository,
  controllerId,
  task,
  sourceKind,
  observedAt,
  payload,
  now,
  summary,
} = {}) {
  const cursor = hashPayload(payload);
  const observationId = `${task.task_id}:${sourceKind}:${cursor}`;
  const cursorId = `${controllerId}:${task.task_id}:${sourceKind}`;
  const snapshot = repository.getSnapshot();
  const existingCursor = snapshot.state.controller_cursors.find((record) => record.cursor_id === cursorId) ?? null;

  if (existingCursor?.last_cursor === cursor) {
    return {
      ingested: false,
      observationId,
      cursorId,
      cursor,
    };
  }

  const existingObservation = snapshot.state.observations.find((record) => record.observation_id === observationId) ?? null;

  if (!existingObservation) {
    repository.upsertObservation(createObservationRecord({
      observation_id: observationId,
      task_id: task.task_id,
      source_kind: sourceKind,
      cursor,
      observed_at: observedAt,
      recorded_at: now,
      summary,
      payload,
    }));
  }

  repository.upsertControllerCursor(createControllerCursorRecord({
    cursor_id: cursorId,
    controller_id: controllerId,
    task_id: task.task_id,
    source_kind: sourceKind,
    last_cursor: cursor,
    observed_at: observedAt,
    updated_at: now,
  }));

  return {
    ingested: !existingObservation,
    observationId,
    cursorId,
    cursor,
  };
}

function resolvePrLifecycleBinding(pr = {}) {
  if (
    pr.state === 'OPEN'
    && pr.review_status === 'approved'
    && pr.ci_status === 'passing'
    && pr.mergeability === 'mergeable'
    && pr.is_draft === false
  ) {
    return {
      lifecycleTrigger: 'approved_and_green',
      controllerActionHint: 'notify_human_ready',
    };
  }

  if (pr.mergeability === 'conflicting') {
    return {
      lifecycleTrigger: 'merge_conflicts',
      controllerActionHint: 'hold_mergeability',
    };
  }

  return {
    lifecycleTrigger: 'manual',
    controllerActionHint: 'observe',
  };
}

function resolveCheckLifecycleBinding(pr = {}) {
  if (pr.ci_status === 'failing') {
    return {
      lifecycleTrigger: 'ci_failed',
      controllerActionHint: 'hold_ci',
    };
  }

  if (pr.ci_status === 'pending') {
    return {
      lifecycleTrigger: 'manual',
      controllerActionHint: 'hold_ci',
    };
  }

  return {
    lifecycleTrigger: 'manual',
    controllerActionHint: 'observe',
  };
}

function resolveReviewLifecycleBinding(pr = {}) {
  if (pr.review_status === 'changes_requested') {
    return {
      lifecycleTrigger: 'changes_requested',
      controllerActionHint: 'hold_review',
    };
  }

  if (pr.review_status === 'pending') {
    return {
      lifecycleTrigger: 'manual',
      controllerActionHint: 'hold_review',
    };
  }

  return {
    lifecycleTrigger: 'manual',
    controllerActionHint: 'observe',
  };
}

function isBotLikeAuthor(authorLogin) {
  const normalized = String(authorLogin ?? '').trim().toLowerCase();
  return /bot|codex|copilot/.test(normalized);
}

function resolveReviewCommentLifecycleBinding(review = {}) {
  if (review.state === 'commented' && isBotLikeAuthor(review.author_login)) {
    return {
      lifecycleTrigger: 'bugbot_comments',
      controllerActionHint: 'hold_review',
    };
  }

  return {
    lifecycleTrigger: 'manual',
    controllerActionHint: 'hold_review',
  };
}

function buildDeliveryEventId(taskId, dedupeKey) {
  return `${taskId}:delivery:${hashPayload(dedupeKey)}`;
}

function buildEventLineage({
  observationId,
  sourceCursor,
} = {}) {
  return {
    source_observation_id: observationId,
    source_cursor: sourceCursor,
  };
}

function buildDeliveryEventsForPr({
  task,
  sourceKind,
  observationId,
  sourceCursor,
  pr,
  observedAt,
  now,
} = {}) {
  const lineage = buildEventLineage({
    observationId,
    sourceCursor,
  });
  const prBinding = resolvePrLifecycleBinding(pr);
  const checkBinding = resolveCheckLifecycleBinding(pr);
  const reviewBinding = resolveReviewLifecycleBinding(pr);
  const events = [];
  const prPayload = {
    state: pr.state ?? null,
    head_branch: pr.head_branch ?? null,
    head_sha: pr.head_sha ?? null,
    review_status: pr.review_status ?? null,
    ci_status: pr.ci_status ?? null,
    mergeability: pr.mergeability ?? null,
    is_draft: pr.is_draft ?? null,
    url: pr.url ?? null,
  };
  const prDedupeKey = `${sourceKind}:pr:${pr.pr_number}:${hashPayload(prPayload)}`;
  events.push(createDeliveryEventRecord({
    event_id: buildDeliveryEventId(task.task_id, prDedupeKey),
    task_id: task.task_id,
    pr_number: pr.pr_number ?? null,
    source_kind: sourceKind,
    event_family: 'pr',
    event_type: 'pr_state',
    dedupe_key: prDedupeKey,
    lifecycle_trigger: prBinding.lifecycleTrigger,
    controller_action_hint: prBinding.controllerActionHint,
    observed_at: observedAt,
    recorded_at: now,
    lineage,
    payload: prPayload,
  }));

  const checkPayload = {
    head_sha: pr.head_sha ?? null,
    ci_status: pr.ci_status ?? null,
  };
  const checkDedupeKey = `${sourceKind}:check:${pr.pr_number}:${hashPayload(checkPayload)}`;
  events.push(createDeliveryEventRecord({
    event_id: buildDeliveryEventId(task.task_id, checkDedupeKey),
    task_id: task.task_id,
    pr_number: pr.pr_number ?? null,
    source_kind: sourceKind,
    event_family: 'check',
    event_type: 'check_state',
    dedupe_key: checkDedupeKey,
    lifecycle_trigger: checkBinding.lifecycleTrigger,
    controller_action_hint: checkBinding.controllerActionHint,
    observed_at: observedAt,
    recorded_at: now,
    lineage,
    payload: checkPayload,
  }));

  const reviewPayload = {
    head_sha: pr.head_sha ?? null,
    review_status: pr.review_status ?? null,
  };
  const reviewDedupeKey = `${sourceKind}:review:${pr.pr_number}:${hashPayload(reviewPayload)}`;
  events.push(createDeliveryEventRecord({
    event_id: buildDeliveryEventId(task.task_id, reviewDedupeKey),
    task_id: task.task_id,
    pr_number: pr.pr_number ?? null,
    source_kind: sourceKind,
    event_family: 'review',
    event_type: 'review_state',
    dedupe_key: reviewDedupeKey,
    lifecycle_trigger: reviewBinding.lifecycleTrigger,
    controller_action_hint: reviewBinding.controllerActionHint,
    observed_at: observedAt,
    recorded_at: now,
    lineage,
    payload: reviewPayload,
  }));

  for (const review of sortReviews(pr.reviews)) {
    if (review.state !== 'commented') continue;
    const commentBinding = resolveReviewCommentLifecycleBinding(review);
    const reviewCommentPayload = {
      head_sha: pr.head_sha ?? null,
      review_id: review.review_id ?? null,
      review_state: review.state ?? null,
      author_login: review.author_login ?? null,
      submitted_at: review.submitted_at ?? null,
      commit_oid: review.commit_oid ?? null,
    };
    const reviewCommentDedupeKey = `${sourceKind}:review_comment:${pr.pr_number}:${review.review_id ?? hashPayload(reviewCommentPayload)}`;
    events.push(createDeliveryEventRecord({
      event_id: buildDeliveryEventId(task.task_id, reviewCommentDedupeKey),
      task_id: task.task_id,
      pr_number: pr.pr_number ?? null,
      source_kind: sourceKind,
      event_family: 'review_comment',
      event_type: 'review_comment_state',
      dedupe_key: reviewCommentDedupeKey,
      lifecycle_trigger: commentBinding.lifecycleTrigger,
      controller_action_hint: commentBinding.controllerActionHint,
      observed_at: review.submitted_at ?? observedAt,
      recorded_at: now,
      lineage,
      payload: reviewCommentPayload,
    }));
  }

  return events;
}

function persistDeliveryEvents({
  repository,
  deliveryEvents = [],
} = {}) {
  const snapshot = repository.getSnapshot();
  const existingEventIds = new Set((snapshot.state.delivery_events ?? []).map((record) => record.event_id));
  const createdDeliveryEventIds = [];

  for (const event of deliveryEvents) {
    if (existingEventIds.has(event.event_id)) continue;
    repository.upsertDeliveryEvent(event);
    createdDeliveryEventIds.push(event.event_id);
    existingEventIds.add(event.event_id);
  }

  return createdDeliveryEventIds;
}

function listTaskDeliveryEvents(repository, taskId) {
  return (repository.getSnapshot().state.delivery_events ?? [])
    .filter((event) => event.task_id === taskId)
    .sort((left, right) => {
      if (String(left.observed_at ?? '') !== String(right.observed_at ?? '')) {
        return String(left.observed_at ?? '').localeCompare(String(right.observed_at ?? ''));
      }
      return String(left.event_id ?? '').localeCompare(String(right.event_id ?? ''));
    });
}

export function ingestManagedTaskPollEvents({
  repository,
  controllerId = 'default',
  task,
  prBindings = [],
  aoObservation = {},
  githubObservation = {},
  now = new Date().toISOString(),
} = {}) {
  const matchedAoWorkers = matchAoWorkers(task, prBindings, aoObservation);
  const matchedPrs = matchGitHubPrs(task, prBindings, githubObservation);
  const aoResult = ingestSingleObservation({
    repository,
    controllerId,
    task,
    sourceKind: 'ao_poll',
    observedAt: aoObservation.observed_at ?? now,
    payload: buildAoPayload(task, matchedAoWorkers),
    now,
    summary: `Observed ${matchedAoWorkers.length} AO worker snapshot(s) for ${task.task_id}.`,
  });
  const githubResult = ingestSingleObservation({
    repository,
    controllerId,
    task,
    sourceKind: 'github_poll',
    observedAt: githubObservation.observed_at ?? now,
    payload: buildGitHubPayload(task, matchedPrs),
    now,
    summary: `Observed ${matchedPrs.length} GitHub PR snapshot(s) for ${task.task_id}.`,
  });
  const createdDeliveryEventIds = persistDeliveryEvents({
    repository,
    deliveryEvents: matchedPrs.flatMap((pr) => buildDeliveryEventsForPr({
      task,
      sourceKind: 'github_poll',
      observationId: githubResult.observationId,
      sourceCursor: githubResult.cursor,
      pr,
      observedAt: githubObservation.observed_at ?? now,
      now,
    })),
  });

  const ingestedCount = [aoResult, githubResult].filter((result) => result.ingested).length;

  return {
    task_id: task.task_id,
    ingested_count: ingestedCount,
    skipped_count: 2 - ingestedCount,
    delivery_event_count: createdDeliveryEventIds.length,
    created_observation_ids: [aoResult, githubResult]
      .filter((result) => result.ingested)
      .map((result) => result.observationId),
    created_delivery_event_ids: createdDeliveryEventIds,
    updated_cursor_ids: [aoResult.cursorId, githubResult.cursorId],
    matchedAoWorkers,
    matchedPrs,
    deliveryEvents: listTaskDeliveryEvents(repository, task.task_id),
  };
}
