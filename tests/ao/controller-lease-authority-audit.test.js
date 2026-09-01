import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  generateControllerLeaseAuthorityEvidence,
  loadControllerLeaseInventory,
  scanControllerLeaseSources,
  validateControllerLeaseInventory,
} from '../../scripts/ao/lib/controller-lease-authority-audit.js';
import {
  createControllerLease,
  createControllerModeRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createControllerLeaseAuthority } from '../../scripts/ao/lib/controller-lease-authority.js';
import {
  bootstrapControlPlaneState,
  resolveControlPlanePaths,
} from '../../scripts/ao/lib/state-migrations.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import { writeJsonFileAtomic } from '../../scripts/ao/lib/state-storage.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventory = loadControllerLeaseInventory(path.join(
  repositoryRoot,
  'docs/foundation/controller-lease-authority-sites.v2.json',
));
const fixturePack = JSON.parse(fs.readFileSync(path.join(
  repositoryRoot,
  'tests/ao/fixtures/controller-lease-authority/current-behavior.v1.json',
), 'utf8'));
const tempDirs = [];
const PROJECT_ID = 'controller-lease-audit';
const NOW = '2026-08-09T09:08:11.000Z';

function lease(leaseId) {
  const legacy = leaseId === 'legacy-shadow';
  return createControllerLease({
    lease_id: leaseId,
    controller_id: 'default',
    holder_id: `${leaseId}-holder`,
    holder_type: 'session',
    incarnation_id: legacy ? null : `${leaseId}-incarnation`,
    status: 'active',
    acquired_at: legacy ? '2026-01-01T00:00:00.000Z' : NOW,
    heartbeat_at: legacy ? null : NOW,
    expires_at: '2026-08-09T10:08:11.000Z',
    lease_timeout_ms: legacy ? null : 3600000,
    runtime_kind: legacy ? null : 'continuous',
  });
}

function legacyLease(leaseId) {
  return {
    lease_id: leaseId,
    controller_id: 'default',
    holder_id: `${leaseId}-holder`,
    holder_type: 'session',
    status: 'active',
    acquired_at: '2026-01-01T00:00:00.000Z',
    expires_at: '2026-08-09T10:08:11.000Z',
    metadata: { legacy_format: 'v1' },
  };
}

function materializeFixture(entry) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-lease-audit-'));
  tempDirs.push(repoRoot);
  bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: NOW });
  const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  state.controller_leases = entry.state_shadow == null
    ? []
    : [entry.state_shadow_format === 'legacy-v1' ? legacyLease(entry.state_shadow) : lease(entry.state_shadow)];
  writeJsonFileAtomic(paths.statePath, state);
  if (entry.schema_current_version != null) {
    const schema = JSON.parse(fs.readFileSync(paths.schemaPath, 'utf8'));
    schema.current_version = entry.schema_current_version;
    schema.applied_migrations = schema.applied_migrations.filter(
      (migration) => migration.version <= entry.schema_current_version,
    );
    writeJsonFileAtomic(paths.schemaPath, schema);
    const auditEntries = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((auditEntry) => Number(auditEntry?.details?.migration_version) <= entry.schema_current_version);
    fs.writeFileSync(paths.auditPath, `${auditEntries.map((auditEntry) => JSON.stringify(auditEntry)).join('\n')}\n`, 'utf8');
    if (fs.existsSync(paths.controllerLeaseMigrationReceiptPath)) {
      fs.unlinkSync(paths.controllerLeaseMigrationReceiptPath);
    }
  }

  if (entry.dedicated.kind === 'records') {
    const records = entry.dedicated.leases.map(lease);
    writeJsonFileAtomic(
      paths.controllerLeasesPath,
      entry.schema_current_version == null ? createControllerLeaseAuthority(records) : records,
    );
  } else if (entry.dedicated.kind === 'invalid-record') {
    writeJsonFileAtomic(paths.controllerLeasesPath, {
      ...createControllerLeaseAuthority([]),
      records: [{}],
    });
  } else if (entry.dedicated.kind === 'json-object') {
    writeJsonFileAtomic(paths.controllerLeasesPath, { records: [lease('canonical-active')] });
  } else if (entry.dedicated.kind === 'invalid-json') {
    fs.writeFileSync(paths.controllerLeasesPath, '{ invalid json\n', 'utf8');
  } else if (entry.dedicated.kind === 'missing') {
    fs.unlinkSync(paths.controllerLeasesPath);
  }
  if (entry.state_file === 'missing') fs.unlinkSync(paths.statePath);

  return {
    paths,
    repository: createStateRepository({ repoRoot, projectId: PROJECT_ID }),
  };
}

