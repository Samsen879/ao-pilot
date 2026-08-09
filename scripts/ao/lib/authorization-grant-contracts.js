import { createHash } from 'node:crypto';

export const OR_AUTHORIZATION_GRANT_SCHEMA_VERSION = 'ao.or-authorization-grant.v1';
export const OR_AUTHORIZATION_ESCALATION_SCHEMA_VERSION =
  'ao.or-authorization-escalation.v1';

export const OR_AUTHORIZED_EFFECT_ACTIONS = Object.freeze({
  git_ref: Object.freeze(['push']),
  pull_request: Object.freeze(['open', 'update', 'request_review', 'merge']),
  task: Object.freeze(['closeout']),
});

export const OR_AUTHORIZATION_ESCALATION_KINDS = Object.freeze([
  'authority_scope_expansion',
  'irreversible_effect_ambiguity',
  'security_or_credential_boundary',
  'destructive_migration_or_rollback',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const REF = /^refs\/heads\/[A-Za-z0-9](?:[A-Za-z0-9._\/-]*[A-Za-z0-9])?$/;
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;
const IMMUTABLE_REF = /^\S+$/;

class AuthorizationContractError extends Error {
  constructor(message, code = 'invalid_contract') {
    super(message);
    this.name = 'AuthorizationContractError';
    this.code = code;
  }
}

function assert(condition, message, code) {
  if (!condition) throw new AuthorizationContractError(message, code);
}

function object(value, field) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object`);
  return value;
}

function exactKeys(value, field, expected) {
  const item = object(value, field);
  const actual = Object.keys(item).sort(compareStrings);
  const allowed = [...expected].sort(compareStrings);
  assert(JSON.stringify(actual) === JSON.stringify(allowed),
    `${field} must contain exactly: ${allowed.join(', ')}`,
    'unknown_or_missing_field');
  return item;
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function string(value, field) {
  assert(typeof value === 'string' && value.length > 0, `${field} is required`);
  assert(value === value.trim(), `${field} cannot have leading or trailing whitespace`);
  assert(IMMUTABLE_REF.test(value), `${field} cannot contain whitespace`);
  assert(!value.includes('*') && !value.includes('?'), `${field} cannot contain wildcards`);
  return value;
}

function oneOf(value, field, allowed) {
  const normalized = string(value, field);
  assert(allowed.includes(normalized), `Unsupported ${field}: ${normalized}`);
  return normalized;
}

function nullable(value, field, normalizer) {
  return value == null ? null : normalizer(value, field);
}

function positiveInteger(value, field) {
  assert(Number.isSafeInteger(value) && value > 0, `${field} must be a positive integer`);
  return value;
}

function canonicalTimestamp(value, field) {
  const normalized = string(value, field);
  const milliseconds = Date.parse(normalized);
  assert(!Number.isNaN(milliseconds) && new Date(milliseconds).toISOString() === normalized,
    `${field} must be a canonical ISO-8601 timestamp`);
  return normalized;
}

function sha256(value, field) {
  const normalized = string(value, field);
  assert(SHA256.test(normalized), `${field} must be a lowercase SHA-256 digest`);
  return normalized;
}

function gitSha(value, field) {
  const normalized = string(value, field);
  assert(GIT_SHA.test(normalized), `${field} must be a lowercase 40-character git SHA`);
  return normalized;
}

function branchRef(value, field) {
  const normalized = string(value, field);
  assert(REF.test(normalized) && !normalized.includes('//') && !normalized.includes('..'),
    `${field} must be an exact normalized branch ref`);
  return normalized;
}

function repositorySlug(value, field) {
  const normalized = string(value, field);
  assert(REPOSITORY.test(normalized), `${field} must be an exact owner/name slug`);
  return normalized;
}

function sortedUnique(values, field, normalizer = string, { allowEmpty = false } = {}) {
  assert(Array.isArray(values) && (allowEmpty || values.length > 0),
    `${field} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  const normalized = values.map((value, index) => normalizer(value, `${field}[${index}]`));
  assert(new Set(normalized).size === normalized.length, `${field} contains duplicates`);
  return normalized.sort(compareStrings);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareStrings)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  assert(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)),
    'Canonical JSON cannot contain undefined or non-finite numbers');
  return value;
}

