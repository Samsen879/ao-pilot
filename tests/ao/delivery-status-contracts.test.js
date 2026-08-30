import { describe, expect, it } from '@jest/globals';

import {
  DELIVERY_STATUS_TRANSITIONS,
  canonicalDeliveryStatusJson,
  evaluateDeliveryStatusTransition,
  projectDocumentationTrigger,
} from '../../scripts/ao/lib/delivery-status-contracts.js';

const BASE_SHA = '1'.repeat(40);
const HEAD_SHA = '2'.repeat(40);
const MERGE_SHA = '3'.repeat(40);
const MERGE_REF = `github:snapshot/pull/79@sha256:${'4'.repeat(64)}`;

function providerBinding(overrides = {}) {
  return {
    provider: 'github',
    repository_id: 1001,
    slug: 'Samsen879/ao-pilot',
    pr_number: 79,
    base_ref: 'main',
    base_sha: BASE_SHA,
    ...overrides,
  };
}

function mergeObservation(overrides = {}) {
  const observation = {
    schema_version: 'ao.github-merge-observation.v1',
    provider: 'github',
    source_ok: true,
    source_error: null,
    observed_at: '2026-08-31T00:10:00.000Z',
    repository: {
      repository_id: 1001,
      slug: 'Samsen879/ao-pilot',
    },
    pull_request: {
      number: 79,
      state: 'MERGED',
      base_ref: 'main',
      base_sha: BASE_SHA,
      head_sha: HEAD_SHA,
      merge_commit_sha: MERGE_SHA,
      merged_at: '2026-08-31T00:09:00.000Z',
      url: 'https://github.com/Samsen879/ao-pilot/pull/79',
    },
    evidence_refs: [MERGE_REF],
  };
  return {
    ...observation,
    ...overrides,
    repository: { ...observation.repository, ...(overrides.repository ?? {}) },
    pull_request: { ...observation.pull_request, ...(overrides.pull_request ?? {}) },
  };
}

function reviewPassed(overrides = {}) {
  return evaluateDeliveryStatusTransition({
    requestedStatus: 'review_passed',
    prNumber: 79,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    reviewRefs: ['github:pull/79/reviews/1'],
    ...overrides,
  });
}

function integrated(overrides = {}) {
  return evaluateDeliveryStatusTransition({
    previousStatus: 'review_passed',
    requestedStatus: 'integrated',
    prNumber: 79,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeSha: MERGE_SHA,
    reviewRefs: ['github:pull/79/reviews/1'],
    mergeObservationRef: MERGE_REF,
    providerBinding: providerBinding(),
    providerMergeObservation: mergeObservation(),
    ...overrides,
  });
}

function findingCodes(result) {
  return result.findings.map((item) => item.code);
}

