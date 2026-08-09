import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { digestControllerLeaseAuthorityEvidence } from '../../scripts/ao/lib/controller-lease-authority.js';
import {
  classifyControllerLeaseSafetyError,
  digestControllerLeaseSafetyEvidence,
  loadControllerLeaseSafetyFixturePack,
  replayControllerLeaseSafetyFixturePack,
  snapshotControllerLeasePersistentArtifacts,
  verifyControllerLeaseRecoveryEvidence,
} from '../../scripts/ao/controller-lease-safety-evaluation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(repositoryRoot, 'tests/ao/fixtures/controller-lease-safety/pack.v1.json');
const expectedReceiptPath = path.join(repositoryRoot, 'docs/foundation/controller-lease-safety-verification.v1.json');
const pack = loadControllerLeaseSafetyFixturePack(fixturePath);

describe('controller lease safety evaluation pack', () => {
  it('covers every admitted lease-safety scenario and evidence disposition', () => {
    expect(new Set(pack.cases.map((entry) => entry.class))).toEqual(new Set([
      'concurrent-heartbeat', 'file-loss', 'invalid-json', 'missing-evidence',
      'mixed-version', 'partial-recovery', 'recovery-failure', 'recovery-success',
      'restart', 'stale-shadow',
    ]));
    expect(new Set(pack.cases.map((entry) => entry.expected.disposition))).toEqual(new Set(['accepted', 'rejected']));
    expect(pack.required_replays).toBeGreaterThanOrEqual(2);
  });

  it('replays every fixture twice with identical case and receipt digests', async () => {
    const first = await replayControllerLeaseSafetyFixturePack(pack);
    const second = await replayControllerLeaseSafetyFixturePack(pack);
    expect(first.receipt).toEqual(JSON.parse(fs.readFileSync(expectedReceiptPath, 'utf8')));
    expect(first.receipt).toEqual(second.receipt);
    expect(first.runs[0].cases).toEqual(first.runs[1].cases);
    expect(first.receipt.run_digests).toEqual([
      first.receipt.stable_run_digest,
      first.receipt.stable_run_digest,
    ]);
    expect(first.receipt.case_execution_count).toBe(pack.cases.length * 2);
    expect(first.receipt.receipt_digest).toBe(digestControllerLeaseSafetyEvidence({
      ...first.receipt,
      receipt_digest: undefined,
    }));
  });

  it('fails closed when replay evidence is missing or the fixture contract drifts', async () => {
    await expect(replayControllerLeaseSafetyFixturePack(pack, { replayCount: 1 }))
      .rejects.toThrow('at least two replays');
    const drifted = structuredClone(pack);
    drifted.cases[0].expected.lease_ids = ['stale-lease'];
    await expect(replayControllerLeaseSafetyFixturePack(drifted))
      .rejects.toThrow('canonical-wins-over-stale-shadow');
  });

  it('normalizes runtime-specific parse diagnostics to identical safety evidence', () => {
    const node20 = new SyntaxError("Unexpected token 'i', \"{ invalid\"... is not valid JSON");
    const node22 = new SyntaxError("Expected property name or '}' in JSON at position 2");
    const observations = [node20, node22].map((error) => ({
      disposition: 'rejected',
      error_code: classifyControllerLeaseSafetyError(error),
    }));
    expect(observations[0]).toEqual({
      disposition: 'rejected',
      error_code: 'canonical_authority_invalid_json',
    });
    expect(digestControllerLeaseSafetyEvidence(observations[0]))
      .toBe(digestControllerLeaseSafetyEvidence(observations[1]));
  });

  it('requires explicit operator intent and binds the resulting canonical authority', () => {
    const recoveryCase = pack.cases.find((entry) => entry.class === 'recovery-success');
    expect(recoveryCase.expected.operator_intent).toBe('restore_verified_canonical_backup');
    expect(() => verifyControllerLeaseRecoveryEvidence({
      schema_version: 'ao.controller-lease-recovery-evidence.v1',
      operator: { id: 'operator-18', role: 'repository_owner' },
    }, { projectId: 'controller-lease-safety', incidentId: 'incident-18' }))
      .toThrow('explicit operator intent');
  });

  it('rejects recovery evidence outside its target, without stop evidence, or with invalid ordering', () => {
    const validCase = pack.cases.find((entry) => entry.class === 'recovery-success');
    expect(validCase.expected.operator_intent).toBe('restore_verified_canonical_backup');

    const base = {
      schema_version: 'ao.controller-lease-recovery-evidence.v1',
      project_id: 'project-a',
      incident_id: 'incident-a',
      operator: { id: 'operator-a', role: 'repository_owner' },
      operator_intent: 'restore_verified_canonical_backup',
      reason: 'Verified recovery.',
      approved_at: '2026-08-09T11:00:00.000Z',
      source_evidence: { kind: 'offline_verified_backup', active_controller_count: 0 },
      resulting_authority: {
        active_controller_count: 0,
        observed_at: '2026-08-09T11:05:00.000Z',
        records: [],
      },
    };
    expect(() => verifyControllerLeaseRecoveryEvidence(base, {
      projectId: 'project-b', incidentId: 'incident-a',
    })).toThrow('expected project and incident');
    const nonTextOperator = structuredClone(base);
    nonTextOperator.operator = { id: 7, role: true };
    expect(() => verifyControllerLeaseRecoveryEvidence(nonTextOperator, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('textual operator identity');
    expect(() => verifyControllerLeaseRecoveryEvidence(base, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('quiescence evidence');

    const quiescenceBody = {
      schema_version: 'ao.controller-lease-quiescence-evidence.v1',
      observer_id: 'operator-a',
      observed_at: '2026-08-09T11:01:00.000Z',
      running_controller_ids: [],
    };
    const ordered = structuredClone(base);
    ordered.source_evidence.quiescence_evidence = {
      ...quiescenceBody,
      integrity_digest: `sha256:${'0'.repeat(64)}`,
    };
    expect(() => verifyControllerLeaseRecoveryEvidence(ordered, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('quiescence evidence');

    ordered.source_evidence.quiescence_evidence.integrity_digest =
      digestControllerLeaseAuthorityEvidence(quiescenceBody);
    expect(() => verifyControllerLeaseRecoveryEvidence(ordered, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('timestamps are invalid or out of order');

    const missingObservation = structuredClone(ordered);
    missingObservation.source_evidence.quiescence_evidence.observed_at = '2026-08-09T10:59:00.000Z';
    const { integrity_digest: _oldDigest, ...missingObservationQuiescence } =
      missingObservation.source_evidence.quiescence_evidence;
    missingObservation.source_evidence.quiescence_evidence.integrity_digest =
      digestControllerLeaseAuthorityEvidence(missingObservationQuiescence);
    delete missingObservation.resulting_authority.observed_at;
    expect(() => verifyControllerLeaseRecoveryEvidence(missingObservation, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('timestamps are invalid or out of order');

    const runningController = structuredClone(missingObservation);
    runningController.resulting_authority.observed_at = '2026-08-09T11:05:00.000Z';
    runningController.source_evidence.quiescence_evidence.running_controller_ids = ['controller-default'];
    const { integrity_digest: _emptyDigest, ...runningQuiescence } =
      runningController.source_evidence.quiescence_evidence;
    runningController.source_evidence.quiescence_evidence.integrity_digest =
      digestControllerLeaseAuthorityEvidence(runningQuiescence);
    expect(() => verifyControllerLeaseRecoveryEvidence(runningController, {
      projectId: 'project-a', incidentId: 'incident-a',
    })).toThrow('quiescence evidence');
  });

  it('detects every persistent artifact class and excludes only documented transient files', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-lease-artifact-snapshot-'));
    try {
      const persistentPaths = [
        'schema.json',
        'controller-leases.json',
        'state.json',
        'controller-lease-migration-receipt.json',
        'controller-lease-migration-audit-checkpoint.json',
        'bootstrap-provenance.json',
        'audit-log.jsonl',
        'nested/other-persistent-artifact.json',
      ];
      for (const relativePath of persistentPaths) {
        fs.mkdirSync(path.dirname(path.join(stateRoot, relativePath)), { recursive: true });
        fs.writeFileSync(path.join(stateRoot, relativePath), '{}\n');
      }
      fs.writeFileSync(path.join(stateRoot, 'state.json.lock'), '{"pid":1}\n');
      fs.writeFileSync(path.join(stateRoot, 'state.json.tmp-123-456'), '{}\n');
      const before = snapshotControllerLeasePersistentArtifacts(stateRoot);
      expect(before.map((entry) => entry.path)).toEqual([...persistentPaths].sort());
      for (const relativePath of persistentPaths) {
        fs.writeFileSync(path.join(stateRoot, relativePath), '{"status":"changed"}\n');
        expect(snapshotControllerLeasePersistentArtifacts(stateRoot)).not.toEqual(before);
        fs.writeFileSync(path.join(stateRoot, relativePath), '{}\n');
      }
      fs.writeFileSync(path.join(stateRoot, 'state.json.lock'), '{"pid":2}\n');
      fs.writeFileSync(path.join(stateRoot, 'state.json.tmp-123-456'), '{"changed":true}\n');
      expect(snapshotControllerLeasePersistentArtifacts(stateRoot)).toEqual(before);
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it('keeps the fixture artifact newline terminated with a stable digest', () => {
    const bytes = fs.readFileSync(fixturePath);
    expect(bytes.at(-1)).toBe(10);
    expect(digestControllerLeaseSafetyEvidence(JSON.parse(bytes.toString('utf8'))))
      .toBe(digestControllerLeaseSafetyEvidence(pack));
  });
});
