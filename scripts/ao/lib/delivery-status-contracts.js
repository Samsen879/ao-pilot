import { createHash } from 'node:crypto';

import { normalizeGitHubMergeObservation } from './or-merge-protocol.js';

export const DELIVERY_STATUS_TRANSITION_SCHEMA_VERSION = 'ao.delivery-status-transition.v1';
export const DOCUMENTATION_TRIGGER_SCHEMA_VERSION = 'ao.documentation-trigger-projection.v1';
export const DELIVERY_STATUSES = Object.freeze([
  'review_passed',
  'integrated',
  'abandoned',
]);
export const DOCUMENTATION_STATUSES = Object.freeze([
  'documentation_pending',
  'documented',
]);
export const DELIVERY_STATUS_TRANSITIONS = Object.freeze({
  none: Object.freeze(['abandoned', 'integrated', 'review_passed']),
  review_passed: Object.freeze(['abandoned', 'integrated', 'review_passed']),
  integrated: Object.freeze(['integrated']),
  abandoned: Object.freeze(['abandoned']),
});

const GIT_SHA = /^[0-9a-f]{40}$/;

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(String(left), 'utf8'), Buffer.from(String(right), 'utf8'));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareStrings)
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalDeliveryStatusJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

function fingerprint(value) {
  return createHash('sha256').update(canonicalDeliveryStatusJson(value)).digest('hex');
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) return null;
  const normalized = values.map((value) => (
    typeof value === 'string' && value.trim() === value && value !== '' && !/\s/.test(value)
      ? value
      : null
  ));
  if (normalized.some((value) => value == null) || new Set(normalized).size !== normalized.length) {
    return null;
  }
  return normalized.sort(compareStrings);
}

function finding(code, { fields = [], details = [] } = {}) {
  return {
    code,
    severity: 'blocker',
    fields: [...new Set(fields)].sort(compareStrings),
    details: [...new Set(details.map(String))].sort(compareStrings),
  };
}

function sortFindings(findings) {
  return findings.sort((left, right) => (
    compareStrings(left.code, right.code)
    || compareStrings(left.fields.join(','), right.fields.join(','))
    || compareStrings(left.details.join(','), right.details.join(','))
  ));
}

function normalizeStatus(value) {
  return DELIVERY_STATUSES.includes(value) ? value : null;
}

function normalizeUnresolvedItems(items, findings) {
  if (!Array.isArray(items)) {
    findings.push(finding('delivery_abandoned_custody_missing', {
      fields: ['unresolved_items'],
      details: ['unresolved_items must be an array'],
    }));
    return [];
  }
  const normalized = [];
  for (const [index, item] of items.entries()) {
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const summary = typeof item?.summary === 'string' ? item.summary.trim() : '';
    const evidenceRefs = uniqueStrings(item?.evidence_refs);
    if (!id || !summary || evidenceRefs == null || evidenceRefs.length === 0) {
      findings.push(finding('delivery_abandoned_custody_invalid', {
        fields: [`unresolved_items[${index}]`],
        details: ['each unresolved item requires id, summary, and evidence_refs'],
      }));
      continue;
    }
    normalized.push({ id, summary, evidence_refs: evidenceRefs });
  }
  normalized.sort((left, right) => compareStrings(left.id, right.id));
  if (new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    findings.push(finding('delivery_abandoned_custody_duplicate', {
      fields: ['unresolved_items'],
    }));
  }
  return normalized;
}

function validateReviewEvidence({ headSha, reviewRefs }, findings) {
  const normalizedReviewRefs = uniqueStrings(reviewRefs);
  if (!GIT_SHA.test(headSha ?? '')) {
    findings.push(finding('delivery_review_head_missing', { fields: ['head_sha'] }));
  }
  if (normalizedReviewRefs == null || normalizedReviewRefs.length === 0) {
    findings.push(finding('delivery_review_pass_evidence_missing', {
      fields: ['review_refs'],
      details: ['Worker completion or local Git state is not review PASS evidence'],
    }));
  }
  return normalizedReviewRefs ?? [];
}