export function canonicalAuthorizationJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function authorizationSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeActor(value, field, keys) {
  const actor = exactKeys(value, field, keys);
  return Object.fromEntries(keys.map((key) => [key, string(actor[key], `${field}.${key}`)]));
}

function normalizeRepository(value, field) {
  const repository = exactKeys(value, field, ['repository_id', 'slug']);
  return {
    repository_id: positiveInteger(repository.repository_id, `${field}.repository_id`),
    slug: repositorySlug(repository.slug, `${field}.slug`),
  };
}

function normalizeTask(value, field) {
  const task = exactKeys(value, field, ['admission_ref', 'issue_number', 'task_id']);
  return {
    admission_ref: string(task.admission_ref, `${field}.admission_ref`),
    issue_number: positiveInteger(task.issue_number, `${field}.issue_number`),
    task_id: string(task.task_id, `${field}.task_id`),
  };
}

function normalizeAllowedActions(values) {
  assert(Array.isArray(values) && values.length > 0,
    'grant.allowed_actions must be a non-empty array');
  const actions = values.map((value, index) => {
    const field = `grant.allowed_actions[${index}]`;
    const item = exactKeys(value, field, ['action', 'effect']);
    const effect = oneOf(item.effect, `${field}.effect`, Object.keys(OR_AUTHORIZED_EFFECT_ACTIONS));
    const action = oneOf(item.action, `${field}.action`, OR_AUTHORIZED_EFFECT_ACTIONS[effect]);
    return { action, effect };
  }).sort((left, right) => compareStrings(
    `${left.effect}:${left.action}`,
    `${right.effect}:${right.action}`,
  ));
  const keys = actions.map(({ effect, action }) => `${effect}:${action}`);
  assert(new Set(keys).size === keys.length, 'grant.allowed_actions contains duplicates');
  return actions;
}

