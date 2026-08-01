import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  officialTmuxSessionMissingPredicate,
  validateRuntimePatchParityLedger,
  verifyRuntimePatchParity,
} from '../../scripts/ao/lib/runtime-patch-parity.js';

const ROOT = process.cwd();
const LEDGER_PATH = path.join(
  ROOT,
  'docs/runtime-portability/p0-r02-local-patch-parity-ledger.json',
);

function readLedger() {
  return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
}

describe('P0-R02 local runtime patch parity audit', () => {
  it('validates the complete 12-commit ledger and the one minimal remaining delta', () => {
    expect(verifyRuntimePatchParity(ROOT)).toEqual({
      status: 'pass',
      schema_version: 'ao.runtime-patch-parity.v1',
      commits: 12,
      classifications: {
        adopted: 8,
        equivalent: 1,
        obsolete: 2,
        'still-required': 1,
        conflicting: 0,
      },
      remaining_delta: '44d333b5000b75b5b5b89df5df6818a3fbe7f7ce',
      runtime_selection: 'deferred_to_p0_r03',
      scope_guard: 'audit_only',
    });
  });

  it('reproduces the official broad predicate that misclassifies permission denial', () => {
    expect(
      officialTmuxSessionMissingPredicate(
        'error connecting to /tmp/tmux-1000/default (Operation not permitted)',
      ),
    ).toBe(true);
    expect(officialTmuxSessionMissingPredicate("can't find session: worker-1")).toBe(true);
    expect(officialTmuxSessionMissingPredicate('unexpected internal error')).toBe(false);
  });

  it('rejects a bulk-migration disposition', () => {
    const ledger = readLedger();
    ledger.r03_input.bulk_migration_allowed = true;
    expect(() => validateRuntimePatchParityLedger(ledger)).toThrow(/bulk migration/);
  });

  it('rejects hiding a unique local commit', () => {
    const ledger = readLedger();
    ledger.commits.pop();
    expect(() => validateRuntimePatchParityLedger(ledger)).toThrow(/12 commits/);
  });

  it('rejects changing the remaining safety delta', () => {
    const ledger = readLedger();
    ledger.commits[0].classification = 'adopted';
    ledger.commits[1].classification = 'still-required';
    expect(() => validateRuntimePatchParityLedger(ledger)).toThrow(/classification mismatch/);
  });

  it('rejects an altered official artifact identity', () => {
    const ledger = readLedger();
    ledger.official_observation.latest_stable_commit = 'f'.repeat(40);
    expect(() => validateRuntimePatchParityLedger(ledger)).toThrow(/stable commit mismatch/);
  });

  it('rejects an otherwise plausible mutation through the ledger digest', () => {
    const ledger = readLedger();
    ledger.commits[0].capability = 'silently changed claim';
    expect(() => validateRuntimePatchParityLedger(ledger)).toThrow(/ledger digest drifted/);
  });
});
