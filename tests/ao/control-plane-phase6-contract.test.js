import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('AO phase6 debt cleanup and soak contract', () => {
  it('documents the historical debt inventory surface and cleanup categories', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');
    const debtRunbook = read('docs/setup/AO_HISTORICAL_DEBT_RUNBOOK.md');

    expect(controlPlaneOps).toContain('## Phase-6 Historical Debt And Soak Contract');
    expect(controlPlaneOps).toContain('`ao-state --json`: `debt.summary.category_counts`');
    expect(controlPlaneOps).toContain('`ao-state --json`: `debt.inspections[*]`');
    expect(controlPlaneOps).toContain('`keep_evidence`');
    expect(controlPlaneOps).toContain('`archive_candidate`');
    expect(controlPlaneOps).toContain('`cleanup_candidate`');

    expect(debtRunbook).toContain('## Debt Categories');
    expect(debtRunbook).toContain('`cleanup_candidate` means repo-local noise or stale runtime residue');
    expect(debtRunbook).toContain('Do not use destructive reset commands as debt cleanup shortcuts.');
    expect(debtRunbook).toContain('`ao-state --json` should be the first read before manual cleanup.');
  });

  it('documents the soak and incident drill loop as repeatable operator evidence', () => {
    const controlPlaneOps = read('docs/setup/AO_CONTROL_PLANE_OPERATIONS.md');
    const soakRunbook = read('docs/setup/AO_SOAK_AND_INCIDENT_RUNBOOK.md');

    expect(controlPlaneOps).toContain('Phase 6 adds two operator evidence loops:');
    expect(controlPlaneOps).toContain('historical debt inventory');
    expect(controlPlaneOps).toContain('soak and incident drills');

    expect(soakRunbook).toContain('## Minimum Soak Loop');
    expect(soakRunbook).toContain('`npm run ao:smoke -- --scenario ci-failed-pr`');
    expect(soakRunbook).toContain('`npm run ao:smoke -- --scenario approved-and-green-pr`');
    expect(soakRunbook).toContain('`npm test -- --runInBand tests/ao/ao-lifecycle-acceptance.test.js`');
    expect(soakRunbook).toContain('## Incident Drill Matrix');
    expect(soakRunbook).toContain('controller stale leader');
    expect(soakRunbook).toContain('worker crash / stale worker ownership');
    expect(soakRunbook).toContain('PR owner ambiguity');
    expect(soakRunbook).toContain('dirty worktree diagnosis');
  });
});