export function normalizeAuthorizationGrant(grant) {
  const value = exactKeys(grant, 'grant', [
    'allowed_actions', 'branch_scope', 'expires_at', 'grant_id', 'issued_at', 'issuer',
    'merge_scope', 'pull_request_scope', 'replay_protection', 'repository',
    'revocation', 'reviewer_freshness', 'rollback_recovery', 'schema_version',
    'subject', 'task',
  ]);
  assert(value.schema_version === OR_AUTHORIZATION_GRANT_SCHEMA_VERSION,
    `Unsupported OR authorization grant schema: ${String(value.schema_version)}`,
    'mixed_version');
  const issuedAt = canonicalTimestamp(value.issued_at, 'grant.issued_at');
  const expiresAt = canonicalTimestamp(value.expires_at, 'grant.expires_at');
  assert(Date.parse(expiresAt) > Date.parse(issuedAt),
    'grant.expires_at must be later than grant.issued_at');

  const branch = exactKeys(value.branch_scope, 'grant.branch_scope', [
    'base_ref', 'base_sha', 'head_ref',
  ]);
  const pullRequest = exactKeys(value.pull_request_scope, 'grant.pull_request_scope', [
    'head_ref', 'numbers',
  ]);
  const merge = exactKeys(value.merge_scope, 'grant.merge_scope', [
    'expected_base_sha', 'expected_head_sha', 'method', 'permitted', 'pr_number',
  ]);
  const reviewer = exactKeys(value.reviewer_freshness, 'grant.reviewer_freshness', [
    'allowed_reviewer_actor_refs', 'exact_head_required', 'independent_from_issuer_and_subject',
    'max_age_seconds', 'required_for_merge', 'required_verdict',
  ]);
  const rollback = exactKeys(value.rollback_recovery, 'grant.rollback_recovery', [
    'destructive_authorized', 'recovery_ref', 'strategy',
  ]);
  const revocation = exactKeys(value.revocation, 'grant.revocation', [
    'max_check_age_seconds', 'registry_ref', 'status_at_issue',
  ]);
  const replay = exactKeys(value.replay_protection, 'grant.replay_protection', [
    'audience', 'ledger_ref', 'mode', 'nonce',
  ]);

  assert(typeof merge.permitted === 'boolean', 'grant.merge_scope.permitted must be boolean');
  assert(typeof reviewer.required_for_merge === 'boolean'
    && typeof reviewer.exact_head_required === 'boolean'
    && typeof reviewer.independent_from_issuer_and_subject === 'boolean',
  'grant.reviewer_freshness boolean bindings are required');
  assert(merge.permitted === true
    ? merge.pr_number != null && merge.expected_head_sha != null
      && merge.expected_base_sha != null && merge.method != null
    : merge.pr_number == null && merge.expected_head_sha == null
      && merge.expected_base_sha == null && merge.method == null,
  'grant.merge_scope exact bindings must be present only when merge is permitted');
  assert(typeof rollback.destructive_authorized === 'boolean'
    && rollback.destructive_authorized === false,
  'grant cannot authorize destructive rollback');
  assert(revocation.status_at_issue === 'active',
    'grant.revocation.status_at_issue must be active');

  const normalized = {
    allowed_actions: normalizeAllowedActions(value.allowed_actions),
    branch_scope: {
      base_ref: branchRef(branch.base_ref, 'grant.branch_scope.base_ref'),
      base_sha: gitSha(branch.base_sha, 'grant.branch_scope.base_sha'),
      head_ref: branchRef(branch.head_ref, 'grant.branch_scope.head_ref'),
    },
    expires_at: expiresAt,
    grant_id: string(value.grant_id, 'grant.grant_id'),
    issued_at: issuedAt,
    issuer: normalizeActor(value.issuer, 'grant.issuer', ['actor_ref', 'authority_ref']),
    merge_scope: {
      expected_base_sha: nullable(merge.expected_base_sha,
        'grant.merge_scope.expected_base_sha', gitSha),
      expected_head_sha: nullable(merge.expected_head_sha,
        'grant.merge_scope.expected_head_sha', gitSha),
      method: nullable(merge.method, 'grant.merge_scope.method', (entry, field) => (
        oneOf(entry, field, ['merge', 'squash', 'rebase'])
      )),
      permitted: merge.permitted,
      pr_number: nullable(merge.pr_number, 'grant.merge_scope.pr_number', positiveInteger),
    },
    pull_request_scope: {
      head_ref: branchRef(pullRequest.head_ref, 'grant.pull_request_scope.head_ref'),
      numbers: sortedUnique(pullRequest.numbers, 'grant.pull_request_scope.numbers',
        positiveInteger, { allowEmpty: true }),
    },
    replay_protection: {
      audience: string(replay.audience, 'grant.replay_protection.audience'),
      ledger_ref: string(replay.ledger_ref, 'grant.replay_protection.ledger_ref'),
      mode: oneOf(replay.mode, 'grant.replay_protection.mode', ['single_use_per_action']),
      nonce: string(replay.nonce, 'grant.replay_protection.nonce'),
    },
    repository: normalizeRepository(value.repository, 'grant.repository'),
    revocation: {
      max_check_age_seconds: positiveInteger(revocation.max_check_age_seconds,
        'grant.revocation.max_check_age_seconds'),
      registry_ref: string(revocation.registry_ref, 'grant.revocation.registry_ref'),
      status_at_issue: 'active',
    },
    reviewer_freshness: {
      allowed_reviewer_actor_refs: sortedUnique(reviewer.allowed_reviewer_actor_refs,
        'grant.reviewer_freshness.allowed_reviewer_actor_refs'),
      exact_head_required: reviewer.exact_head_required,
      independent_from_issuer_and_subject: reviewer.independent_from_issuer_and_subject,
      max_age_seconds: positiveInteger(reviewer.max_age_seconds,
        'grant.reviewer_freshness.max_age_seconds'),
      required_for_merge: reviewer.required_for_merge,
      required_verdict: oneOf(reviewer.required_verdict,
        'grant.reviewer_freshness.required_verdict', ['approved']),
    },
    rollback_recovery: {
      destructive_authorized: false,
      recovery_ref: string(rollback.recovery_ref, 'grant.rollback_recovery.recovery_ref'),
      strategy: oneOf(rollback.strategy, 'grant.rollback_recovery.strategy',
        ['revert_or_forward_fix']),
    },
    schema_version: OR_AUTHORIZATION_GRANT_SCHEMA_VERSION,
    subject: normalizeActor(value.subject, 'grant.subject', ['orchestrator_ref', 'session_id']),
    task: normalizeTask(value.task, 'grant.task'),
  };

  assert(normalized.branch_scope.head_ref === normalized.pull_request_scope.head_ref,
    'grant branch and pull-request head refs must match');
  if (normalized.merge_scope.permitted) {
    assert(normalized.allowed_actions.some(({ effect, action }) => (
      effect === 'pull_request' && action === 'merge'
    )), 'grant.merge_scope requires an allowed merge action');
    assert(normalized.pull_request_scope.numbers.includes(normalized.merge_scope.pr_number),
      'grant.merge_scope.pr_number must be in pull_request_scope.numbers');
    assert(normalized.reviewer_freshness.required_for_merge
      && normalized.reviewer_freshness.exact_head_required
      && normalized.reviewer_freshness.independent_from_issuer_and_subject,
    'merge authorization requires fresh independent exact-head review');
  }
  return normalized;
}

