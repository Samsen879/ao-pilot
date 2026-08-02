import fs from 'node:fs';
import os from 'node:os';
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
      documentation_files: 10,
      scope_guard: 'inventory_only',
    });
  });

  it('fails if a local commit receives a parity verdict before P0-R02', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.live_observation.old_local_runtime.unique_commits[0].parity_disposition = 'adopted';
    expect(() => validateIncidentInventory(inventory)).toThrow(/premature parity verdict/);
  });

  it('fails if the frozen local runtime commit ledger changes', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.live_observation.old_local_runtime.unique_commits[0].commit =
      'ffffffffffffffffffffffffffffffffffffffff';
    expect(() => validateIncidentInventory(inventory)).toThrow(/local runtime commit ledger drifted/);
  });

  it('fails if the frozen repository snapshot changes consistently', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.frozen_observation.ao_pilot_main_sha =
      'ffffffffffffffffffffffffffffffffffffffff';
    inventory.live_observation.ao_pilot.main_sha =
      'ffffffffffffffffffffffffffffffffffffffff';
    expect(() => validateIncidentInventory(inventory)).toThrow(/frozen main SHA drifted/);
  });

  it('fails if an observed upstream artifact coordinate changes', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.live_observation.official_runtime.npm_linux_x64.integrity = 'sha512-corrupt';
    expect(() => validateIncidentInventory(inventory)).toThrow(
      /official runtime artifact identity drifted/,
    );
  });

  it('fails if an otherwise-unchecked incident inventory field changes', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    delete inventory.dependency_inventory;
    expect(() => validateIncidentInventory(inventory)).toThrow(/incident inventory digest drifted/);
  });

  it('fails if the original chain loses its exact serial or predecessor migration', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    const issue12 = receipt.issues.find((entry) => entry.issue_number === 12);
    issue12.new_predecessor = '#11';
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(/#12 predecessor mismatch/);
  });

  it('fails if the migration ledger substitutes another issue for issue 7', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    receipt.issues[0].issue_number = 9;
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(/migration issue sequence mismatch/);
  });

  it('fails if a migration body digest is replaced with another valid-looking digest', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    receipt.issues[0].body_sha256 = 'f'.repeat(64);
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(
      /migration body digest ledger drifted/,
    );
  });

  it('fails if the special issue 7 or 8 predecessor migration changes', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    receipt.issues.find((entry) => entry.issue_number === 8).new_predecessor = '#55';
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(/#8 predecessor migration mismatch/);
  });

  it('fails if an otherwise-unchecked migration receipt field changes', () => {
    const receipt = readJson('docs/runtime-portability/p0-r01-issue-migration-receipt.json');
    receipt.observed_main_sha = 'f'.repeat(40);
    expect(() => validateIssueMigrationReceipt(receipt)).toThrow(/migration receipt digest drifted/);
  });

  it('allows superseding documentation while retaining the incident correction markers', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-r01-doc-superseding-'));
    const requiredPaths = [
      'docs/runtime-portability/p0-r01-incident-inventory.json',
      'docs/runtime-portability/p0-r01-issue-migration-receipt.json',
      'docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md',
      'README.md',
      'docs/AO_ARCHITECTURE.md',
      'docs/AO_DEVELOPMENT.md',
      'docs/AO_RELEASE.md',
      'docs/AO_CONFIGURATION.md',
      'docs/AO_MIGRATION_HISTORY.md',
      'docs/AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md',
      'docs/consolidation/cie-embedded-ao/FINAL_CONSOLIDATION_REPORT.md',
      'docs/consolidation/cie-embedded-ao/07-runtime-portability-erratum.md',
      'package.json',
    ];
    try {
      for (const relativePath of requiredPaths) {
        const target = path.join(tempRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, relativePath), target);
      }
      fs.appendFileSync(path.join(tempRoot, 'README.md'), '\nSuperseding P0-R04 detail.\n');
      expect(verifyRuntimePortabilityInventory(tempRoot).status).toBe('pass');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    'docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md',
    'docs/consolidation/cie-embedded-ao/FINAL_CONSOLIDATION_REPORT.md',
    'docs/consolidation/cie-embedded-ao/07-runtime-portability-erratum.md',
  ])('keeps immutable evidence digest-checked: %s', (immutablePath) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-r01-immutable-doc-'));
    const requiredPaths = [
      'docs/runtime-portability/p0-r01-incident-inventory.json',
      'docs/runtime-portability/p0-r01-issue-migration-receipt.json',
      'docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md',
      'README.md',
      'docs/AO_ARCHITECTURE.md',
      'docs/AO_DEVELOPMENT.md',
      'docs/AO_RELEASE.md',
      'docs/AO_CONFIGURATION.md',
      'docs/AO_MIGRATION_HISTORY.md',
      'docs/AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md',
      'docs/consolidation/cie-embedded-ao/FINAL_CONSOLIDATION_REPORT.md',
      'docs/consolidation/cie-embedded-ao/07-runtime-portability-erratum.md',
      'package.json',
    ];
    try {
      for (const relativePath of requiredPaths) {
        const target = path.join(tempRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, relativePath), target);
      }
      fs.appendFileSync(path.join(tempRoot, immutablePath), '\nUnauthorized historical rewrite.\n');
      expect(() => verifyRuntimePortabilityInventory(tempRoot)).toThrow(
        /immutable evidence digest drifted/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails if evolving documentation removes an incident correction marker', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-r01-doc-marker-'));
    const requiredPaths = [
      'docs/runtime-portability/p0-r01-incident-inventory.json',
      'docs/runtime-portability/p0-r01-issue-migration-receipt.json',
      'docs/runtime-portability/P0-R01_INCIDENT_BASELINE.md',
      'README.md',
      'docs/AO_ARCHITECTURE.md',
      'docs/AO_DEVELOPMENT.md',
      'docs/AO_RELEASE.md',
      'docs/AO_CONFIGURATION.md',
      'docs/AO_MIGRATION_HISTORY.md',
      'docs/AO_SYSTEM_ARCHITECTURE_AND_UPGRADE_GUIDE.md',
      'docs/consolidation/cie-embedded-ao/FINAL_CONSOLIDATION_REPORT.md',
      'docs/consolidation/cie-embedded-ao/07-runtime-portability-erratum.md',
      'package.json',
    ];
    try {
      for (const relativePath of requiredPaths) {
        const target = path.join(tempRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(ROOT, relativePath), target);
      }
      const readmePath = path.join(tempRoot, 'README.md');
      fs.writeFileSync(
        readmePath,
        fs.readFileSync(readmePath, 'utf8').replace('package-level portability', 'removed'),
      );
      expect(() => verifyRuntimePortabilityInventory(tempRoot)).toThrow(
        /README\.md is missing required incident text/,
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails if package portability is promoted to runtime portability', () => {
    const inventory = readJson('docs/runtime-portability/p0-r01-incident-inventory.json');
    inventory.current_claim = 'ao-pilot is operationally portable';
    expect(() => validateIncidentInventory(inventory)).toThrow(/current portability claim drifted/);
  });
});