function materializeSourceRoot() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-lease-source-'));
  tempDirs.push(repoRoot);
  const copiedLib = path.join(repoRoot, 'scripts/ao/lib');
  fs.mkdirSync(path.dirname(copiedLib), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, 'scripts/ao/lib'), copiedLib, { recursive: true });
  return repoRoot;
}

function replaceSource(repoRoot, relativePath, before, after) {
  const sourcePath = path.join(repoRoot, relativePath);
  const source = fs.readFileSync(sourcePath, 'utf8');
  expect(source).toContain(before);
  fs.writeFileSync(sourcePath, source.replace(before, after), 'utf8');
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('controller lease authority design audit', () => {
  it('pins deterministic semantic authority evidence and exhaustive selector coverage', () => {
    expect(validateControllerLeaseInventory(inventory, repositoryRoot)).toMatchObject({
      schema_version: 'ao.controller-lease-authority-evidence.v2',
      semantic_manifest_digest: 'c9760e15ce1feda28032c2113f43d148a2e6425e1730c358ccaa48085106f9f4',
      authority_site_count: 17,
      binding_count: 31,
      selector_counts: {
        'atomic-api': 5,
        'file-name': 3,
        'isolated-path': 12,
        'persist-state-api': 7,
        'state-property': 25,
        'upsert-api': 9,
      },
      selector_evidence_digest: '6c12b0dad1dedf22e5a2582a34d1f9b413b2133dd9a7ac48c2d13ee510833c7e',
      authority_evidence_digest: '1c0e44afb13666c6572cf1718726290d7de86b75fb81feb80c1dee72e48ba2a6',
    });
    expect(scanControllerLeaseSources(inventory, repositoryRoot).match_count).toBe(61);
  });

  it('is stable under formatting-only changes', () => {
    const mutatedRoot = materializeSourceRoot();
    replaceSource(
      mutatedRoot,
      'scripts/ao/lib/state-repository.js',
      'delete nextState.controller_leases;',
      'delete nextState\n      /* formatting-only */ .controller_leases;',
    );
    expect(validateControllerLeaseInventory(inventory, mutatedRoot))
      .toEqual(validateControllerLeaseInventory(inventory, repositoryRoot));
  });

  it('is stable when unrelated source is relocated', () => {
    const mutatedRoot = materializeSourceRoot();
    const from = path.join(mutatedRoot, 'scripts/ao/lib/scorecard.js');
    const to = path.join(mutatedRoot, 'scripts/ao/lib/relocated/scorecard.js');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    expect(validateControllerLeaseInventory(inventory, mutatedRoot))
      .toEqual(validateControllerLeaseInventory(inventory, repositoryRoot));
  });

  it('is stable when a protected authority site is relocated with its bindings', () => {
    const mutatedRoot = materializeSourceRoot();
    const from = path.join(mutatedRoot, 'scripts/ao/lib/state-report.js');
    const to = path.join(mutatedRoot, 'scripts/ao/lib/relocated/state-report.js');
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    expect(validateControllerLeaseInventory(inventory, mutatedRoot))
      .toEqual(validateControllerLeaseInventory(inventory, repositoryRoot));
  });

  it('reports the exact missing authority site identity', () => {
    const mutatedRoot = materializeSourceRoot();
    replaceSource(
      mutatedRoot,
      'scripts/ao/lib/state-report.js',
      'active_controller_leases: ${report.summary.active_controller_lease_count}',
      'active_controller_count: ${report.summary.active_controller_lease_count}',
    );
    expect(() => validateControllerLeaseInventory(inventory, mutatedRoot))
      .toThrow('Controller lease authority site text-report.derived-count failed');
  });

  it('rejects a newly added unregistered authority path with selector locations', () => {
    const mutatedRoot = materializeSourceRoot();
    fs.appendFileSync(
      path.join(mutatedRoot, 'scripts/ao/lib/state-repository.js'),
      '\nfunction uninventoriedShadowWriter() { persistState({ state: {} }); }\n',
      'utf8',
    );

    expect(() => validateControllerLeaseInventory(inventory, mutatedRoot))
      .toThrow('Controller lease selector persist-state-api coverage drifted');
  });

  it('rejects a duplicated authority binding with its stable identity', () => {
    const mutatedRoot = materializeSourceRoot();
    fs.appendFileSync(
      path.join(mutatedRoot, 'scripts/ao/lib/state-report.js'),
      '\nconst duplicateLeaseCount = `active_controller_leases: ${report.summary.active_controller_lease_count}`;\n',
      'utf8',
    );
    expect(() => validateControllerLeaseInventory(inventory, mutatedRoot))
      .toThrow('Controller lease authority binding text-report.derived-count#1 failed');
  });

  it('rejects semantic authority manifest mutation explicitly', () => {
    const semanticDrift = structuredClone(inventory);
    semanticDrift.authority_sites.find((site) => site.id === 'state-report.runtime-summary')
      .roles.push('fallback');
    expect(() => validateControllerLeaseInventory(semanticDrift, repositoryRoot))
      .toThrow('must not retain a fallback or state shadow writer');
  });

  it('rejects a bypassed authority check even when selector counts remain unchanged', () => {
    const mutatedRoot = materializeSourceRoot();
    replaceSource(
      mutatedRoot,
      'scripts/ao/lib/state-repository.js',
      'delete nextState.controller_leases;',
      'void nextState.controller_leases;',
    );
    expect(() => validateControllerLeaseInventory(inventory, mutatedRoot))
      .toThrow('Controller lease authority site repository.ordinary-state-shadow-stripper failed');
  });

  it('replays byte-identical normalized authority evidence deterministically', () => {
    const first = validateControllerLeaseInventory(inventory, repositoryRoot);
    const second = validateControllerLeaseInventory(inventory, repositoryRoot);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const generated = generateControllerLeaseAuthorityEvidence(inventory, repositoryRoot);
    expect(generated.authority_evidence_digest).toBe(first.authority_evidence_digest);
  });

  it('records migration from the accepted v1 whole-source inventory', () => {
    expect(inventory.migrated_from).toEqual({
      schema_version: 'ao.controller-lease-caller-inventory.v1',
      accepted_match_count: 61,
      accepted_source_digest: '825880b4f2765e947b1b17105a5ca422f2028addaa5969ebd2b3089cf6e5b638',
      accepted_caller_metadata_digest: '9a33c814e330606fb9022b399c5feed85b4d37b4886aa24f7c125e5bce141859',
    });
    expect(Object.values(inventory.source_scan.expected_selector_counts)
      .reduce((total, count) => total + count, 0)).toBe(inventory.migrated_from.accepted_match_count);
  });

  it('fails closed when frozen authority or semantic manifest evidence drifts', () => {
    const shadowAuthority = structuredClone(inventory);
    shadowAuthority.authority_design.state_shadow_recovery_authority = true;
    expect(() => validateControllerLeaseInventory(shadowAuthority, repositoryRoot))
      .toThrow('prohibit state.json shadow recovery authority');

    const projectionDrift = structuredClone(inventory);
    projectionDrift.authority_design.missing_authority_policy = 'fall back to state.json';
    expect(() => validateControllerLeaseInventory(projectionDrift, repositoryRoot))
      .toThrow('complete frozen controller lease authority design has drifted');

    const selectorDrift = structuredClone(inventory);
    selectorDrift.source_scan.expected_selector_counts['state-property'] -= 1;
    expect(() => validateControllerLeaseInventory(selectorDrift, repositoryRoot))
      .toThrow('frozen controller lease semantic manifest has drifted');
  });

  it('covers success, failure, missing, malformed, mixed-version, and replay fixtures', () => {
    expect(new Set(fixturePack.cases.map((entry) => entry.class))).toEqual(new Set([
      'success',
      'failure',
      'missing',
      'malformed',
      'mixed-version',
      'replay',
    ]));
  });

  it.each(fixturePack.cases.filter((entry) => entry.expected.outcome === 'snapshot'))(
    'characterizes snapshot result for $id',
    (entry) => {
      const { repository } = materializeFixture(entry);
      const snapshot = repository.getSnapshot();
      expect(snapshot.state.controller_leases.map((record) => record.lease_id))
        .toEqual(entry.expected.lease_ids);
      if (entry.expected.bootstrapped != null) {
        expect(snapshot.bootstrapped).toBe(entry.expected.bootstrapped);
      }
      if (entry.expected.schema_current_version != null) {
        expect(snapshot.schema.current_version).toBe(entry.expected.schema_current_version);
      }
    },
  );

  it.each(fixturePack.cases.filter((entry) => entry.expected.outcome === 'throw'))(
    'characterizes fail-closed parse/validation result for $id',
    (entry) => {
      const { repository } = materializeFixture(entry);
      if (entry.expected.error_name === 'SyntaxError') {
        expect(() => repository.getSnapshot()).toThrow(SyntaxError);
      } else {
        expect(() => repository.getSnapshot()).toThrow(entry.expected.message);
      }
    },
  );

  it('replays the projection without mutating either persistent file', () => {
    const entry = fixturePack.cases.find((candidate) => candidate.class === 'replay');
    const { paths, repository } = materializeFixture(entry);
    const beforeState = fs.readFileSync(paths.statePath);
    const beforeAuthority = fs.readFileSync(paths.controllerLeasesPath);

    const first = repository.getSnapshot();
    const second = repository.getSnapshot();

    expect(second).toEqual(first);
    expect(second.state.controller_leases.map((record) => record.lease_id)).toEqual(entry.expected.lease_ids);
    expect(fs.readFileSync(paths.statePath)).toEqual(beforeState);
    expect(fs.readFileSync(paths.controllerLeasesPath)).toEqual(beforeAuthority);
  });

  it('proves missing and malformed canonical authority fail closed without shadow recovery', () => {
    const closedCases = fixturePack.cases.filter((entry) => (
      ['missing', 'malformed'].includes(entry.class)
    ));
    expect(closedCases).toHaveLength(4);
    for (const entry of closedCases) {
      const { repository } = materializeFixture(entry);
      expect(() => repository.getSnapshot()).toThrow();
    }
    expect(inventory.authority_design).toMatchObject({
      canonical_persistent_authority: 'controller-leases.json',
      projection_persistent: false,
      state_shadow_recovery_authority: false,
      malformed_authority_policy: 'fail_closed',
    });
  });

  it('proves ordinary state persistence cannot write, refresh, overwrite, or revive lease authority', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-lease-shadow-'));
    tempDirs.push(repoRoot);
    const repository = createStateRepository({ repoRoot, projectId: PROJECT_ID });
    repository.upsertControllerLease(lease('canonical-first'));
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'off',
      updated_at: NOW,
      updated_by: 'audit-fixture',
      reason: 'Characterize ordinary state persistence.',
    }));

    const paths = repository.getSnapshot().paths;
    const persistedState = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    expect(persistedState).not.toHaveProperty('controller_leases');

    repository.upsertControllerLease(lease('canonical-later'));
    expect(repository.getSnapshot().state.controller_leases.map((record) => record.lease_id))
      .toEqual(['canonical-first', 'canonical-later']);

    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))).not.toHaveProperty('controller_leases');
    fs.unlinkSync(paths.controllerLeasesPath);
    expect(() => repository.getSnapshot()).toThrow('Missing canonical controller lease authority');
  });
});