function normalizeReview(value, field) {
  if (value == null) return null;
  const review = exactKeys(value, field, [
    'actor_ref', 'base_sha', 'pr_number', 'repository', 'review_ref', 'reviewed_at',
    'reviewed_head_sha', 'verdict',
  ]);
  return {
    actor_ref: string(review.actor_ref, `${field}.actor_ref`),
    base_sha: gitSha(review.base_sha, `${field}.base_sha`),
    pr_number: positiveInteger(review.pr_number, `${field}.pr_number`),
    repository: normalizeRepository(review.repository, `${field}.repository`),
    review_ref: string(review.review_ref, `${field}.review_ref`),
    reviewed_at: canonicalTimestamp(review.reviewed_at, `${field}.reviewed_at`),
    reviewed_head_sha: gitSha(review.reviewed_head_sha, `${field}.reviewed_head_sha`),
    verdict: oneOf(review.verdict, `${field}.verdict`, ['approved']),
  };
}

export function normalizeAuthorizationRequest(request) {
  const value = exactKeys(request, 'request', [
    'action', 'audience', 'branch', 'effect', 'merge', 'pull_request', 'replay_evidence',
    'repository', 'request_id', 'revocation_evidence', 'review', 'rollback', 'subject', 'task',
  ]);
  const effect = oneOf(value.effect, 'request.effect', Object.keys(OR_AUTHORIZED_EFFECT_ACTIONS));
  const action = oneOf(value.action, 'request.action', OR_AUTHORIZED_EFFECT_ACTIONS[effect]);
  const branch = exactKeys(value.branch, 'request.branch', [
    'base_ref', 'base_sha', 'head_ref', 'head_sha',
  ]);
  const pullRequest = exactKeys(value.pull_request, 'request.pull_request', ['head_ref', 'number']);
  const merge = exactKeys(value.merge, 'request.merge', [
    'expected_base_sha', 'expected_head_sha', 'method',
  ]);
  const rollback = exactKeys(value.rollback, 'request.rollback', ['destructive', 'strategy']);
  const revocation = exactKeys(value.revocation_evidence, 'request.revocation_evidence', [
    'checked_at', 'event_ref', 'grant_fingerprint', 'registry_ref', 'status',
  ]);
  const replay = exactKeys(value.replay_evidence, 'request.replay_evidence', [
    'action_key', 'checked_at', 'grant_fingerprint', 'ledger_ref', 'request_id', 'status',
  ]);
  assert(typeof rollback.destructive === 'boolean', 'request.rollback.destructive must be boolean');
  return {
    action,
    audience: string(value.audience, 'request.audience'),
    branch: {
      base_ref: branchRef(branch.base_ref, 'request.branch.base_ref'),
      base_sha: gitSha(branch.base_sha, 'request.branch.base_sha'),
      head_ref: branchRef(branch.head_ref, 'request.branch.head_ref'),
      head_sha: gitSha(branch.head_sha, 'request.branch.head_sha'),
    },
    effect,
    merge: {
      expected_base_sha: nullable(merge.expected_base_sha,
        'request.merge.expected_base_sha', gitSha),
      expected_head_sha: nullable(merge.expected_head_sha,
        'request.merge.expected_head_sha', gitSha),
      method: nullable(merge.method, 'request.merge.method', (entry, field) => (
        oneOf(entry, field, ['merge', 'squash', 'rebase'])
      )),
    },
    pull_request: {
      head_ref: branchRef(pullRequest.head_ref, 'request.pull_request.head_ref'),
      number: nullable(pullRequest.number, 'request.pull_request.number', positiveInteger),
    },
    replay_evidence: {
      action_key: string(replay.action_key, 'request.replay_evidence.action_key'),
      checked_at: canonicalTimestamp(replay.checked_at, 'request.replay_evidence.checked_at'),
      grant_fingerprint: sha256(replay.grant_fingerprint,
        'request.replay_evidence.grant_fingerprint'),
      ledger_ref: string(replay.ledger_ref, 'request.replay_evidence.ledger_ref'),
      request_id: string(replay.request_id, 'request.replay_evidence.request_id'),
      status: oneOf(replay.status, 'request.replay_evidence.status', ['unused', 'used']),
    },
    repository: normalizeRepository(value.repository, 'request.repository'),
    request_id: string(value.request_id, 'request.request_id'),
    revocation_evidence: {
      checked_at: canonicalTimestamp(revocation.checked_at,
        'request.revocation_evidence.checked_at'),
      event_ref: nullable(revocation.event_ref, 'request.revocation_evidence.event_ref', string),
      grant_fingerprint: sha256(revocation.grant_fingerprint,
        'request.revocation_evidence.grant_fingerprint'),
      registry_ref: string(revocation.registry_ref, 'request.revocation_evidence.registry_ref'),
      status: oneOf(revocation.status, 'request.revocation_evidence.status',
        ['active', 'revoked']),
    },
    review: normalizeReview(value.review, 'request.review'),
    rollback: {
      destructive: rollback.destructive,
      strategy: string(rollback.strategy, 'request.rollback.strategy'),
    },
    subject: normalizeActor(value.subject, 'request.subject', ['orchestrator_ref', 'session_id']),
    task: normalizeTask(value.task, 'request.task'),
  };
}