describe('delivery status transition and documentation projections', () => {
  it('declares the complete transition matrix and keeps review PASS distinct from integration', () => {
    expect(DELIVERY_STATUS_TRANSITIONS).toEqual({
      none: ['abandoned', 'integrated', 'review_passed'],
      review_passed: ['abandoned', 'integrated', 'review_passed'],
      integrated: ['integrated'],
      abandoned: ['abandoned'],
    });

    const reviewed = reviewPassed();
    expect(reviewed).toMatchObject({
      accepted: true,
      delivery_status: 'review_passed',
      provider_integrated: false,
    });
    expect(reviewed).not.toHaveProperty('worker_terminal');
    expect(reviewed.documentation).toMatchObject({
      eligible: true,
      documentation_status: 'documentation_pending',
      produced: false,
    });

    const merged = integrated();
    expect(merged).toMatchObject({
      accepted: true,
      from_status: 'review_passed',
      delivery_status: 'integrated',
      provider_integrated: true,
      provider_merge_binding: {
        repository_id: 1001,
        repository_slug: 'Samsen879/ao-pilot',
        pr_number: 79,
        observed_head_sha: HEAD_SHA,
        merge_sha: MERGE_SHA,
      },
    });
  });

  it('does not promote Worker completion, local Git state, or review PASS to integration', () => {
    const workerOnly = reviewPassed({ reviewRefs: [] });
    expect(workerOnly.accepted).toBe(false);
    expect(findingCodes(workerOnly)).toContain('delivery_review_pass_evidence_missing');

    const localOnly = integrated({
      providerBinding: null,
      providerMergeObservation: null,
    });
    expect(localOnly.accepted).toBe(false);
    expect(findingCodes(localOnly)).toEqual(expect.arrayContaining([
      'delivery_provider_binding_missing',
      'delivery_provider_observation_missing',
    ]));
    expect(localOnly.delivery_status).toBe('review_passed');
    expect(localOnly.provider_integrated).toBe(false);
  });

  it.each([
    ['repository identity', { repository: { repository_id: 2002 } }, 'delivery_provider_repository_mismatch'],
    ['pull request identity', { pull_request: { number: 80 } }, 'delivery_provider_pull_request_mismatch'],
    ['merged state', { pull_request: { state: 'OPEN', merge_commit_sha: null, merged_at: null } }, 'delivery_provider_merge_not_confirmed'],
    ['observed HEAD', { pull_request: { head_sha: '5'.repeat(40) } }, 'delivery_provider_head_drift'],
    ['merge SHA', { pull_request: { merge_commit_sha: '6'.repeat(40) } }, 'delivery_provider_merge_sha_mismatch'],
    ['base HEAD', { pull_request: { base_sha: '7'.repeat(40) } }, 'delivery_provider_base_drift'],
    ['source health', { source_error: 'provider timeout' }, 'delivery_provider_observation_contradictory'],
    ['observation chronology', { observed_at: '2026-08-31T00:08:00.000Z' }, 'delivery_provider_observation_predates_merge'],
  ])('fails closed on contradictory provider %s evidence', (_label, overrides, code) => {
    const result = integrated({ providerMergeObservation: mergeObservation(overrides) });
    expect(result.accepted).toBe(false);
    expect(findingCodes(result)).toContain(code);
  });

  it('returns structured findings for unsupported transition inputs', () => {
    const result = reviewPassed({
      worker_done: true,
      local_git_merged: true,
    });
    expect(result.accepted).toBe(false);
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: 'delivery_transition_unknown_field',
      fields: ['local_git_merged', 'worker_done'],
    }));
  });

  it('requires an abandonment reason and evidence-bound unresolved custody', () => {
    const abandoned = evaluateDeliveryStatusTransition({
      requestedStatus: 'abandoned',
      abandonmentReason: 'Provider execution never reached diagnostics.',
      unresolvedItems: [{
        id: 'provider-retry',
        summary: 'Provider execution remains unresolved.',
        evidence_refs: ['github:actions/runs/123'],
      }],
    });
    expect(abandoned).toMatchObject({
      accepted: true,
      delivery_status: 'abandoned',
      abandonment: {
        reason: 'Provider execution never reached diagnostics.',
        unresolved_custody: [{ id: 'provider-retry' }],
      },
    });

    const missing = evaluateDeliveryStatusTransition({ requestedStatus: 'abandoned' });
    expect(missing.accepted).toBe(false);
    expect(findingCodes(missing)).toEqual(expect.arrayContaining([
      'delivery_abandonment_reason_missing',
      'delivery_abandoned_custody_missing',
    ]));
  });

  it('rejects retry out of abandoned and retains the prior unresolved custody projection', () => {
    const priorCustody = [{
      id: 'provider-retry',
      summary: 'Provider execution remains unresolved.',
      evidence_refs: ['github:actions/runs/123'],
    }];
    const retry = reviewPassed({
      previousStatus: 'abandoned',
      previousUnresolvedItems: priorCustody,
    });
    expect(retry.accepted).toBe(false);
    expect(findingCodes(retry)).toContain('delivery_transition_invalid');
    expect(retry.delivery_status).toBe('abandoned');
    expect(retry.retained_unresolved_custody).toEqual(priorCustody);
  });

  it.each([
    ['missing', []],
    ['malformed', [{ id: 'provider-retry', summary: '', evidence_refs: [] }]],
  ])('fails closed on abandoned retry with %s prior custody and claims no retained custody', (
    _label,
    previousUnresolvedItems,
  ) => {
    const retry = reviewPassed({
      previousStatus: 'abandoned',
      previousUnresolvedItems,
    });
    expect(retry.accepted).toBe(false);
    expect(findingCodes(retry)).toEqual(expect.arrayContaining([
      'delivery_transition_invalid',
      'delivery_abandoned_custody_missing',
    ]));
    expect(retry.delivery_status).toBe('abandoned');
    expect(retry.retained_unresolved_custody).toEqual([]);
  });

  it('projects documentation eligibility separately from produced evidence', () => {
    const pending = projectDocumentationTrigger({ deliveryStatus: 'integrated' });
    const documented = projectDocumentationTrigger({
      deliveryStatus: 'integrated',
      documentationEvidenceRefs: ['artifact:completion/issue-29@sha256:abc'],
    });
    expect(pending).toMatchObject({
      eligible: true,
      documentation_status: 'documentation_pending',
      produced: false,
      evidence_refs: [],
    });
    expect(documented).toMatchObject({
      eligible: true,
      documentation_status: 'documented',
      produced: true,
      evidence_refs: ['artifact:completion/issue-29@sha256:abc'],
    });
  });

  it('replays deterministically across evidence ordering', () => {
    const first = integrated({
      reviewRefs: ['github:pull/79/reviews/2', 'github:pull/79/reviews/1'],
      providerMergeObservation: mergeObservation({
        evidence_refs: ['github:pull/79', MERGE_REF],
      }),
      documentationEvidenceRefs: ['artifact:z', 'artifact:a'],
    });
    const replay = integrated({
      reviewRefs: ['github:pull/79/reviews/1', 'github:pull/79/reviews/2'],
      providerMergeObservation: mergeObservation({
        evidence_refs: [MERGE_REF, 'github:pull/79'],
      }),
      documentationEvidenceRefs: ['artifact:a', 'artifact:z'],
    });
    expect(canonicalDeliveryStatusJson(replay)).toBe(canonicalDeliveryStatusJson(first));
    expect(replay.transition_fingerprint).toBe(first.transition_fingerprint);
  });
});
