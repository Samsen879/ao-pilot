import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  validateIncidentInventory,
  validateIssueMigrationReceipt,
  verifyRuntimePortabilityInventory,
} from '../../scripts/ao/lib/runtime-portability-inventory.js';

const ROOT = process.cwd();

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

describe('P0-R01 runtime portability incident inventory', () => {
  it('validates the committed incident, migration and claim-correction evidence', () => {
    expect(verifyRuntimePortabilityInventory(ROOT)).toEqual({
      status: 'pass',
      incident: {
        schema_version: 'ao.runtime-portability-incident.v1',
        severity: 'P0_RELEASE_BLOCKER',
        unique_local_commits: 12,
        runtime_selection: 'NOT_ESTABLISHED',
        admitted_issue: 56,
      },
      issue_migration: {
        schema_version: 'ao-pilot.issue-migration-receipt.v1',
        updated_issues: 45,
        intake_issues_checked: 54,
        result: 'PASS',
      },
      documentation_files: 9,
      scope_guard: 'inventory_only',
    });
  });

  it('fails if a local commit receives a parity verdict before P0-R02', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.live_observation.old_local_runtime.unique_commits[0].parity_disposition = 'adopted';
    expect(() => validateIncidentInventory(inventory)).toThrow(/premature parity verdict/);
  });

  it('fails if the original chain loses its exact serial or predecessor migration', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    const issue12 = receipt.issues.find((entry) => entry.issue_number === 12);
    issue12.new_predecessor = '#11';
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(/#12 predecessor mismatch/);
  });

  it('fails if package portability is promoted to runtime portability', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.current_claim = 'ao-pilot is operationally portable';
    expect(() => validateIncidentInventory(inventory)).toThrow(/current portability claim drifted/);
  });
});
