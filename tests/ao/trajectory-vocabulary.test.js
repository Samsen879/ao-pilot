import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTrajectoryVocabulary,
  trajectoryVocabularyDigest,
  validateTrajectoryFixture,
  validateTrajectoryFixtureSet,
  validateTrajectoryVocabulary,
} from '../../scripts/ao/lib/trajectory-vocabulary.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = path.join(repositoryRoot, 'docs/foundation/trajectory-vocabulary.v1.json');
const fixtureDirectory = path.join(repositoryRoot, 'tests/ao/fixtures/trajectory-vocabulary');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, `${name}.json`), 'utf8'));
}

describe('trajectory vocabulary inventory', () => {
  const inventory = loadTrajectoryVocabulary(inventoryPath);

  it('covers every required family with source symbols, callers, owners, and authorities', () => {
    const report = validateTrajectoryVocabulary(inventory, { repositoryRoot });

    expect(report.item_count).toBeGreaterThanOrEqual(30);
    expect(report.family_counts).toEqual(expect.objectContaining({
      action: expect.any(Number),
      execution_receipt: expect.any(Number),
      lifecycle_disposition: expect.any(Number),
      review_verdict: expect.any(Number),
      ci_state: expect.any(Number),
      merge_observation: expect.any(Number),
      checkpoint: expect.any(Number),
    }));
    expect(report.ambiguity_count).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['missing-evidence', 'missing_evidence'],
  ])('validates the %s fixture against declared vocabulary', (fixtureName, scenario) => {
    expect(validateTrajectoryFixture(loadFixture(fixtureName), inventory)).toEqual(expect.objectContaining({
      scenario,
      family_count: 7,
    }));
  });

  it('replays deterministically without changing the semantic projection', () => {
    const firstInventoryDigest = trajectoryVocabularyDigest(inventory);
    const secondInventoryDigest = trajectoryVocabularyDigest(JSON.parse(JSON.stringify(inventory)));
    const success = validateTrajectoryFixture(loadFixture('success'), inventory);
    const replay = validateTrajectoryFixture(loadFixture('replay'), inventory);

    expect(secondInventoryDigest).toBe(firstInventoryDigest);
    expect(replay.projection_digest).toBe(success.projection_digest);
    expect(validateTrajectoryFixtureSet([
      loadFixture('failure'),
      loadFixture('missing-evidence'),
      loadFixture('replay'),
      loadFixture('success'),
    ], inventory)).toHaveLength(4);
  });

  it('applies the legacy release alias only to the declared v1alpha1 vocabulary', () => {
    const missingVersion = loadFixture('replay');
    delete missingVersion.release_vocabulary_version;
    expect(() => validateTrajectoryFixture(missingVersion, inventory))
      .toThrow('notify_human_ready projection requires ao.lifecycle.v1alpha1');

    const currentVersion = loadFixture('replay');
    currentVersion.release_vocabulary_version = 'ao.release-judgment.v1';
    expect(() => validateTrajectoryFixture(currentVersion, inventory))
      .toThrow('notify_human_ready projection requires ao.lifecycle.v1alpha1');

    const unknownVersion = loadFixture('replay');
    unknownVersion.release_vocabulary_version = 'ao.lifecycle.v1alpha0';
    expect(() => validateTrajectoryFixture(unknownVersion, inventory))
      .toThrow('Unsupported release vocabulary version: ao.lifecycle.v1alpha0');
  });

  it('fails closed when semantic ownership or role-aware source evidence is missing', () => {
    const missingOwner = structuredClone(inventory);
    missingOwner.items[0].semantic_owner = '';
    expect(() => validateTrajectoryVocabulary(missingOwner, { repositoryRoot }))
      .toThrow('Missing items[0].semantic_owner');

    const missingSymbol = structuredClone(inventory);
    missingSymbol.references.action_templates.symbol = 'symbol_that_does_not_exist';
    expect(() => validateTrajectoryVocabulary(missingSymbol, { repositoryRoot }))
      .toThrow('Missing items[0].source function');

    const missingRelationship = structuredClone(inventory);
    missingRelationship.references.action_summary.evidence = ['field_that_is_not_consumed'];
    expect(() => validateTrajectoryVocabulary(missingRelationship, { repositoryRoot }))
      .toThrow('Missing items[2].consumers[0] relationship evidence');
  });

  it('fails closed when a declared constant vocabulary drifts from its source enum', () => {
    const drifted = structuredClone(inventory);
    const topStatus = drifted.items.find((item) => item.id === 'lifecycle.top_status');
    topStatus.values = topStatus.values.filter((value) => value !== 'observe');

    expect(() => validateTrajectoryVocabulary(drifted, { repositoryRoot }))
      .toThrow('Declared values for lifecycle.top_status differ from source constant LIFECYCLE_TOP_STATUSES');
  });

  it('validates both baseline trees and the admitted ancestry relationship', () => {
    const badTree = structuredClone(inventory);
    badTree.baseline.issue_body_tree = '0'.repeat(40);
    expect(() => validateTrajectoryVocabulary(badTree, { repositoryRoot }))
      .toThrow('Issue-body tree does not match baseline SHA');

    const badRelationship = structuredClone(inventory);
    badRelationship.baseline.relationship = 'unverified';
    expect(() => validateTrajectoryVocabulary(badRelationship, { repositoryRoot, verifySource: false }))
      .toThrow('Invalid baseline.relationship');
  });

  it('normalizes owner and authority identity before enforcing separation', () => {
    const whitespaceAlias = structuredClone(inventory);
    const aoJudgment = whitespaceAlias.items.find((item) => item.id === 'lifecycle.release_disposition');
    const providerOutcome = whitespaceAlias.items.find((item) => item.id === 'merge.provider_pr_state');
    providerOutcome.semantic_owner = `${aoJudgment.semantic_owner} `;

    expect(() => validateTrajectoryVocabulary(whitespaceAlias, { repositoryRoot, verifySource: false }))
      .toThrow('must have distinct semantic owners');
  });

  it('enforces AO judgment, OR effect, and provider outcome separation across every role row', () => {
    const aliased = structuredClone(inventory);
    const routing = aliased.items.find((item) => item.id === 'lifecycle.routing_action');
    const providerState = aliased.items.find((item) => item.id === 'merge.provider_pr_state');
    routing.semantic_owner = providerState.semantic_owner;
    routing.evidence_authority = providerState.evidence_authority;

    expect(() => validateTrajectoryVocabulary(aliased, { repositoryRoot, verifySource: false }))
      .toThrow('ao_judgment and provider_outcome must have distinct semantic_owner values across every role row');
  });

  it('rejects replay targets that are missing or semantically different', () => {
    const fixtures = [
      loadFixture('failure'),
      loadFixture('missing-evidence'),
      loadFixture('replay'),
      loadFixture('success'),
    ];
    fixtures[2].replay_of = 'not_a_scenario';
    expect(() => validateTrajectoryFixtureSet(fixtures, inventory))
      .toThrow('Unknown replay target');

    fixtures[2].replay_of = 'success';
    fixtures[2].expectations[0].value = 'blocked';
    expect(() => validateTrajectoryFixtureSet(fixtures, inventory))
      .toThrow('Replay projection differs from success');
  });

  it('requires complete positive evidence and unique fixture scenarios', () => {
    const incompleteSuccess = loadFixture('success');
    incompleteSuccess.evidence_complete = false;
    expect(() => validateTrajectoryFixture(incompleteSuccess, inventory))
      .toThrow('success fixture must have complete evidence');

    expect(() => validateTrajectoryFixtureSet([
      loadFixture('failure'),
      loadFixture('missing-evidence'),
      loadFixture('success'),
      loadFixture('success'),
    ], inventory)).toThrow('Duplicate fixture scenario');
  });

  it('retains per-review evidence, distinct CI outcomes, and human-gate basis mappings', () => {
    const item = (id) => inventory.items.find((entry) => entry.id === id);

    expect(item('review.github_review_fields').values).toEqual([
      'author_login', 'commit_oid', 'review_id', 'state', 'submitted_at',
    ]);
    expect(item('review.github_review_state').values).toContain('commented');
    expect(item('review.github_target_head').meaning).toContain('reviews[].commit_oid');
    expect(item('ci.raw_check_state').values).toEqual(expect.arrayContaining([
      'completed_failure', 'completed_startup_failure', 'completed_cancelled', 'not_run', 'queued',
    ]));
    expect(item('lifecycle.release_basis').values).toEqual(expect.arrayContaining([
      'all_release_signals_clear', 'branch_mismatch_with_github', 'ci_pending', 'fallback_ambiguous',
      'review_unknown',
    ]));
    expect(item('lifecycle.human_gate_mapping').values).toEqual(expect.arrayContaining([
      'doctor_ambiguous:escalation_required',
      'fallback_ambiguous:escalation_required',
      'missing_pr_assessment:refresh_required',
      'release_status_ambiguous:escalation_required',
      'review_escalated:escalation_required',
      'source_failure:retry_required',
    ]));
    expect(item('execution.command_receipt_fields').field)
      .toBe('or_merge_outcome.dispatch.*');
    expect(item('execution.command_receipt_fields').values)
      .toEqual(['attempt_ref', 'evidence_refs', 'status']);
    expect(item('merge.assist_confirmation').values).toEqual(['CLOSED', 'MERGED', 'OPEN', 'empty_string']);
  });
});
