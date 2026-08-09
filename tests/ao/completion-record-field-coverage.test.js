import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCompletionRecordFieldCoverageReport,
  loadCompletionRecordFieldCoverage,
  stableDigest,
  validateCompletionRecordFieldCoverage,
} from '../../scripts/ao/lib/completion-record-field-coverage.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ledgerPath = path.join(repositoryRoot, 'docs/foundation/completion-record-field-coverage.v1.json');
const ledger = loadCompletionRecordFieldCoverage(ledgerPath);

function copiedOracleRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-completion-coverage-'));
  for (const source of ledger.sources) {
    const target = path.join(root, source.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, source.path), target);
  }
  return root;
}

describe('Completion Record field coverage ledger', () => {
  it('validates every candidate against deterministic structured or Markdown mappings', () => {
    const validation = validateCompletionRecordFieldCoverage(ledger, { repositoryRoot });
    const report = buildCompletionRecordFieldCoverageReport(ledger, { repositoryRoot });

    expect(report.summary).toEqual({
      candidate_count: 40,
      required_count: 13,
      conditional_count: 23,
      unsupported_count: 4,
      established_count: 25,
      not_established_count: 11,
      omission_count: 4,
    });
    expect(validation.rows).toHaveLength(40);
    expect(validation.rows.every((row) => (
      row.classification === 'unsupported' || row.source_contract != null
    ))).toBe(true);
    expect(validation.rows.filter((row) => row.oracle_coverage === 'established')
      .every((row) => row.mappings.length > 0)).toBe(true);
    expect(report.source_digests.some((source) => source.format === 'json')).toBe(true);
    expect(report.source_digests.some((source) => source.format === 'markdown')).toBe(true);
  });

  it('fails closed on an oracle path or digest mismatch', () => {
    const missingPath = structuredClone(ledger);
    missingPath.sources[0].path = 'docs/consolidation/cie-embedded-ao/missing-oracle.json';
    expect(() => validateCompletionRecordFieldCoverage(missingPath, { repositoryRoot }))
      .toThrow('Missing oracle source');

    const copiedRoot = copiedOracleRoot();
    const source = ledger.sources.find((entry) => entry.id === 'consolidation_manifest');
    fs.appendFileSync(path.join(copiedRoot, source.path), '\n');
    expect(() => validateCompletionRecordFieldCoverage(ledger, { repositoryRoot: copiedRoot }))
      .toThrow('Oracle digest mismatch');
  });

  it('fails when declarative coverage lacks field evidence', () => {
    const missingEvidence = structuredClone(ledger);
    const field = missingEvidence.candidates.find((entry) => entry.field === 'merge_sha');
    field.mappings = [];
    expect(() => validateCompletionRecordFieldCoverage(missingEvidence, { repositoryRoot }))
      .toThrow('Established field lacks oracle mapping: merge_sha');

    const badSelector = structuredClone(ledger);
    badSelector.candidates.find((entry) => entry.field === 'review_refs[]').mappings[0].selector = '/blockers/*/invented_ref';
    expect(() => validateCompletionRecordFieldCoverage(badSelector, { repositoryRoot }))
      .toThrow('Missing JSON pointer');
  });

  it('reports missing evidence and unsupported narrative without inference', () => {
    const report = buildCompletionRecordFieldCoverageReport(ledger, { repositoryRoot });
    expect(report.coverage_gaps).toHaveLength(11);
    expect(report.coverage_gaps.every((gap) => (
      gap.code.length > 0
      && gap.reason.length > 0
      && ['fail_closed', 'explicit_not_established'].includes(gap.when_missing)
    ))).toBe(true);
    expect(report.explicit_omissions.map((entry) => entry.field)).toEqual([
      'deviations[]',
      'lesson_candidates[]',
      'model_generated_narrative',
      'narrative_summary',
    ]);
    expect(report.fields.find((row) => row.field === 'review_round_summary.head_binding_coverage'))
      .toEqual(expect.objectContaining({ classification: 'conditional', oracle_coverage: 'established' }));
    expect(report.inference_policy).toMatch(/^No .* is inferred\.$/);
  });

  it('replays field-by-field with stable bytes and reports source mutation', () => {
    const first = buildCompletionRecordFieldCoverageReport(ledger, { repositoryRoot });
    const replay = buildCompletionRecordFieldCoverageReport(
      JSON.parse(JSON.stringify(ledger)),
      { repositoryRoot },
    );

    expect(replay).toEqual(first);
    expect(replay.fields.map((row) => row.field)).toEqual(ledger.candidates.map((row) => row.field));
    expect(stableDigest(replay)).toBe(stableDigest(first));

    const remapped = structuredClone(ledger);
    remapped.candidates.find((entry) => entry.field === 'pr_number').source_contract.transformation =
      'invented transformation';
    const changed = buildCompletionRecordFieldCoverageReport(remapped, { repositoryRoot });
    expect(changed.report_fingerprint).not.toBe(first.report_fingerprint);
    expect(changed.fields.find((row) => row.field === 'pr_number').source_contract.transformation)
      .toBe('invented transformation');
  });
});