export function canonicalAuthorizationGrant(grant) {
  return canonicalAuthorizationJson(normalizeAuthorizationGrant(grant));
}

export function authorizationGrantFingerprint(grant) {
  return authorizationSha256(Buffer.from(canonicalAuthorizationGrant(grant), 'utf8'));
}

export function authorizationPolicyInput(grant, request) {
  let grantFingerprint;
  let normalizedRequest;
  try {
    grantFingerprint = authorizationGrantFingerprint(grant);
  } catch {
    grantFingerprint = rawFingerprint(grant);
  }
  try {
    normalizedRequest = normalizeAuthorizationRequest(request);
  } catch {
    normalizedRequest = {
      raw_request_fingerprint: rawFingerprint(request),
      validation_status: 'rejected',
    };
  }
  return {
    grant_fingerprint: grantFingerprint,
    request: normalizedRequest,
    schema_version: 'ao.or-authorization-policy-input.v1',
  };
}

export function authorizationPolicyInputFingerprint(grant, request) {
  return authorizationSha256(Buffer.from(canonicalAuthorizationJson(
    authorizationPolicyInput(grant, request),
  ), 'utf8'));
}

function hasForbiddenKey(value, matcher) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenKey(entry, matcher));
  return Object.entries(value).some(([key, entry]) => (
    matcher.test(key) || hasForbiddenKey(entry, matcher)
  ));
}

function rawFingerprint(value) {
  try {
    return authorizationSha256(Buffer.from(canonicalAuthorizationJson(value), 'utf8'));
  } catch {
    return '0'.repeat(64);
  }
}

function normalizedOrNull(value, field, normalizer) {
  try {
    return value == null ? null : normalizer(value, field);
  } catch {
    return null;
  }
}

