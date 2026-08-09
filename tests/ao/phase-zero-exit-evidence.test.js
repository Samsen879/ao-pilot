import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  loadPhaseZeroEvidence,
  replayPhaseZeroEvidence,
  validatePhaseZeroEvidence,
} from '../../scripts/ao/lib/phase-zero-exit-evidence.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = loadPhaseZeroEvidence(repositoryRoot);

describe('Phase 0 integrated exit evidence', () => {
  it('accepts the exact F01-F11 evidence chain and frozen contracts', () => {
    expect(validatePhaseZeroEvidence(bundle, { repositoryRoot })).toBe(true);
    expect(bundle.manifest.foundations).toHaveLength(11);
    expect(bundle.manifest.foundations.at(-1).deliveries).toHaveLength(2);
  });

  it('covers success, failure, missing evidence, and replay behavior', () => {
    const { receipt, runs } = replayPhaseZeroEvidence(bundle, { repositoryRoot });
    expect(receipt.status).toBe('passed');
    expect(receipt.behavior_coverage).toEqual(['success', 'failure', 'missing_evidence', 'replay']);
    expect(runs[0]).toEqual(runs[1]);
    expect(new Set(runs[0].results.map((entry) => entry.disposition))).toEqual(new Set(['accepted', 'blocked']));
  });

  it('fails closed on missing evidence and contradictory history', () => {
    const missing = structuredClone(bundle);
    missing.manifest.foundations[4].deliveries[0].reviews.pop();
    expect(() => validatePhaseZeroEvidence(missing, { repositoryRoot })).toThrow('exactly two review rounds');

    const contradiction = structuredClone(bundle);
    contradiction.manifest.foundations[10].deliveries[1].base_sha = '0'.repeat(40);
    expect(() => validatePhaseZeroEvidence(contradiction, { repositoryRoot })).toThrow('chain base');
  });

  it('rejects false-success, authority, schema, and scope regressions', () => {
    const falseSuccess = structuredClone(bundle);
    falseSuccess.trajectory.false_success.unresolved_promotion_path_count = 1;
    expect(() => validatePhaseZeroEvidence(falseSuccess, { repositoryRoot })).toThrow('not accepted');

    const shadowAuthority = structuredClone(bundle);
    shadowAuthority.lease.projection.persistent = true;
    expect(() => validatePhaseZeroEvidence(shadowAuthority, { repositoryRoot })).toThrow('became authoritative');

    const mergeClaim = structuredClone(bundle);
    mergeClaim.boundary.claims.ao_merges = true;
    expect(() => validatePhaseZeroEvidence(mergeClaim, { repositoryRoot })).toThrow('claims drifted');

    const narrowedCoverage = structuredClone(bundle);
    narrowedCoverage.trajectory.completion_record.candidate_field_count = 39;
    expect(() => validatePhaseZeroEvidence(narrowedCoverage, { repositoryRoot })).toThrow('coverage drifted');
  });

  it('keeps revoked history non-authoritative and does not claim contamination', () => {
    expect(bundle.manifest.admission.revoked_admission_ref).toContain('5232637735');
    expect(bundle.risks.audit_history.every((entry) => entry.repository_contamination === false)).toBe(true);
    const contaminated = structuredClone(bundle);
    contaminated.risks.audit_history[0].repository_contamination = true;
    expect(() => validatePhaseZeroEvidence(contaminated, { repositoryRoot })).toThrow('misclassified');
  });

  it('requires deterministic double replay', () => {
    expect(() => replayPhaseZeroEvidence(bundle, { repositoryRoot, replayCount: 1 })).toThrow('at least two replays');
    expect(replayPhaseZeroEvidence(structuredClone(bundle), { repositoryRoot }).receipt)
      .toEqual(replayPhaseZeroEvidence(bundle, { repositoryRoot }).receipt);
  });
});