function validateProviderMerge({
  providerBinding,
  providerMergeObservation,
  prNumber,
  baseSha,
  headSha,
  mergeSha,
  mergeObservationRef,
}, findings) {
  const normalized = normalizeGitHubMergeObservation(providerMergeObservation);
  for (const code of normalized.reason_codes) {
    findings.push(finding(`delivery_${code}`, { fields: ['provider_merge_observation'] }));
  }
  const observation = normalized.observation;
  if (providerBinding == null || typeof providerBinding !== 'object') {
    findings.push(finding('delivery_provider_binding_missing', { fields: ['provider_binding'] }));
    return null;
  }
  if (providerBinding.provider !== 'github') {
    findings.push(finding('delivery_provider_not_github', { fields: ['provider_binding.provider'] }));
  }
  const expectedBindingKeys = [
    'base_ref', 'base_sha', 'pr_number', 'provider', 'repository_id', 'slug',
  ];
  if (Object.keys(providerBinding).some((key) => !expectedBindingKeys.includes(key))) {
    findings.push(finding('delivery_provider_binding_unknown_field', {
      fields: ['provider_binding'],
    }));
  }
  if (!Number.isSafeInteger(providerBinding.repository_id) || providerBinding.repository_id <= 0
    || typeof providerBinding.slug !== 'string' || providerBinding.slug.trim() === ''
    || providerBinding.slug !== providerBinding.slug.trim() || /\s/.test(providerBinding.slug)
    || !Number.isSafeInteger(providerBinding.pr_number) || providerBinding.pr_number <= 0
    || typeof providerBinding.base_ref !== 'string' || providerBinding.base_ref.trim() === ''
    || providerBinding.base_ref !== providerBinding.base_ref.trim()
    || /\s/.test(providerBinding.base_ref)
    || !GIT_SHA.test(providerBinding.base_sha ?? '')) {
    findings.push(finding('delivery_provider_binding_invalid', { fields: ['provider_binding'] }));
  }
  if (!observation) return null;
  if (providerMergeObservation.source_ok === true && providerMergeObservation.source_error != null) {
    findings.push(finding('delivery_provider_observation_contradictory', {
      fields: [
        'provider_merge_observation.source_error',
        'provider_merge_observation.source_ok',
      ],
    }));
  }
  if (observation.repository.repository_id !== providerBinding.repository_id
    || observation.repository.slug !== providerBinding.slug) {
    findings.push(finding('delivery_provider_repository_mismatch', {
      fields: ['provider_merge_observation.repository'],
    }));
  }
  if (observation.pull_request.number !== providerBinding.pr_number) {
    findings.push(finding('delivery_provider_pull_request_mismatch', {
      fields: ['provider_merge_observation.pull_request.number'],
    }));
  }
  if (providerBinding.pr_number !== prNumber) {
    findings.push(finding('delivery_record_pull_request_mismatch', {
      fields: ['pr_number', 'provider_binding.pr_number'],
    }));
  }
  if (providerBinding.base_sha !== baseSha
    || observation.pull_request.base_ref !== providerBinding.base_ref
    || observation.pull_request.base_sha !== providerBinding.base_sha) {
    findings.push(finding('delivery_provider_base_drift', {
      fields: [
        'base_sha',
        'provider_binding.base_sha',
        'provider_merge_observation.pull_request.base_sha',
      ],
    }));
  }
  if (observation.pull_request.state !== 'MERGED') {
    findings.push(finding('delivery_provider_merge_not_confirmed', {
      fields: ['provider_merge_observation.pull_request.state'],
    }));
  }
  if (observation.pull_request.merged_at != null
    && observation.observed_at != null
    && Date.parse(observation.pull_request.merged_at) > Date.parse(observation.observed_at)) {
    findings.push(finding('delivery_provider_observation_predates_merge', {
      fields: [
        'provider_merge_observation.observed_at',
        'provider_merge_observation.pull_request.merged_at',
      ],
    }));
  }
  if (observation.pull_request.head_sha !== headSha) {
    findings.push(finding('delivery_provider_head_drift', {
      fields: ['provider_merge_observation.pull_request.head_sha', 'head_sha'],
    }));
  }
  if (observation.pull_request.merge_commit_sha !== mergeSha) {
    findings.push(finding('delivery_provider_merge_sha_mismatch', {
      fields: ['provider_merge_observation.pull_request.merge_commit_sha', 'merge_sha'],
    }));
  }
  if (!observation.evidence_refs?.includes(mergeObservationRef)) {
    findings.push(finding('delivery_provider_observation_ref_mismatch', {
      fields: ['merge_observation_ref', 'provider_merge_observation.evidence_refs'],
    }));
  }
  return observation;
}

export function projectDocumentationTrigger({
  deliveryStatus,
  documentationEvidenceRefs = [],
} = {}) {
  const normalizedStatus = normalizeStatus(deliveryStatus);
  const evidenceRefs = uniqueStrings(documentationEvidenceRefs);
  const findings = [];
  if (normalizedStatus == null) {
    findings.push(finding('documentation_delivery_status_invalid', {
      fields: ['delivery_status'],
    }));
  }
  if (evidenceRefs == null) {
    findings.push(finding('documentation_evidence_invalid', {
      fields: ['documentation_evidence_refs'],
    }));
  }
  const eligible = normalizedStatus != null && findings.length === 0;
  const documented = eligible && evidenceRefs.length > 0;
  const core = {
    schema_version: DOCUMENTATION_TRIGGER_SCHEMA_VERSION,
    eligible,
    trigger: eligible ? 'completion_record_documentation' : null,
    documentation_status: eligible
      ? (documented ? 'documented' : 'documentation_pending')
      : null,
    produced: documented,
    evidence_refs: evidenceRefs ?? [],
    findings: sortFindings(findings),
  };
  return { ...core, projection_fingerprint: fingerprint(core) };
}

