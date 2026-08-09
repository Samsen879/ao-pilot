import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  digestControllerLeaseSafetyEvidence,
  loadControllerLeaseSafetyFixturePack,
  replayControllerLeaseSafetyFixturePack,
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

  it('requires explicit operator intent and binds the resulting canonical authority', () => {
    const recoveryCase = pack.cases.find((entry) => entry.class === 'recovery-success');
    expect(recoveryCase.expected.operator_intent).toBe('restore_verified_canonical_backup');
    expect(() => verifyControllerLeaseRecoveryEvidence({
      schema_version: 'ao.controller-lease-recovery-evidence.v1',
    })).toThrow('explicit operator intent');
  });

  it('keeps the fixture artifact newline terminated with a stable digest', () => {
    const bytes = fs.readFileSync(fixturePath);
    expect(bytes.at(-1)).toBe(10);
    expect(digestControllerLeaseSafetyEvidence(JSON.parse(bytes.toString('utf8'))))
      .toBe(digestControllerLeaseSafetyEvidence(pack));
  });
});
