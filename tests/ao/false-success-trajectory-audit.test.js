import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTrajectoryVocabulary } from '../../scripts/ao/lib/trajectory-vocabulary.js';
import {
  buildFalseSuccessAuditReport,
  evaluateFalseSuccessFixture,
  loadFalseSuccessFixturePack,
  stableDigest,
  validateFalseSuccessFixturePack,
} from '../../scripts/ao/lib/false-success-trajectory-audit.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventory = loadTrajectoryVocabulary(path.join(
  repositoryRoot,
  'docs/foundation/trajectory-vocabulary.v1.json',
));
const pack = loadFalseSuccessFixturePack(path.join(
  repositoryRoot,
  'tests/ao/fixtures/false-success-trajectories/pack.v1.json',
));
const committedReport = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'docs/foundation/false-success-trajectory-audit.v1.json',
), 'utf8'));

function fixture(id) {
  return structuredClone(pack.fixtures.find((entry) => entry.id === id));
}

describe('false-success trajectory audit', () => {
  it('maps every F01 vocabulary path to a negative fixture and durable finding', () => {
    const validation = validateFalseSuccessFixturePack(pack, inventory);
    const report = buildFalseSuccessAuditReport(pack, inventory);

    expect(validation).toEqual({ fixture_count: 16, covered_item_count: 50 });
    expect(report.summary.inventory_item_count).toBe(inventory.items.length);
    expect(report.summary.covered_item_count).toBe(inventory.items.length);
    expect(report.coverage).toHaveLength(inventory.items.length);
    expect(report.coverage.every((row) => row.fixture_ids.length > 0)).toBe(true);
    expect(report.coverage.every((row) => row.finding_fingerprints.length > 0)).toBe(true);
    expect(report.blocking_findings.every((finding) => (
      finding.disposition === 'block'
      && finding.durable === true
      && /^[0-9a-f]{64}$/.test(finding.fingerprint)
    ))).toBe(true);
  });

  it('replays twice with byte-stable report and finding fingerprints', () => {
    const first = buildFalseSuccessAuditReport(pack, inventory);
    const second = buildFalseSuccessAuditReport(
      JSON.parse(JSON.stringify(pack)),
      JSON.parse(JSON.stringify(inventory)),
    );

    expect(second).toEqual(first);
    expect(stableDigest(second)).toBe(stableDigest(first));
    expect(second.blocking_findings.map((finding) => finding.fingerprint))
      .toEqual(first.blocking_findings.map((finding) => finding.fingerprint));
    expect(first).toEqual(committedReport);
  });

  it.each([
    ['local-pass-is-not-merge', 'provider_merge_not_observed'],
    ['dispatch-is-not-provider-outcome', 'dispatch_is_not_provider_outcome'],
    ['queued-ci-is-not-execution', 'ci_was_not_executed'],
    ['runner-error-is-not-code-failure', 'runner_outcome_is_not_code_failure'],
    ['aggregate-passing-misses-required-checks', 'aggregate_ci_does_not_prove_required_success'],
    ['aggregate-approval-misses-exact-head-review', 'review_does_not_bind_exact_head'],
    ['valid-checkpoint-is-not-terminal-delivery', 'checkpoint_validity_is_not_terminal_delivery'],
  ])('blocks targeted false-success fixture %s', (id, code) => {
    const result = evaluateFalseSuccessFixture(fixture(id));
    expect(result.disposition).toBe('block');
    expect(result.findings).toEqual([expect.objectContaining({ code, durable: true })]);
  });

  it.each([
    ['missing-provider-merge-outcome', 'provider_merge_outcome_unknown'],
    ['missing-required-ci-outcome', 'required_ci_outcome_unknown'],
    ['missing-exact-head-review-outcome', 'exact_head_review_outcome_unknown'],
    ['self-asserted-context-lacks-authority', 'external_outcome_unknown'],
    ['replay-preserves-unknown-outcome', 'provider_merge_outcome_unknown'],
  ])('fails closed for unknown-outcome fixture %s', (id, code) => {
    expect(evaluateFalseSuccessFixture(fixture(id))).toEqual(expect.objectContaining({
      disposition: 'block',
      findings: [expect.objectContaining({ code })],
    }));
  });

  it('admits only the specific independent evidence required by each policy', () => {
    const merge = fixture('executed-action-is-not-merge');
    merge.observation = { provider_readback_complete: true, provider_pr_state: 'MERGED' };
    expect(evaluateFalseSuccessFixture(merge)).toEqual({ fixture_id: merge.id, disposition: 'allow', findings: [] });

    const ci = fixture('aggregate-passing-misses-required-checks');
    ci.observation = { raw_check_state: 'completed_success', required_checks_complete: true, exact_head: true };
    expect(evaluateFalseSuccessFixture(ci).disposition).toBe('allow');

    const review = fixture('aggregate-approval-misses-exact-head-review');
    review.observation = {
      review_state: 'approved',
      target_head: 'same-head',
      review_commit_oid: 'same-head',
      submitted_review_evidence: true,
    };
    expect(evaluateFalseSuccessFixture(review).disposition).toBe('allow');

    const codeFailure = fixture('runner-error-is-not-code-failure');
    codeFailure.observation = { raw_check_state: 'completed_failure' };
    expect(evaluateFalseSuccessFixture(codeFailure).disposition).toBe('allow');
  });

  it('rejects coverage, producer and expected-outcome mutations', () => {
    const missingCoverage = structuredClone(pack);
    for (const entry of missingCoverage.fixtures) {
      entry.covers = entry.covers.filter((itemId) => itemId !== 'checkpoint.checkpoint_id');
    }
    expect(() => validateFalseSuccessFixturePack(missingCoverage, inventory))
      .toThrow('F01 vocabulary paths lack negative fixture coverage: checkpoint.checkpoint_id');

    const unsupportedProducer = structuredClone(pack);
    unsupportedProducer.fixtures[0].producer.value = 'not-a-verdict';
    expect(() => validateFalseSuccessFixturePack(unsupportedProducer, inventory))
      .toThrow('Unsupported producer value');

    const falseExpectedSuccess = structuredClone(pack);
    falseExpectedSuccess.fixtures[0].expected.disposition = 'allow';
    expect(() => validateFalseSuccessFixturePack(falseExpectedSuccess, inventory))
      .toThrow('must expect block');

    const silentlyAllowed = structuredClone(pack);
    const target = silentlyAllowed.fixtures.find((entry) => entry.id === 'executed-action-is-not-merge');
    target.observation = { provider_readback_complete: true, provider_pr_state: 'MERGED' };
    expect(() => buildFalseSuccessAuditReport(silentlyAllowed, inventory))
      .toThrow('Unexpected disposition for executed-action-is-not-merge');
  });
});