function escalationRecord(grant, request, kind, reasonCode, now) {
  const createdAt = canonicalTimestamp(now, 'escalation.created_at');
  let grantFingerprint = rawFingerprint(grant);
  const inputFingerprint = authorizationPolicyInputFingerprint(grant, request);
  try {
    grantFingerprint = authorizationGrantFingerprint(grant);
  } catch {
    // Invalid authority receives a stable raw fingerprint without becoming authoritative.
  }
  const core = {
    created_at: createdAt,
    grant_fingerprint: grantFingerprint,
    policy_input_fingerprint: inputFingerprint,
    reason_code: reasonCode,
    reason_kind: kind,
    authorized_repository: normalizedOrNull(grant?.repository?.slug,
      'escalation.authorized_repository', repositorySlug),
    authorized_task_id: normalizedOrNull(grant?.task?.task_id,
      'escalation.authorized_task_id', string),
    recovery_ref: normalizedOrNull(grant?.rollback_recovery?.recovery_ref,
      'escalation.recovery_ref', string),
    requested_repository: normalizedOrNull(request?.repository?.slug,
      'escalation.requested_repository', repositorySlug),
    requested_task_id: normalizedOrNull(request?.task?.task_id,
      'escalation.requested_task_id', string),
    schema_version: OR_AUTHORIZATION_ESCALATION_SCHEMA_VERSION,
    status: 'human_authority_required',
  };
  const escalationId = `or-auth-escalation:${authorizationSha256(Buffer.from(
    canonicalAuthorizationJson(core), 'utf8',
  ))}`;
  return { ...core, escalation_id: escalationId };
}

function escalation(grant, request, kind, reasonCode, now) {
  return {
    decision: 'escalate',
    reason_code: reasonCode,
    escalation: escalationRecord(grant, request, kind, reasonCode, now),
  };
}

