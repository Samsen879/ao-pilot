import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
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
  'docs/foundation/controller-lease-caller-inventory.v1.json',
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

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe('controller lease authority design audit', () => {
  it('pins an exhaustive deterministic source scan and every semantic caller anchor', () => {
    expect(validateControllerLeaseInventory(inventory, repositoryRoot)).toEqual({
      caller_count: 15,
      caller_metadata_digest: '9a33c814e330606fb9022b399c5feed85b4d37b4886aa24f7c125e5bce141859',
      source_match_count: 61,
      source_digest: '05763e8eb978eb861499242063d69354bfafe6885a449d66297b9ebe622a07b1',
    });
    expect(scanControllerLeaseSources(inventory, repositoryRoot).matches).toHaveLength(61);
  });

  it('rejects a newly added uninventoried generic state shadow writer', () => {
    const mutatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-lease-source-mutation-'));
    tempDirs.push(mutatedRoot);
    const copiedLib = path.join(mutatedRoot, 'scripts/ao/lib');
    fs.mkdirSync(path.dirname(copiedLib), { recursive: true });
    fs.cpSync(path.join(repositoryRoot, 'scripts/ao/lib'), copiedLib, { recursive: true });
    fs.appendFileSync(
      path.join(copiedLib, 'state-repository.js'),
      '\nfunction uninventoriedShadowWriter() { persistState({ state: {} }); }\n',
      'utf8',
    );

    expect(() => validateControllerLeaseInventory(inventory, mutatedRoot))
      .toThrow('source match count drifted');
  });

  it('fails the audit when authority, source evidence, or caller evidence drifts', () => {
    const shadowAuthority = structuredClone(inventory);
    shadowAuthority.authority_design.state_shadow_recovery_authority = true;
    expect(() => validateControllerLeaseInventory(shadowAuthority, repositoryRoot))
      .toThrow('prohibit state.json shadow recovery authority');

    const sourceDrift = structuredClone(inventory);
    sourceDrift.source_scan.expected_digest = '0'.repeat(64);
    expect(() => validateControllerLeaseInventory(sourceDrift, repositoryRoot))
      .toThrow('source inventory drifted');

    const projectionDrift = structuredClone(inventory);
    projectionDrift.authority_design.missing_authority_policy = 'fall back to state.json';
    expect(() => validateControllerLeaseInventory(projectionDrift, repositoryRoot))
      .toThrow('complete frozen controller lease authority design has drifted');

    const missingAnchor = structuredClone(inventory);
    missingAnchor.callers[0].anchors = ['not present in the governed source'];
    expect(() => validateControllerLeaseInventory(missingAnchor, repositoryRoot))
      .toThrow('caller or governed-base metadata has drifted');

    const callerMetadataDrift = structuredClone(inventory);
    callerMetadataDrift.callers[0].symbol = 'misclassifiedSymbol';
    expect(() => validateControllerLeaseInventory(callerMetadataDrift, repositoryRoot))
      .toThrow('caller or governed-base metadata has drifted');

    const governedBaseDrift = structuredClone(inventory);
    governedBaseDrift.governed_base.tree = '0'.repeat(40);
    expect(() => validateControllerLeaseInventory(governedBaseDrift, repositoryRoot))
      .toThrow('caller or governed-base metadata has drifted');
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
