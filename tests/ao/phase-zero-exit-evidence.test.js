import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  loadPhaseZeroEvidence,
  readGitIdentity,
  replayPhaseZeroEvidence,
  validatePhaseZeroEvidence,
} from '../../scripts/ao/lib/phase-zero-exit-evidence.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = loadPhaseZeroEvidence(repositoryRoot);

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

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
    expect(() => validatePhaseZeroEvidence(falseSuccess, { repositoryRoot })).toThrow('unresolved promotion path');

    const shadowAuthority = structuredClone(bundle);
    shadowAuthority.lease.projection.persistent = true;
    expect(() => validatePhaseZeroEvidence(shadowAuthority, { repositoryRoot })).toThrow('projection contract drifted');

    const mergeClaim = structuredClone(bundle);
    mergeClaim.boundary.claims.ao_merges = true;
    expect(() => validatePhaseZeroEvidence(mergeClaim, { repositoryRoot })).toThrow('authority contract drifted');

    const narrowedCoverage = structuredClone(bundle);
    narrowedCoverage.trajectory.completion_record.candidate_field_count = 39;
    expect(() => validatePhaseZeroEvidence(narrowedCoverage, { repositoryRoot })).toThrow('field count drifted');

    const schemaPath = structuredClone(bundle);
    schemaPath.trajectory.completion_record.schema_path = 'package.json';
    expect(() => validatePhaseZeroEvidence(schemaPath, { repositoryRoot })).toThrow('schema path drifted');
  });

  it('keeps revoked history non-authoritative and does not claim contamination', () => {
    expect(bundle.manifest.admission.revoked_admission_ref).toContain('5232637735');
    expect(bundle.risks.audit_history.every((entry) => entry.repository_contamination === false)).toBe(true);
    const contaminated = structuredClone(bundle);
    contaminated.risks.audit_history[0].repository_contamination = true;
    expect(() => validatePhaseZeroEvidence(contaminated, { repositoryRoot })).toThrow('misclassified');
  });

  it('freezes every delivery and complete admission identity', () => {
    const fabricatedDelivery = structuredClone(bundle);
    fabricatedDelivery.manifest.foundations[10].deliveries[0].pr = 999;
    expect(() => validatePhaseZeroEvidence(fabricatedDelivery, { repositoryRoot }))
      .toThrow('delivery identities drifted');

    const unrelatedAdmission = structuredClone(bundle);
    unrelatedAdmission.manifest.admission.lane_issue = 9;
    expect(() => validatePhaseZeroEvidence(unrelatedAdmission, { repositoryRoot }))
      .toThrow('admission identity drifted');
  });

  it('binds canonical artifact paths and validated objects', () => {
    const redirected = structuredClone(bundle);
    redirected.manifest.artifacts.trajectory_report.path = 'package.json';
    expect(() => validatePhaseZeroEvidence(redirected, { repositoryRoot }))
      .toThrow('canonical path');

    const detached = structuredClone(bundle);
    detached.trajectory.status = 'detached-copy';
    expect(() => validatePhaseZeroEvidence(detached, { repositoryRoot }))
      .toThrow();
  });

  it('recomputes trajectory and lease fingerprints from canonical sources', () => {
    const trajectory = structuredClone(bundle);
    trajectory.trajectory.source_contracts = [];
    expect(() => validatePhaseZeroEvidence(trajectory, { repositoryRoot }))
      .toThrow('source contracts drifted');

    const lease = structuredClone(bundle);
    lease.lease.replay.fixture_digest = '0'.repeat(64);
    expect(() => validatePhaseZeroEvidence(lease, { repositoryRoot }))
      .toThrow('canonical safety receipt');
  });

  it('freezes complete effect claims, failure policy, risks, and scope', () => {
    const legacyExecutor = structuredClone(bundle);
    legacyExecutor.boundary.claims.legacy_auto_merge_executor_removed = false;
    expect(() => validatePhaseZeroEvidence(legacyExecutor, { repositoryRoot }))
      .toThrow('authority contract drifted');

    const replayExpansion = structuredClone(bundle);
    replayExpansion.boundary.failure_policy.unknown_effect_replay = 'allowed';
    expect(() => validatePhaseZeroEvidence(replayExpansion, { repositoryRoot }))
      .toThrow('authority contract drifted');

    const lostRisks = structuredClone(bundle);
    lostRisks.risks.accepted_residual_risks = [{}];
    expect(() => validatePhaseZeroEvidence(lostRisks, { repositoryRoot }))
      .toThrow('residual-risk set drifted');

    const admittedScope = structuredClone(bundle);
    admittedScope.risks.scope_statement.excluded = [];
    expect(() => validatePhaseZeroEvidence(admittedScope, { repositoryRoot }))
      .toThrow('contradicts manifest');
  });

  it('pins class-specific scenario outcomes and rejects dirty Git evidence', () => {
    const allFailure = structuredClone(bundle);
    allFailure.fixtures.scenarios[0].mutation = 'artifact_digest_missing';
    allFailure.fixtures.scenarios[0].expected = 'blocked';
    expect(() => validatePhaseZeroEvidence(allFailure, { repositoryRoot }))
      .toThrow('scenario semantics drifted');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-zero-git-'));
    git(['init', '--quiet'], tempRoot);
    git(['config', 'user.email', 'phase-zero@example.invalid'], tempRoot);
    git(['config', 'user.name', 'Phase Zero'], tempRoot);
    fs.writeFileSync(path.join(tempRoot, 'evidence.txt'), 'accepted\n');
    git(['add', 'evidence.txt'], tempRoot);
    git(['commit', '--quiet', '-m', 'fixture'], tempRoot);
    expect(readGitIdentity(tempRoot)).toEqual({
      head_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
      tree_sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    fs.writeFileSync(path.join(tempRoot, 'untracked.txt'), 'drift\n');
    expect(() => readGitIdentity(tempRoot)).toThrow('must be clean');
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('requires deterministic double replay', () => {
    expect(() => replayPhaseZeroEvidence(bundle, { repositoryRoot, replayCount: 1 })).toThrow('at least two replays');
    expect(replayPhaseZeroEvidence(structuredClone(bundle), { repositoryRoot }).receipt)
      .toEqual(replayPhaseZeroEvidence(bundle, { repositoryRoot }).receipt);
  });
});
