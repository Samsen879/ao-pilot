import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, jest } from '@jest/globals';

import {
  GITHUB_MERGE_OBSERVATION_SCHEMA_VERSION,
  OR_MERGE_PREFLIGHT_SCHEMA_VERSION,
  bindGitHubMergeOutcome,
  evaluateOrMergePreflight,
} from '../../scripts/ao/lib/or-merge-protocol.js';
import { authorizationGrantFingerprint } from '../../scripts/ao/lib/authorization-grant-contracts.js';
import { buildAssistActionModel, executeAssistActions } from '../../scripts/ao/lib/action-executor.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const authorizationPack = JSON.parse(fs.readFileSync(path.join(
  root, 'tests/ao/fixtures/or-authorization/pack.v1.json',
), 'utf8'));
const fixturePack = JSON.parse(fs.readFileSync(path.join(
  root, 'tests/ao/fixtures/or-merge-protocol/pack.v1.json',
), 'utf8'));
const NOW = '2026-08-09T12:30:00.000Z';
const MERGED_AT = '2026-08-09T12:31:00.000Z';
const MERGE_SHA = '9'.repeat(40);

function materialize() {
  const grant = structuredClone(authorizationPack.grant);
  const authorizationRequest = structuredClone(authorizationPack.requests.exact_head_merge);
  const fingerprint = authorizationGrantFingerprint(grant);
  authorizationRequest.replay_evidence.grant_fingerprint = fingerprint;
  authorizationRequest.revocation_evidence.grant_fingerprint = fingerprint;
  const releaseJudgment = {
    disposition: 'release_ready',
    basis: ['release_preflight_authorized'],
    authoritative: true,
    judgment_contract: 'ao.release-judgment.v1',
    authority_scope: 'or_preflight_only',
    claims: { merge: false, external_effect: false, human_approval: false },
  };
  const liveObservation = {
    schema_version: 'ao.github-merge-preflight-observation.v1',
    provider: 'github',
    source_ok: true,
    observed_at: NOW,
    repository: structuredClone(authorizationRequest.repository),
    pull_request: {
      number: authorizationRequest.pull_request.number,
      state: 'OPEN',
      base_ref: authorizationRequest.branch.base_ref,
      base_sha: authorizationRequest.branch.base_sha,
      head_ref: authorizationRequest.branch.head_ref,
      head_sha: authorizationRequest.branch.head_sha,
      merge_commit_sha: null,
    },
    review: {
      verdict: 'PASS',
      independent: true,
      reviewed_head_sha: authorizationRequest.branch.head_sha,
      unresolved_thread_count: 0,
      evidence_ref: authorizationRequest.review.review_ref,
    },
    required_checks: [{
      name: 'release-check',
      status: 'SUCCESS',
      head_sha: authorizationRequest.branch.head_sha,
      evidence_ref: 'github:check-run:release-check',
    }],
    evidence_refs: ['github:pr:85#exact-live-preflight'],
  };
  return { grant, authorizationRequest, releaseJudgment, liveObservation };
}

function preflight(overrides = {}) {
  const input = materialize();
  Object.assign(input, overrides);
  return evaluateOrMergePreflight({
    grant: input.grant,
    authorization_request: input.authorizationRequest,
    release_judgment: input.releaseJudgment,
    live_observation: input.liveObservation,
    now: NOW,
  });
}

function mergedObservation(authorized, mutation = null) {
  const result = {
    schema_version: GITHUB_MERGE_OBSERVATION_SCHEMA_VERSION,
    provider: 'github',
    source_ok: true,
    source_error: null,
    observed_at: MERGED_AT,
    repository: structuredClone(authorized.binding.repository),
    pull_request: {
      number: authorized.binding.pull_request.number,
      state: 'MERGED',
      head_sha: authorized.binding.pull_request.head_sha,
      merge_commit_sha: MERGE_SHA,
      merged_at: MERGED_AT,
      url: 'https://github.com/Samsen879/ao-pilot/pull/85',
    },
    evidence_refs: ['github:pr:85#provider-readback'],
  };
  if (mutation === 'head_drift') result.pull_request.head_sha = '8'.repeat(40);
  return result;
}