function denied(reasonCode, grantFingerprint = null, policyInputFingerprint = null) {
  return {
    decision: 'deny',
    grant_fingerprint: grantFingerprint,
    policy_input_fingerprint: policyInputFingerprint,
    reason_code: reasonCode,
  };
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateAuthorizationGrant(grant, request, {
  now = new Date().toISOString(),
} = {}) {
  canonicalTimestamp(now, 'evaluation.now');

  if (hasForbiddenKey({ grant, request }, /credential|secret|token|private.?key/i)) {
    return escalation(grant, request, 'security_or_credential_boundary',
      'security_or_credential_boundary_requested', now);
  }
  if (request?.rollback?.destructive === true
    || grant?.rollback_recovery?.destructive_authorized === true
    || ['delete', 'destroy', 'force_push'].includes(request?.action)) {
    return escalation(grant, request, 'destructive_migration_or_rollback',
      'destructive_effect_requested', now);
  }
  if (hasForbiddenKey({ grant, request }, /^(metadata|prompt|instructions?)$/i)) {
    return escalation(grant, request, 'authority_scope_expansion',
      'non_authoritative_scope_material_present', now);
  }

  let normalizedGrant;
  let normalizedRequest;
  try {
    normalizedGrant = normalizeAuthorizationGrant(grant);
  } catch (error) {
    return denied(error.code === 'mixed_version' ? 'mixed_grant_version' : 'invalid_grant');
  }
  const grantFingerprint = authorizationGrantFingerprint(normalizedGrant);
  try {
    normalizedRequest = normalizeAuthorizationRequest(request);
  } catch (error) {
    const actions = OR_AUTHORIZED_EFFECT_ACTIONS[request?.effect];
    if (!actions || !actions.includes(request?.action)) {
      return escalation(grant, request, 'authority_scope_expansion',
        'unsupported_effect_or_action', now);
    }
    return denied('invalid_or_missing_request', grantFingerprint);
  }
  const policyInputFingerprint = authorizationPolicyInputFingerprint(
    normalizedGrant, normalizedRequest,
  );
  const deny = (reason) => denied(reason, grantFingerprint, policyInputFingerprint);

  if (Date.parse(now) < Date.parse(normalizedGrant.issued_at)) return deny('grant_not_yet_valid');
  if (Date.parse(now) >= Date.parse(normalizedGrant.expires_at)) return deny('grant_expired');

  const revocation = normalizedRequest.revocation_evidence;
  if (revocation.registry_ref !== normalizedGrant.revocation.registry_ref
    || revocation.grant_fingerprint !== grantFingerprint) {
    return deny('revocation_registry_mismatch');
  }
  if (revocation.status === 'revoked') return deny('grant_revoked');
  const revocationAge = (Date.parse(now) - Date.parse(revocation.checked_at)) / 1000;
  if (revocationAge < 0
    || Date.parse(revocation.checked_at) < Date.parse(normalizedGrant.issued_at)
    || revocationAge > normalizedGrant.revocation.max_check_age_seconds) {
    return deny('revocation_evidence_stale');
  }

  const requestedActionKey = `${normalizedRequest.effect}:${normalizedRequest.action}`;
  const replay = normalizedRequest.replay_evidence;
  if (replay.ledger_ref !== normalizedGrant.replay_protection.ledger_ref
    || replay.grant_fingerprint !== grantFingerprint
    || replay.action_key !== requestedActionKey
    || replay.request_id !== normalizedRequest.request_id) {
    return deny('replay_evidence_binding_mismatch');
  }
  if (replay.status !== 'unused') return deny('grant_replay_detected');
  const replayAge = (Date.parse(now) - Date.parse(replay.checked_at)) / 1000;
  if (replayAge < 0) return deny('replay_evidence_from_future');
  if (Date.parse(replay.checked_at) < Date.parse(normalizedGrant.issued_at)
    || replayAge > normalizedGrant.revocation.max_check_age_seconds) {
    return deny('replay_evidence_stale');
  }

  for (const field of ['repository', 'task', 'subject']) {
    if (!same(normalizedGrant[field], normalizedRequest[field])) {
      return escalation(grant, request, 'authority_scope_expansion',
        `${field}_binding_mismatch`, now);
    }
  }
  const actionKey = `${normalizedRequest.effect}:${normalizedRequest.action}`;
  if (!normalizedGrant.allowed_actions.some(({ effect, action }) => (
    `${effect}:${action}` === actionKey
  ))) {
    return escalation(grant, request, 'authority_scope_expansion',
      'effect_action_not_granted', now);
  }
  if (normalizedRequest.audience !== normalizedGrant.replay_protection.audience) {
    return escalation(grant, request, 'authority_scope_expansion',
      'audience_binding_mismatch', now);
  }
  if (normalizedRequest.branch.base_ref !== normalizedGrant.branch_scope.base_ref
    || normalizedRequest.branch.base_sha !== normalizedGrant.branch_scope.base_sha
    || normalizedRequest.branch.head_ref !== normalizedGrant.branch_scope.head_ref
    || normalizedRequest.pull_request.head_ref !== normalizedGrant.pull_request_scope.head_ref) {
    return escalation(grant, request, 'authority_scope_expansion',
      'branch_binding_mismatch', now);
  }

  if (normalizedRequest.action === 'open') {
    if (normalizedRequest.pull_request.number != null) return deny('pr_open_requires_unassigned_number');
  } else if (normalizedRequest.effect === 'pull_request') {
    if (!normalizedGrant.pull_request_scope.numbers.includes(
      normalizedRequest.pull_request.number,
    )) {
      return escalation(grant, request, 'authority_scope_expansion',
        'pull_request_binding_mismatch', now);
    }
  }

  if (normalizedRequest.action === 'merge') {
    const expected = normalizedGrant.merge_scope;
    if (!expected.permitted
      || normalizedRequest.pull_request.number !== expected.pr_number
      || normalizedRequest.merge.method !== expected.method
      || normalizedRequest.merge.expected_head_sha !== expected.expected_head_sha
      || normalizedRequest.merge.expected_base_sha !== expected.expected_base_sha
      || normalizedRequest.branch.head_sha !== expected.expected_head_sha) {
      return escalation(grant, request, 'irreversible_effect_ambiguity',
        'merge_exact_scope_mismatch', now);
    }
    const review = normalizedRequest.review;
    if (review == null) return deny('fresh_independent_review_missing');
    if (review.verdict !== normalizedGrant.reviewer_freshness.required_verdict
      || review.reviewed_head_sha !== expected.expected_head_sha
      || review.base_sha !== expected.expected_base_sha
      || review.pr_number !== expected.pr_number
      || !same(review.repository, normalizedGrant.repository)) {
      return deny('review_does_not_cover_exact_head');
    }
    if (!normalizedGrant.reviewer_freshness.allowed_reviewer_actor_refs
      .includes(review.actor_ref)) return deny('reviewer_not_authorized');
    if (review.actor_ref === normalizedGrant.issuer.actor_ref
      || review.actor_ref === normalizedGrant.subject.orchestrator_ref) {
      return deny('reviewer_not_independent');
    }
    const reviewAge = (Date.parse(now) - Date.parse(review.reviewed_at)) / 1000;
    if (reviewAge < 0 || reviewAge > normalizedGrant.reviewer_freshness.max_age_seconds) {
      return deny('review_not_fresh');
    }
  } else if (normalizedRequest.merge.method != null
    || normalizedRequest.merge.expected_head_sha != null
    || normalizedRequest.merge.expected_base_sha != null) {
    return escalation(grant, request, 'authority_scope_expansion',
      'merge_scope_attached_to_non_merge_action', now);
  }

  if (normalizedRequest.rollback.destructive) {
    return escalation(grant, request, 'destructive_migration_or_rollback',
      'destructive_effect_requested', now);
  }
  if (normalizedRequest.rollback.strategy !== normalizedGrant.rollback_recovery.strategy) {
    return escalation(grant, request, 'irreversible_effect_ambiguity',
      'rollback_recovery_binding_mismatch', now);
  }

  return {
    decision: 'authorize',
    grant_fingerprint: grantFingerprint,
    policy_input_fingerprint: policyInputFingerprint,
    reason_code: 'exact_scope_authorized',
  };
}

export function normalizeAuthorizationEscalation(record) {
  const value = exactKeys(record, 'escalation', [
    'authorized_repository', 'authorized_task_id', 'created_at', 'escalation_id',
    'grant_fingerprint', 'policy_input_fingerprint', 'reason_code', 'reason_kind',
    'recovery_ref', 'requested_repository', 'requested_task_id', 'schema_version', 'status',
  ]);
  assert(value.schema_version === OR_AUTHORIZATION_ESCALATION_SCHEMA_VERSION,
    `Unsupported OR authorization escalation schema: ${String(value.schema_version)}`);
  assert(OR_AUTHORIZATION_ESCALATION_KINDS.includes(value.reason_kind),
    `Unsupported escalation reason_kind: ${String(value.reason_kind)}`);
  const normalized = {
    authorized_repository: nullable(value.authorized_repository,
      'escalation.authorized_repository', repositorySlug),
    authorized_task_id: nullable(value.authorized_task_id,
      'escalation.authorized_task_id', string),
    created_at: canonicalTimestamp(value.created_at, 'escalation.created_at'),
    escalation_id: string(value.escalation_id, 'escalation.escalation_id'),
    grant_fingerprint: sha256(value.grant_fingerprint, 'escalation.grant_fingerprint'),
    policy_input_fingerprint: sha256(value.policy_input_fingerprint,
      'escalation.policy_input_fingerprint'),
    reason_code: string(value.reason_code, 'escalation.reason_code'),
    reason_kind: value.reason_kind,
    recovery_ref: nullable(value.recovery_ref, 'escalation.recovery_ref', string),
    requested_repository: nullable(value.requested_repository,
      'escalation.requested_repository', repositorySlug),
    requested_task_id: nullable(value.requested_task_id,
      'escalation.requested_task_id', string),
    schema_version: OR_AUTHORIZATION_ESCALATION_SCHEMA_VERSION,
    status: oneOf(value.status, 'escalation.status', ['human_authority_required']),
  };
  const { escalation_id: ignored, ...core } = normalized;
  const expected = `or-auth-escalation:${authorizationSha256(Buffer.from(
    canonicalAuthorizationJson(core), 'utf8',
  ))}`;
  assert(normalized.escalation_id === expected,
    'escalation.escalation_id does not match canonical record content');
  return normalized;
}