export function evaluateDeliveryStatusTransition({
  previousStatus = null,
  requestedStatus,
  prNumber = null,
  baseSha = null,
  headSha = null,
  mergeSha = null,
  reviewRefs = [],
  mergeObservationRef = null,
  unresolvedItems = [],
  previousUnresolvedItems = [],
  abandonmentReason = null,
  providerBinding = null,
  providerMergeObservation = null,
  documentationEvidenceRefs = [],
  ...unsupportedInput
} = {}) {
  const findings = [];
  if (Object.keys(unsupportedInput).length > 0) {
    findings.push(finding('delivery_transition_unknown_field', {
      fields: Object.keys(unsupportedInput),
    }));
  }
  const fromStatus = previousStatus == null ? null : normalizeStatus(previousStatus);
  const targetStatus = normalizeStatus(requestedStatus);
  if (previousStatus != null && fromStatus == null) {
    findings.push(finding('delivery_previous_status_invalid', { fields: ['previous_status'] }));
  }
  if (targetStatus == null) {
    findings.push(finding('delivery_requested_status_invalid', { fields: ['requested_status'] }));
  }
  if (targetStatus != null && !DELIVERY_STATUS_TRANSITIONS[fromStatus ?? 'none'].includes(targetStatus)) {
    findings.push(finding('delivery_transition_invalid', {
      fields: ['previous_status', 'requested_status'],
      details: [`${fromStatus ?? 'none'} -> ${targetStatus}`],
    }));
  }

  let reviewEvidenceRefs = [];
  let providerObservation = null;
  let unresolvedCustody = [];
  if (targetStatus === 'review_passed' || targetStatus === 'integrated') {
    reviewEvidenceRefs = validateReviewEvidence({ headSha, reviewRefs }, findings);
  }
  if (targetStatus === 'integrated') {
    if (!GIT_SHA.test(mergeSha ?? '') || typeof mergeObservationRef !== 'string'
      || mergeObservationRef.trim() === '' || /\s/.test(mergeObservationRef)) {
      findings.push(finding('delivery_provider_merge_evidence_missing', {
        fields: ['merge_sha', 'merge_observation_ref'],
      }));
    }
    providerObservation = validateProviderMerge({
      providerBinding,
      providerMergeObservation,
      prNumber,
      baseSha,
      headSha,
      mergeSha,
      mergeObservationRef,
    }, findings);
  }
  if (targetStatus === 'abandoned') {
    if (typeof abandonmentReason !== 'string' || abandonmentReason.trim() === '') {
      findings.push(finding('delivery_abandonment_reason_missing', {
        fields: ['abandonment_reason'],
      }));
    }
    unresolvedCustody = normalizeUnresolvedItems(unresolvedItems, findings);
    if (unresolvedCustody.length === 0) {
      findings.push(finding('delivery_abandoned_custody_missing', {
        fields: ['unresolved_items'],
      }));
    }
  }

  const previousUnresolvedCustody = fromStatus === 'abandoned'
    ? normalizeUnresolvedItems(previousUnresolvedItems, findings)
    : [];
  const sortedFindings = sortFindings(findings);
  const accepted = sortedFindings.length === 0;
  const documentation = projectDocumentationTrigger({
    deliveryStatus: accepted ? targetStatus : null,
    documentationEvidenceRefs,
  });
  const core = {
    schema_version: DELIVERY_STATUS_TRANSITION_SCHEMA_VERSION,
    accepted,
    from_status: fromStatus,
    requested_status: targetStatus,
    delivery_status: accepted ? targetStatus : fromStatus,
    worker_terminal: accepted,
    provider_integrated: accepted && targetStatus === 'integrated',
    review_evidence_refs: reviewEvidenceRefs,
    provider_merge_binding: accepted && targetStatus === 'integrated' ? {
      provider: 'github',
      repository_id: providerObservation.repository.repository_id,
      repository_slug: providerObservation.repository.slug,
      pr_number: providerObservation.pull_request.number,
      observed_head_sha: providerObservation.pull_request.head_sha,
      merge_sha: providerObservation.pull_request.merge_commit_sha,
      observed_at: providerObservation.observed_at,
      evidence_refs: providerObservation.evidence_refs,
    } : null,
    abandonment: accepted && targetStatus === 'abandoned' ? {
      reason: abandonmentReason.trim(),
      unresolved_custody: unresolvedCustody,
    } : null,
    retained_unresolved_custody: !accepted && fromStatus === 'abandoned'
      ? previousUnresolvedCustody
      : [],
    documentation,
    findings: sortedFindings,
  };
  return { ...core, transition_fingerprint: fingerprint(core) };
}

export class DeliveryStatusTransitionError extends Error {
  constructor(projection) {
    super(`Delivery status transition rejected: ${projection.findings.map((item) => item.code).join(', ')}`);
    this.name = 'DeliveryStatusTransitionError';
    this.code = 'DELIVERY_STATUS_TRANSITION_REJECTED';
    this.findings = projection.findings;
    this.projection = projection;
  }
}