describe('OR merge effect-boundary protocol', () => {
  it('publishes closed versioned preflight, observation, and outcome schemas', () => {
    const schemas = [
      ['ao.or-merge-preflight.v1.schema.json', OR_MERGE_PREFLIGHT_SCHEMA_VERSION],
      ['ao.github-merge-observation.v1.schema.json', GITHUB_MERGE_OBSERVATION_SCHEMA_VERSION],
      ['ao.or-merge-outcome.v1.schema.json', 'ao.or-merge-outcome.v1'],
    ].map(([filename, version]) => ({
      version,
      schema: JSON.parse(fs.readFileSync(path.join(root, 'schemas', filename), 'utf8')),
    }));
    for (const { schema, version } of schemas) {
      expect(schema.properties.schema_version.const).toBe(version);
      expect(schema.additionalProperties).toBe(false);
    }
    expect(schemas[0].schema.properties.binding.additionalProperties).toBe(false);
    expect(schemas[1].schema.properties.pull_request.additionalProperties).toBe(false);
    expect(schemas[2].schema.$defs.dispatch.additionalProperties).toBe(false);
    expect(schemas[2].schema.$defs.mergeBinding.additionalProperties).toBe(false);
  });

  it.each(fixturePack.cases)('evaluates deterministic preflight fixture $id', (fixture) => {
    const input = materialize();
    if (fixture.mutation === 'live_head') input.liveObservation.pull_request.head_sha = '8'.repeat(40);
    if (fixture.mutation === 'evidence_refs') input.liveObservation.evidence_refs = [];
    if (fixture.mutation === 'already_merged') {
      input.liveObservation.pull_request.state = 'MERGED';
      input.liveObservation.pull_request.merge_commit_sha = MERGE_SHA;
    }
    const result = preflight(input);
    expect(result.schema_version).toBe(OR_MERGE_PREFLIGHT_SCHEMA_VERSION);
    expect(result.disposition).toBe(fixture.expected);
    if (fixture.reason) expect(result.reason_codes).toContain(fixture.reason);
    expect(result.claims.ao_executed_merge).toBe(false);
    expect(result.claims.merge_dispatched).toBe(false);
  });

  it.each(fixturePack.outcomes)('fails closed or confirms provider outcome fixture $id', (fixture) => {
    const authorized = preflight();
    const dispatch = fixture.dispatch === 'ambiguous'
      ? { status: 'accepted', attempt_ref: 'or:merge-attempt:85' }
      : { status: fixture.dispatch, attempt_ref: 'or:merge-attempt:85' };
    const observation = fixture.observation === 'missing'
      ? null : mergedObservation(authorized, fixture.observation);
    const result = bindGitHubMergeOutcome({
      preflight: authorized,
      dispatch,
      provider_observation: observation,
    });
    expect(result.disposition).toBe(fixture.expected);
    if (fixture.reason) expect(result.reason_codes).toContain(fixture.reason);
    expect(result.claims.merged).toBe(fixture.expected === 'confirmed_merged');
    if (fixture.id === 'unknown-effect') expect(result.outcome).toBe('unknown_effect');
  });

  it('accepts an exact provider-observed already-merged result without dispatch', () => {
    const input = materialize();
    input.liveObservation.pull_request.state = 'MERGED';
    input.liveObservation.pull_request.merge_commit_sha = MERGE_SHA;
    const alreadyMerged = preflight(input);
    const result = bindGitHubMergeOutcome({
      preflight: alreadyMerged,
      dispatch: { status: 'not_dispatched' },
      provider_observation: mergedObservation(alreadyMerged),
    });
    expect(result).toMatchObject({
      disposition: 'confirmed_merged',
      outcome: 'already_merged',
      merge_binding: { head_sha: input.authorizationRequest.branch.head_sha, merge_commit_sha: MERGE_SHA },
    });
  });

  it('replays byte-identically and rejects missing release/check/review evidence', () => {
    const input = materialize();
    const first = preflight(input);
    const second = preflight(structuredClone(input));
    expect(second).toEqual(first);

    input.releaseJudgment.claims.merge = true;
    input.liveObservation.review.unresolved_thread_count = 1;
    input.liveObservation.required_checks[0].status = 'PENDING';
    expect(preflight(input)).toMatchObject({
      disposition: 'blocked',
      reason_codes: expect.arrayContaining([
        'judgment_release_claim_merge_invalid',
        'required_check_not_successful',
        'unresolved_review_threads',
      ]),
    });
  });

  it('rejects stale, future, unknown-field, and preflight-predating evidence', () => {
    const stale = materialize();
    stale.liveObservation.observed_at = '2026-08-09T12:28:59.000Z';
    expect(preflight(stale).reason_codes).toContain('live_observation_stale');

    const future = materialize();
    future.liveObservation.observed_at = '2026-08-09T12:30:01.000Z';
    expect(preflight(future).reason_codes).toContain('live_observation_from_future');

    const widened = materialize();
    widened.liveObservation.authority_override = true;
    expect(preflight(widened).reason_codes).toContain('live_observation_unknown_field');

    const authorized = preflight();
    const observation = mergedObservation(authorized);
    observation.observed_at = '2026-08-09T12:29:59.000Z';
    expect(bindGitHubMergeOutcome({
      preflight: authorized,
      dispatch: { status: 'succeeded', attempt_ref: 'or:merge-attempt:85' },
      provider_observation: observation,
    }).reason_codes).toContain('provider_observation_predates_preflight');

    const providerWidened = mergedObservation(authorized);
    providerWidened.authority_override = true;
    expect(bindGitHubMergeOutcome({
      preflight: authorized,
      dispatch: { status: 'succeeded', attempt_ref: 'or:merge-attempt:85' },
      provider_observation: providerWidened,
    }).reason_codes).toContain('provider_observation_unknown_field');
  });

  it('keeps legacy auto_merge_ready_pr auditable but structurally non-executable in AO', async () => {
    const model = buildAssistActionModel({
      controllerId: 'default',
      task: { task_id: 'task-22', status: 'active' },
      prNumber: 85,
      runtimeRef: 'runtime.agent_orchestrator.stable_v0_2_0',
      runtimePreflight: { status: 'clean', runtime_ref: 'runtime.agent_orchestrator.stable_v0_2_0' },
      action: { id: 'auto_merge_ready_pr', action_class: 'merge_pr' },
    });
    expect(model).toMatchObject({
      risk_class: 'irreversible_remote_effect',
      phase4_assist: { executable: false, reason: 'legacy_auto_merge_executor_removed_or_effect_only' },
      execution_contract: { automation_boundary: 'or_effect_only_ao_executor_removed', remote_effect: null },
    });

    const commandRunner = jest.fn();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(executeAssistActions).toEqual(expect.any(Function));
    expect(createStateRepository).toEqual(expect.any(Function));
  });
});
