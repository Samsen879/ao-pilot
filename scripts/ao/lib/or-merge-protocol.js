import { createHash } from 'node:crypto';

import { evaluateAuthorizationGrant } from './authorization-grant-contracts.js';
import { validateReleaseReadyDecision } from './release-judgment.js';

export const OR_MERGE_PREFLIGHT_SCHEMA_VERSION = 'ao.or-merge-preflight.v1';
export const GITHUB_MERGE_OBSERVATION_SCHEMA_VERSION = 'ao.github-merge-observation.v1';
export const OR_MERGE_OUTCOME_SCHEMA_VERSION = 'ao.or-merge-outcome.v1';
export const OR_MERGE_PREFLIGHT_MAX_OBSERVATION_AGE_SECONDS = 60;

const GIT_SHA = /^[0-9a-f]{40}$/;
const IMMUTABLE_REF = /^\S+$/;

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalMergeProtocolJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function mergeProtocolFingerprint(value) {
  return createHash('sha256').update(canonicalMergeProtocolJson(value)).digest('hex');
}

function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string' && value !== '' && value === value.trim()
    && IMMUTABLE_REF.test(value) ? value : null;
}

function sha(value) {
  const normalized = string(value);
  return normalized != null && GIT_SHA.test(normalized) ? normalized : null;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function timestamp(value) {
  const normalized = string(value);
  if (normalized == null) return null;
  const milliseconds = Date.parse(normalized);
  return !Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === normalized
    ? normalized : null;
}

function uniqueSortedStrings(values) {
  if (!Array.isArray(values)) return null;
  const normalized = values.map(string);
  if (normalized.some((value) => value == null) || new Set(normalized).size !== normalized.length) {
    return null;
  }
  return normalized.sort();
}

function hasOnlyKeys(value, allowed) {
  return isObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value, expected) {
  return isObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function preflightResult(inputFingerprint, binding, disposition, reasonCodes) {
  const result = {
    schema_version: OR_MERGE_PREFLIGHT_SCHEMA_VERSION,
    disposition,
    reason_codes: [...new Set(reasonCodes)].sort(),
    input_fingerprint: inputFingerprint,
    binding,
    effect_authority: disposition === 'merge_authorized' ? 'or_only' : 'none',
    claims: {
      ao_executed_merge: false,
      merge_dispatched: false,
      provider_merge_confirmed: false,
    },
  };
  return { ...result, fingerprint: mergeProtocolFingerprint(result) };
}

function normalizeLiveObservation(observation) {
  if (!isObject(observation)) return { value: null, reasons: ['live_observation_missing'] };
  const reasons = [];
  const repository = isObject(observation.repository) ? observation.repository : {};
  const pullRequest = isObject(observation.pull_request) ? observation.pull_request : {};
  const review = isObject(observation.review) ? observation.review : {};
  const checks = Array.isArray(observation.required_checks) ? observation.required_checks : null;
  const evidenceRefs = uniqueSortedStrings(observation.evidence_refs);
  const value = {
    schema_version: observation.schema_version,
    provider: observation.provider,
    source_ok: observation.source_ok,
    observed_at: timestamp(observation.observed_at),
    repository: {
      repository_id: positiveInteger(repository.repository_id),
      slug: string(repository.slug),
    },
    pull_request: {
      number: positiveInteger(pullRequest.number),
      state: string(pullRequest.state),
      base_ref: string(pullRequest.base_ref),
      base_sha: sha(pullRequest.base_sha),
      head_ref: string(pullRequest.head_ref),
      head_sha: sha(pullRequest.head_sha),
      merge_commit_sha: pullRequest.merge_commit_sha == null ? null : sha(pullRequest.merge_commit_sha),
    },
    review: {
      actor_ref: string(review.actor_ref),
      verdict: string(review.verdict),
      independent: review.independent,
      reviewed_head_sha: sha(review.reviewed_head_sha),
      unresolved_thread_count: Number.isSafeInteger(review.unresolved_thread_count)
        && review.unresolved_thread_count >= 0 ? review.unresolved_thread_count : null,
      evidence_ref: string(review.evidence_ref),
    },
    required_checks: checks?.map((check) => ({
      name: string(check?.name),
      status: string(check?.status),
      head_sha: sha(check?.head_sha),
      evidence_ref: string(check?.evidence_ref),
    })).sort((left, right) => String(left.name).localeCompare(String(right.name))) ?? null,
    evidence_refs: evidenceRefs,
  };
  if (!hasOnlyKeys(observation, [
    'evidence_refs', 'observed_at', 'provider', 'pull_request', 'repository',
    'required_checks', 'review', 'schema_version', 'source_ok',
  ]) || !hasOnlyKeys(repository, ['repository_id', 'slug'])
    || !hasOnlyKeys(pullRequest, [
      'base_ref', 'base_sha', 'head_ref', 'head_sha', 'merge_commit_sha', 'number', 'state',
    ]) || !hasOnlyKeys(review, [
      'actor_ref', 'evidence_ref', 'independent', 'reviewed_head_sha', 'unresolved_thread_count', 'verdict',
    ]) || checks?.some((check) => !hasOnlyKeys(check, [
      'evidence_ref', 'head_sha', 'name', 'status',
    ]))) reasons.push('live_observation_unknown_field');
  if (observation.schema_version !== 'ao.github-merge-preflight-observation.v1') reasons.push('live_observation_version_invalid');
  if (observation.provider !== 'github') reasons.push('live_observation_provider_invalid');
  if (observation.source_ok !== true) reasons.push('live_observation_source_unavailable');
  if (value.observed_at == null) reasons.push('live_observation_timestamp_invalid');
  if (!value.repository.repository_id || !value.repository.slug) reasons.push('live_observation_repository_invalid');
  if (!value.pull_request.number || !value.pull_request.state || !value.pull_request.base_ref
    || !value.pull_request.base_sha || !value.pull_request.head_ref || !value.pull_request.head_sha) {
    reasons.push('live_observation_pull_request_invalid');
  }
  if (!value.review.actor_ref || !value.review.verdict || typeof value.review.independent !== 'boolean'
    || !value.review.reviewed_head_sha || value.review.unresolved_thread_count == null
    || !value.review.evidence_ref) reasons.push('live_observation_review_invalid');
  if (checks == null || checks.length === 0 || value.required_checks.some((check) => (
    !check.name || !check.status || !check.head_sha || !check.evidence_ref
  ))) reasons.push('live_observation_checks_invalid');
  if (evidenceRefs == null || evidenceRefs.length === 0) reasons.push('live_observation_evidence_missing');
  return { value, reasons };
}

export function evaluateOrMergePreflight({
  grant,
  authorization_request: authorizationRequest,
  release_judgment: releaseJudgment,
  live_observation: liveObservation,
  now,
} = {}) {
  const input = { grant, authorization_request: authorizationRequest, release_judgment: releaseJudgment, live_observation: liveObservation };
  const inputFingerprint = mergeProtocolFingerprint(input);
  const { value: live, reasons } = normalizeLiveObservation(liveObservation);
  const binding = {
    repository: live?.repository ?? null,
    task: authorizationRequest?.task == null ? null : {
      admission_ref: string(authorizationRequest.task.admission_ref),
      issue_number: positiveInteger(authorizationRequest.task.issue_number),
      task_id: string(authorizationRequest.task.task_id),
    },
    pull_request: live?.pull_request == null ? null : {
      number: live.pull_request.number,
      base_ref: live.pull_request.base_ref,
      base_sha: live.pull_request.base_sha,
      head_ref: live.pull_request.head_ref,
      head_sha: live.pull_request.head_sha,
    },
    authorization_grant_fingerprint: null,
    release_judgment_contract: releaseJudgment?.judgment_contract ?? null,
    live_observation_fingerprint: live == null ? null : mergeProtocolFingerprint(live),
    live_observed_at: live?.observed_at ?? null,
  };

  const judgment = validateReleaseReadyDecision(releaseJudgment);
  reasons.push(...judgment.reason_codes.map((code) => `judgment_${code}`));
  const evaluatedAt = timestamp(now);
  if (evaluatedAt == null) {
    reasons.push('preflight_evaluation_timestamp_invalid');
  } else if (live?.observed_at != null) {
    const ageMilliseconds = Date.parse(evaluatedAt) - Date.parse(live.observed_at);
    if (ageMilliseconds < 0) reasons.push('live_observation_from_future');
    if (ageMilliseconds > OR_MERGE_PREFLIGHT_MAX_OBSERVATION_AGE_SECONDS * 1000) {
      reasons.push('live_observation_stale');
    }
  }

  let authorization;
  try {
    authorization = evaluateAuthorizationGrant(grant, authorizationRequest, { now });
  } catch {
    authorization = { decision: 'deny', reason_code: 'authorization_evaluation_failed' };
  }
  binding.authorization_grant_fingerprint = authorization?.grant_fingerprint ?? null;
  if (authorization?.decision !== 'authorize') {
    reasons.push(`authorization_${authorization?.reason_code ?? 'not_authorized'}`);
  }

  const expected = authorizationRequest;
  if (live != null && expected != null) {
    if (live.repository.repository_id !== expected.repository?.repository_id
      || live.repository.slug !== expected.repository?.slug) reasons.push('repository_binding_mismatch');
    if (live.pull_request.number !== expected.pull_request?.number) reasons.push('pull_request_binding_mismatch');
    if (live.pull_request.base_ref !== expected.branch?.base_ref
      || live.pull_request.base_sha !== expected.branch?.base_sha) reasons.push('exact_base_drift');
    if (live.pull_request.base_sha !== expected.merge?.expected_base_sha
      || live.pull_request.base_sha !== expected.review?.base_sha) {
      reasons.push('merge_base_binding_mismatch');
    }
    if (live.pull_request.head_ref !== expected.branch?.head_ref
      || live.pull_request.head_sha !== expected.branch?.head_sha
      || live.pull_request.head_sha !== expected.merge?.expected_head_sha) reasons.push('exact_head_drift');
    if (live.review.verdict !== 'PASS' || live.review.independent !== true) reasons.push('independent_pass_missing');
    if (live.review.actor_ref !== expected.review?.actor_ref) reasons.push('review_actor_binding_mismatch');
    if (live.review.evidence_ref !== expected.review?.review_ref) reasons.push('review_evidence_binding_mismatch');
    if (live.review.reviewed_head_sha !== live.pull_request.head_sha) reasons.push('review_exact_head_mismatch');
    if (live.review.unresolved_thread_count !== 0) reasons.push('unresolved_review_threads');
    if (live.required_checks?.some((check) => check.status !== 'SUCCESS')) reasons.push('required_check_not_successful');
    if (live.required_checks?.some((check) => check.head_sha !== live.pull_request.head_sha)) reasons.push('required_check_head_mismatch');
    if (!['OPEN', 'MERGED'].includes(live.pull_request.state)) reasons.push('pull_request_state_ambiguous');
  }

  if (reasons.length > 0) return preflightResult(inputFingerprint, binding, 'blocked', reasons);
  if (live.pull_request.state === 'MERGED') {
    if (live.pull_request.merge_commit_sha == null) {
      return preflightResult(inputFingerprint, binding, 'blocked', ['already_merged_commit_missing']);
    }
    return preflightResult(inputFingerprint, binding, 'already_merged', []);
  }
  return preflightResult(inputFingerprint, binding, 'merge_authorized', []);
}

export function normalizeGitHubMergeObservation(observation) {
  const reasons = [];
  if (!isObject(observation)) return { ok: false, reason_codes: ['provider_observation_missing'], observation: null };
  const normalized = {
    schema_version: observation.schema_version,
    provider: observation.provider,
    source_ok: observation.source_ok,
    source_error: observation.source_error == null ? null : string(observation.source_error),
    observed_at: timestamp(observation.observed_at),
    repository: {
      repository_id: positiveInteger(observation.repository?.repository_id),
      slug: string(observation.repository?.slug),
    },
    pull_request: {
      number: positiveInteger(observation.pull_request?.number),
      state: string(observation.pull_request?.state),
      base_ref: string(observation.pull_request?.base_ref),
      base_sha: sha(observation.pull_request?.base_sha),
      head_sha: sha(observation.pull_request?.head_sha),
      merge_commit_sha: observation.pull_request?.merge_commit_sha == null
        ? null : sha(observation.pull_request.merge_commit_sha),
      merged_at: observation.pull_request?.merged_at == null
        ? null : timestamp(observation.pull_request.merged_at),
      url: string(observation.pull_request?.url),
    },
    evidence_refs: uniqueSortedStrings(observation.evidence_refs),
  };
  if (!hasOnlyKeys(observation, [
    'evidence_refs', 'observed_at', 'provider', 'pull_request', 'repository',
    'schema_version', 'source_error', 'source_ok',
  ]) || !hasOnlyKeys(observation.repository, ['repository_id', 'slug'])
    || !hasOnlyKeys(observation.pull_request, [
      'base_ref', 'base_sha', 'head_sha', 'merge_commit_sha', 'merged_at', 'number', 'state', 'url',
    ])) reasons.push('provider_observation_unknown_field');
  if (normalized.schema_version !== GITHUB_MERGE_OBSERVATION_SCHEMA_VERSION) reasons.push('provider_observation_version_invalid');
  if (normalized.provider !== 'github') reasons.push('provider_observation_not_github');
  if (normalized.source_ok !== true) reasons.push('provider_observation_unavailable');
  if (!normalized.observed_at) reasons.push('provider_observation_timestamp_invalid');
  if (!normalized.repository.repository_id || !normalized.repository.slug) reasons.push('provider_observation_repository_invalid');
  if (!normalized.pull_request.number || !normalized.pull_request.state
    || !normalized.pull_request.base_ref || !normalized.pull_request.base_sha
    || !normalized.pull_request.head_sha
    || !normalized.pull_request.url) reasons.push('provider_observation_pull_request_invalid');
  if (!normalized.evidence_refs || normalized.evidence_refs.length === 0) reasons.push('provider_observation_evidence_missing');
  if (normalized.pull_request.state === 'MERGED'
    && (!normalized.pull_request.merge_commit_sha || !normalized.pull_request.merged_at)) {
    reasons.push('provider_merged_evidence_incomplete');
  }
  return { ok: reasons.length === 0, reason_codes: reasons.sort(), observation: normalized };
}

export function bindGitHubMergeOutcome({
  preflight,
  preflight_inputs: preflightInputs,
  dispatch,
  provider_observation: providerObservation,
} = {}) {
  const normalized = normalizeGitHubMergeObservation(providerObservation);
  const reasons = [...normalized.reason_codes];
  const observation = normalized.observation;
  const expected = preflight?.binding;
  const preflightValidation = validateOrMergePreflightRecord(preflight);
  reasons.push(...preflightValidation.reason_codes);
  let regeneratedPreflight = null;
  if (hasExactKeys(preflightInputs, [
    'authorization_request', 'grant', 'live_observation', 'now', 'release_judgment',
  ])) {
    regeneratedPreflight = evaluateOrMergePreflight({
      grant: preflightInputs.grant,
      authorization_request: preflightInputs.authorization_request,
      release_judgment: preflightInputs.release_judgment,
      live_observation: preflightInputs.live_observation,
      now: preflightInputs.now,
    });
    if (canonicalMergeProtocolJson(regeneratedPreflight) !== canonicalMergeProtocolJson(preflight)) {
      reasons.push('preflight_authority_evidence_mismatch');
    }
  } else {
    reasons.push('preflight_authority_evidence_missing');
  }
  const dispatchKeys = isObject(dispatch) ? Object.keys(dispatch) : [];
  if (dispatchKeys.some((key) => !['attempt_ref', 'evidence_refs', 'status'].includes(key))) {
    reasons.push('dispatch_contract_unknown_field');
  }
  const rawDispatchStatus = string(dispatch?.status);
  const dispatchStatus = ['not_dispatched', 'succeeded', 'failed', 'unknown'].includes(rawDispatchStatus)
    ? rawDispatchStatus : 'unknown';
  const dispatchEvidenceRefs = dispatch?.evidence_refs == null
    ? [] : uniqueSortedStrings(dispatch.evidence_refs);
  if (dispatchEvidenceRefs == null) reasons.push('dispatch_evidence_invalid');
  const normalizedDispatch = isObject(dispatch) ? {
    status: dispatchStatus,
    attempt_ref: dispatch.attempt_ref == null ? null : string(dispatch.attempt_ref),
    evidence_refs: dispatchEvidenceRefs ?? [],
  } : null;
  if (!preflightValidation.ok
    || !['merge_authorized', 'already_merged'].includes(preflight?.disposition)) reasons.push('preflight_not_authorized');
  if (['succeeded', 'failed', 'unknown'].includes(normalizedDispatch?.status)) {
    if (!normalizedDispatch.attempt_ref) reasons.push('dispatch_attempt_ref_missing');
  } else if (normalizedDispatch?.status !== 'not_dispatched') reasons.push('dispatch_status_ambiguous');
  if (isObject(dispatch) && rawDispatchStatus !== dispatchStatus) reasons.push('dispatch_status_ambiguous');
  if (preflight?.disposition === 'merge_authorized' && normalizedDispatch?.status === 'not_dispatched') reasons.push('merge_not_dispatched');
  if (preflight?.disposition === 'already_merged' && normalizedDispatch?.status !== 'not_dispatched') reasons.push('already_merged_must_not_dispatch');
  if (observation != null && expected != null) {
    if (observation.repository.repository_id !== expected.repository?.repository_id
      || observation.repository.slug !== expected.repository?.slug) reasons.push('provider_repository_binding_mismatch');
    if (observation.pull_request.number !== expected.pull_request?.number) reasons.push('provider_pull_request_binding_mismatch');
    if (observation.pull_request.base_ref !== expected.pull_request?.base_ref
      || observation.pull_request.base_sha !== expected.pull_request?.base_sha) reasons.push('provider_exact_base_drift');
    if (observation.pull_request.head_sha !== expected.pull_request?.head_sha) reasons.push('provider_exact_head_drift');
    if (observation.pull_request.state !== 'MERGED') reasons.push('provider_merge_not_confirmed');
    if (timestamp(expected.live_observed_at) == null
      || Date.parse(observation.observed_at) < Date.parse(expected.live_observed_at)) {
      reasons.push('provider_observation_predates_preflight');
    }
  }
  const confirmed = reasons.length === 0;
  const core = {
    schema_version: OR_MERGE_OUTCOME_SCHEMA_VERSION,
    disposition: confirmed ? 'confirmed_merged' : 'blocked',
    outcome: confirmed
      ? (preflight.disposition === 'already_merged' ? 'already_merged' : 'merged')
      : (['succeeded', 'failed', 'unknown'].includes(normalizedDispatch?.status) ? 'unknown_effect' : 'not_merged'),
    reason_codes: [...new Set(reasons)].sort(),
    preflight_fingerprint: /^[0-9a-f]{64}$/.test(preflight?.fingerprint ?? '')
      ? preflight.fingerprint : null,
    dispatch: normalizedDispatch,
    provider_observation_fingerprint: observation == null ? null : mergeProtocolFingerprint(observation),
    merge_binding: confirmed ? {
      repository: observation.repository,
      pr_number: observation.pull_request.number,
      base_ref: observation.pull_request.base_ref,
      base_sha: observation.pull_request.base_sha,
      head_sha: observation.pull_request.head_sha,
      merge_commit_sha: observation.pull_request.merge_commit_sha,
      merged_at: observation.pull_request.merged_at,
      evidence_refs: observation.evidence_refs,
    } : null,
    claims: {
      provider_authoritative: confirmed,
      exact_head_confirmed: confirmed,
      merged: confirmed,
    },
  };
  return { ...core, fingerprint: mergeProtocolFingerprint(core) };
}

export function validateOrMergePreflightRecord(preflight) {
  const reasons = [];
  const topKeys = [
    'binding', 'claims', 'disposition', 'effect_authority', 'fingerprint',
    'input_fingerprint', 'reason_codes', 'schema_version',
  ];
  const bindingKeys = [
    'authorization_grant_fingerprint', 'live_observation_fingerprint', 'live_observed_at',
    'pull_request', 'release_judgment_contract', 'repository', 'task',
  ];
  if (!hasExactKeys(preflight, topKeys)) reasons.push('preflight_contract_unknown_field');
  if (preflight?.schema_version !== OR_MERGE_PREFLIGHT_SCHEMA_VERSION) reasons.push('preflight_contract_version_invalid');
  if (!['blocked', 'merge_authorized', 'already_merged'].includes(preflight?.disposition)) reasons.push('preflight_disposition_invalid');
  if (!Array.isArray(preflight?.reason_codes)
    || preflight.reason_codes.some((reason) => string(reason) == null)
    || JSON.stringify(preflight.reason_codes) !== JSON.stringify([...new Set(preflight.reason_codes)].sort())) {
    reasons.push('preflight_reason_codes_invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(preflight?.input_fingerprint ?? '')) reasons.push('preflight_input_fingerprint_invalid');
  if (!hasExactKeys(preflight?.binding, bindingKeys)
    || !/^[0-9a-f]{64}$/.test(preflight?.binding?.authorization_grant_fingerprint ?? '')
    || !/^[0-9a-f]{64}$/.test(preflight?.binding?.live_observation_fingerprint ?? '')
    || timestamp(preflight?.binding?.live_observed_at) == null) reasons.push('preflight_binding_invalid');
  if (!hasExactKeys(preflight?.binding?.repository, ['repository_id', 'slug'])
    || !positiveInteger(preflight?.binding?.repository?.repository_id)
    || !string(preflight?.binding?.repository?.slug)
    || !hasExactKeys(preflight?.binding?.task, ['admission_ref', 'issue_number', 'task_id'])
    || !string(preflight?.binding?.task?.admission_ref)
    || !positiveInteger(preflight?.binding?.task?.issue_number)
    || !string(preflight?.binding?.task?.task_id)
    || !hasExactKeys(preflight?.binding?.pull_request, [
      'base_ref', 'base_sha', 'head_ref', 'head_sha', 'number',
    ])
    || !positiveInteger(preflight?.binding?.pull_request?.number)
    || !string(preflight?.binding?.pull_request?.base_ref)
    || !sha(preflight?.binding?.pull_request?.base_sha)
    || !string(preflight?.binding?.pull_request?.head_ref)
    || !sha(preflight?.binding?.pull_request?.head_sha)
    || preflight?.binding?.release_judgment_contract !== 'ao.release-judgment.v1') {
    reasons.push('preflight_scope_binding_invalid');
  }
  if (!hasExactKeys(preflight?.claims, [
    'ao_executed_merge', 'merge_dispatched', 'provider_merge_confirmed',
  ]) || preflight?.claims?.ao_executed_merge !== false
    || preflight?.claims?.merge_dispatched !== false
    || preflight?.claims?.provider_merge_confirmed !== false) reasons.push('preflight_claims_invalid');
  const expectedAuthority = preflight?.disposition === 'merge_authorized' ? 'or_only' : 'none';
  if (preflight?.effect_authority !== expectedAuthority) reasons.push('preflight_effect_authority_invalid');
  if (preflight?.disposition !== 'blocked' && preflight?.reason_codes?.length !== 0) reasons.push('preflight_authorized_with_reasons');
  const fingerprint = preflight?.fingerprint;
  if (!/^[0-9a-f]{64}$/.test(fingerprint ?? '')) {
    reasons.push('preflight_fingerprint_invalid');
  } else {
    const { fingerprint: ignored, ...core } = preflight;
    if (mergeProtocolFingerprint(core) !== fingerprint) reasons.push('preflight_fingerprint_mismatch');
  }
  return { ok: reasons.length === 0, reason_codes: [...new Set(reasons)].sort() };
}
