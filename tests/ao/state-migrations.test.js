import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from '@jest/globals';

import { createControllerLease } from '../../scripts/ao/lib/state-contracts.js';
import {
  createControllerLeaseAuthority,
  digestControllerLeaseAuthorityEvidence,
} from '../../scripts/ao/lib/controller-lease-authority.js';
import {
  bootstrapControlPlaneState,
  resolveControlPlanePaths,
} from '../../scripts/ao/lib/state-migrations.js';
import { withFileLock } from '../../scripts/ao/lib/state-storage.js';

const PROJECT_ID = 'my-project';
const FIXED_NOW = '2026-03-29T04:45:00.000Z';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-control-plane-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readAuditEntries(filePath) {
  const text = fs.readFileSync(filePath, 'utf8').trim();
  if (!text) return [];
  return text.split('\n').map((line) => JSON.parse(line));
}

async function waitForPath(filePath, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function controllerLease(leaseId = 'controller-default-migrated') {
  return createControllerLease({
    lease_id: leaseId,
    controller_id: 'default',
    holder_id: 'migration-holder',
    holder_type: 'session',
    incarnation_id: 'migration-incarnation',
    status: 'active',
    acquired_at: FIXED_NOW,
    heartbeat_at: FIXED_NOW,
    expires_at: '2026-03-29T04:44:00.000Z',
    lease_timeout_ms: 3600000,
    runtime_kind: 'continuous',
  });
}

function materializeVersion10({ shadow = [controllerLease()], canonical = null, omitShadow = false } = {}) {
  const repoRoot = createTempRepo();
  bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
  const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
  const schema = readJson(paths.schemaPath);
  schema.current_version = 10;
  schema.latest_version = 10;
  schema.applied_migrations = schema.applied_migrations.filter((entry) => entry.version <= 10);
  fs.writeFileSync(paths.schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
  const state = readJson(paths.statePath);
  if (omitShadow) delete state.controller_leases;
  else state.controller_leases = shadow;
  fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  if (canonical == null) fs.unlinkSync(paths.controllerLeasesPath);
  else fs.writeFileSync(paths.controllerLeasesPath, `${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
  const priorAudit = readAuditEntries(paths.auditPath).filter((entry) => entry.entity_id !== 'v11');
  fs.writeFileSync(paths.auditPath, `${priorAudit.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  return { repoRoot, paths };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao state migrations', () => {
  it('rejects project ids that could escape the repo-local control-plane root', () => {
    const repoRoot = createTempRepo();

    expect(() => resolveControlPlanePaths({
      repoRoot,
      projectId: '../../escape',
    })).toThrow(/projectId/i);
    expect(() => resolveControlPlanePaths({
      repoRoot,
      projectId: 'nested/project',
    })).toThrow(/projectId/i);
  });

  it('bootstraps a fresh repo-local control-plane schema', () => {
    const repoRoot = createTempRepo();

    const result = bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: FIXED_NOW,
    });
    const paths = resolveControlPlanePaths({
      repoRoot,
      projectId: PROJECT_ID,
    });

    expect(result).toMatchObject({
      bootstrapped: true,
      migrated: true,
      state_root: paths.stateRoot,
    });
    expect(fs.existsSync(paths.schemaPath)).toBe(true);
    expect(fs.existsSync(paths.statePath)).toBe(true);
    expect(fs.existsSync(paths.auditPath)).toBe(true);

    expect(readJson(paths.schemaPath)).toMatchObject({
      project_id: PROJECT_ID,
      current_version: 11,
      latest_version: 11,
      applied_migrations: [
        {
          version: 1,
          key: '0001_bootstrap_control_plane_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 2,
          key: '0002_task_spec_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 3,
          key: '0003_delivery_events_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 4,
          key: '0004_policy_engine_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 5,
          key: '0005_runtime_preflight_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 6,
          key: '0006_checkpoint_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 7,
          key: '0007_handoff_protocol_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 8,
          key: '0008_measurement_metrics_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 9,
          key: '0009_repo_knowledge_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 10,
          key: '0010_review_gate_v1',
          applied_at: FIXED_NOW,
        },
        {
          version: 11,
          key: '0011_controller_lease_authority_v1',
          applied_at: FIXED_NOW,
        },
      ],
    });
    expect(readJson(paths.statePath)).toMatchObject({
      project_id: PROJECT_ID,
      delivery_events: [],
      policy_decisions: [],
      credential_provenances: [],
      task_specs: [],
      runtime_preflights: [],
      repo_knowledge: [],
      review_records: [],
      checkpoints: [],
      handoff_requests: [],
      handoff_claims: [],
      handoff_decisions: [],
      handoff_transfers: [],
      controller_run_metrics: [],
      execution_attempt_metrics: [],
      controller_modes: [
        {
          controller_id: 'default',
          mode: 'off',
          updated_at: FIXED_NOW,
        },
      ],
    });

    expect(readAuditEntries(paths.auditPath)).toEqual([
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v1',
        operation: 'bootstrap',
        summary: 'Applied control-plane bootstrap migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v2',
        operation: 'migrate',
        summary: 'Applied control-plane task-spec migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v3',
        operation: 'migrate',
        summary: 'Applied control-plane delivery-event migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v4',
        operation: 'migrate',
        summary: 'Applied control-plane policy-engine migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v5',
        operation: 'migrate',
        summary: 'Applied control-plane runtime-preflight migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v6',
        operation: 'migrate',
        summary: 'Applied control-plane checkpoint migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v7',
        operation: 'migrate',
        summary: 'Applied control-plane handoff-protocol migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v8',
        operation: 'migrate',
        summary: 'Applied control-plane measurement-metrics migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v9',
        operation: 'migrate',
        summary: 'Applied control-plane repo-knowledge migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v10',
        operation: 'migrate',
        summary: 'Applied control-plane review-gate migration.',
      }),
      expect.objectContaining({
        entity_kind: 'schema',
        entity_id: 'v11',
        operation: 'migrate',
        summary: 'Applied canonical controller-lease authority migration.',
        details: expect.objectContaining({
          migration_key: '0011_controller_lease_authority_v1',
          canonical_authority: 'controller-leases.json',
          authority_source: 'fresh_state_provenance',
          controller_lease_count: 0,
          state_shadow_removed: false,
        }),
      }),
    ]);
    expect(readJson(paths.controllerLeasesPath)).toEqual(createControllerLeaseAuthority([]));
    expect(readJson(paths.statePath)).not.toHaveProperty('controller_leases');
    expect(readJson(paths.controllerLeaseMigrationReceiptPath)).toMatchObject({
      schema_version: 'ao.controller-lease-migration-receipt.v1',
      source_schema_version: 0,
      destination_schema_version: 11,
      source_evidence_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      destination_authority_digest: digestControllerLeaseAuthorityEvidence(
        createControllerLeaseAuthority([]),
      ),
    });
    expect(readJson(paths.bootstrapProvenancePath)).toMatchObject({
      status: 'complete',
      source: 'fresh_state_root',
    });
  });

  it('is idempotent when the repo-local control-plane schema already exists', () => {
    const repoRoot = createTempRepo();

    bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: FIXED_NOW,
    });
    const second = bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    });
    const paths = resolveControlPlanePaths({
      repoRoot,
      projectId: PROJECT_ID,
    });

    expect(second).toMatchObject({
      bootstrapped: true,
      migrated: false,
    });
    expect(readJson(paths.schemaPath).updated_at).toBe(FIXED_NOW);
    expect(readAuditEntries(paths.auditPath)).toHaveLength(11);
  });

  it('migrates a legacy state shadow once with explicit schema and audit receipts', () => {
    const { repoRoot, paths } = materializeVersion10();

    const first = bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    });
    const firstBytes = {
      schema: fs.readFileSync(paths.schemaPath),
      state: fs.readFileSync(paths.statePath),
      authority: fs.readFileSync(paths.controllerLeasesPath),
      audit: fs.readFileSync(paths.auditPath),
    };
    const second = bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T06:00:00.000Z',
    });

    expect(first).toMatchObject({ bootstrapped: true, migrated: true });
    expect(second).toMatchObject({ bootstrapped: true, migrated: false });
    expect(readJson(paths.statePath)).not.toHaveProperty('controller_leases');
    expect(readJson(paths.controllerLeasesPath)).toEqual(createControllerLeaseAuthority([controllerLease()]));
    expect(readJson(paths.schemaPath).applied_migrations.at(-1)).toMatchObject({
      version: 11,
      key: '0011_controller_lease_authority_v1',
    });
    expect(readAuditEntries(paths.auditPath).at(-1)).toMatchObject({
      entity_id: 'v11',
      operation: 'migrate',
      details: {
        migration_key: '0011_controller_lease_authority_v1',
        migration_version: 11,
        canonical_authority: 'controller-leases.json',
        authority_source: 'legacy_state_shadow_migration',
        controller_lease_count: 1,
        state_shadow_removed: true,
      },
    });
    expect(fs.readFileSync(paths.schemaPath)).toEqual(firstBytes.schema);
    expect(fs.readFileSync(paths.statePath)).toEqual(firstBytes.state);
    expect(fs.readFileSync(paths.controllerLeasesPath)).toEqual(firstBytes.authority);
    expect(fs.readFileSync(paths.auditPath)).toEqual(firstBytes.audit);
  });

  it('preserves valid canonical authority during migration and discards the legacy shadow', () => {
    const canonical = [controllerLease('controller-default-canonical')];
    const shadow = [controllerLease('controller-default-shadow')];
    const { repoRoot, paths } = materializeVersion10({ canonical, shadow });

    bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    });

    expect(readJson(paths.controllerLeasesPath)).toEqual(createControllerLeaseAuthority(canonical));
    expect(readJson(paths.statePath)).not.toHaveProperty('controller_leases');
    expect(readAuditEntries(paths.auditPath).at(-1).details).toMatchObject({
      authority_source: 'legacy_canonical_array_migration',
      controller_lease_count: 1,
      state_shadow_removed: true,
    });
  });

  it('fails closed without migration evidence and leaves every persistent file untouched', () => {
    const { repoRoot, paths } = materializeVersion10({ omitShadow: true });
    const before = {
      schema: fs.readFileSync(paths.schemaPath),
      state: fs.readFileSync(paths.statePath),
      audit: fs.readFileSync(paths.auditPath),
    };

    expect(() => bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    })).toThrow('Missing canonical controller lease authority and no explicit migration evidence');
    expect(fs.existsSync(paths.controllerLeasesPath)).toBe(false);
    expect(fs.readFileSync(paths.schemaPath)).toEqual(before.schema);
    expect(fs.readFileSync(paths.statePath)).toEqual(before.state);
    expect(fs.readFileSync(paths.auditPath)).toEqual(before.audit);
  });

  it('fails closed on malformed canonical migration authority without selecting a valid shadow', () => {
    const { repoRoot, paths } = materializeVersion10({ canonical: { records: [controllerLease()] } });
    const beforeAuthority = fs.readFileSync(paths.controllerLeasesPath);

    expect(() => bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    })).toThrow('Unsupported canonical controller lease authority version');
    expect(fs.readFileSync(paths.controllerLeasesPath)).toEqual(beforeAuthority);
    expect(readJson(paths.statePath)).toHaveProperty('controller_leases');
    expect(readJson(paths.schemaPath).current_version).toBe(10);
  });

  it('serializes v10 migration with the controller lease mutation lock', async () => {
    const { repoRoot, paths } = materializeVersion10();
    const lockPath = `${paths.controllerLeasesPath}.lock`;

    await withFileLock(lockPath, async () => {
      expect(() => bootstrapControlPlaneState({
        repoRoot,
        projectId: PROJECT_ID,
        now: '2026-03-29T05:00:00.000Z',
        controllerLeaseLockTimeoutMs: 20,
        controllerLeaseLockRetryMs: 2,
      })).toThrow('Timed out acquiring file lock controller-leases.json.lock');
      expect(readJson(paths.schemaPath).current_version).toBe(10);
      expect(fs.existsSync(paths.controllerLeasesPath)).toBe(false);
    });

    expect(bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    })).toMatchObject({ migrated: true });
  });

  it('repairs a missing v11 audit receipt idempotently from its durable migration receipt', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const withoutV11 = readAuditEntries(paths.auditPath).filter((entry) => entry.entity_id !== 'v11');
    fs.writeFileSync(paths.auditPath, `${withoutV11.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const checkpoint = readJson(paths.controllerLeaseMigrationAuditCheckpointPath);
    checkpoint.status = 'pending';
    fs.writeFileSync(
      paths.controllerLeaseMigrationAuditCheckpointPath,
      `${JSON.stringify(checkpoint, null, 2)}\n`,
      'utf8',
    );

    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: '2026-03-29T06:00:00.000Z' });
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: '2026-03-29T07:00:00.000Z' });

    const receipts = readAuditEntries(paths.auditPath).filter((entry) => entry.entity_id === 'v11');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].details.destination_authority_digest).toBe(
      readJson(paths.controllerLeaseMigrationReceiptPath).destination_authority_digest,
    );
  });

  it('fails closed on unsupported authority envelopes and tampered receipt digests', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const unsupported = readJson(paths.controllerLeasesPath);
    unsupported.schema_version = 'ao.controller-lease-authority.v2';
    fs.writeFileSync(paths.controllerLeasesPath, `${JSON.stringify(unsupported, null, 2)}\n`, 'utf8');
    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Unsupported canonical controller lease authority version');

    fs.writeFileSync(
      paths.controllerLeasesPath,
      `${JSON.stringify(createControllerLeaseAuthority([]), null, 2)}\n`,
      'utf8',
    );
    const receipt = readJson(paths.controllerLeaseMigrationReceiptPath);
    receipt.destination_authority_digest = `sha256:${'0'.repeat(64)}`;
    fs.writeFileSync(paths.controllerLeaseMigrationReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Malformed controller lease authority migration receipt');
  });

  it('fails closed rather than blessing a corrupted receipt during pending audit repair', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const withoutV11 = readAuditEntries(paths.auditPath).filter((entry) => entry.entity_id !== 'v11');
    fs.writeFileSync(paths.auditPath, `${withoutV11.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    const checkpoint = readJson(paths.controllerLeaseMigrationAuditCheckpointPath);
    checkpoint.status = 'pending';
    fs.writeFileSync(paths.controllerLeaseMigrationAuditCheckpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    const receipt = readJson(paths.controllerLeaseMigrationReceiptPath);
    receipt.source_evidence_digest = `sha256:${'f'.repeat(64)}`;
    fs.writeFileSync(paths.controllerLeaseMigrationReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Malformed controller lease authority migration receipt');
    expect(readAuditEntries(paths.auditPath).some((entry) => entry.entity_id === 'v11')).toBe(false);
  });

  it('binds migration receipts and fresh-root provenance to the requested project', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const receipt = readJson(paths.controllerLeaseMigrationReceiptPath);
    receipt.project_id = 'another-project';
    const receiptEvidence = { ...receipt };
    delete receiptEvidence.receipt_integrity_digest;
    receipt.receipt_integrity_digest = digestControllerLeaseAuthorityEvidence(receiptEvidence);
    fs.writeFileSync(paths.controllerLeaseMigrationReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Malformed controller lease authority migration receipt');

    const otherRepoRoot = createTempRepo();
    const otherPaths = resolveControlPlanePaths({ repoRoot: otherRepoRoot, projectId: PROJECT_ID });
    fs.mkdirSync(otherPaths.stateRoot, { recursive: true });
    fs.writeFileSync(otherPaths.bootstrapProvenancePath, `${JSON.stringify({
      schema_version: 'ao.control-plane-bootstrap-provenance.v1',
      format: 'ao_control_plane_bootstrap_provenance',
      project_id: 'another-project',
      status: 'initializing',
      source: 'fresh_state_root',
      recorded_at: FIXED_NOW,
    }, null, 2)}\n`);
    expect(() => bootstrapControlPlaneState({ repoRoot: otherRepoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Malformed control-plane bootstrap provenance');
  });

  it('detects a legacy state writer change before committing the v11 rewrite', async () => {
    const { repoRoot, paths } = materializeVersion10();
    const migrationModuleUrl = pathToFileURL(
      path.resolve('scripts/ao/lib/state-migrations.js'),
    ).href;
    let child;
    let childResult;

    await withFileLock(paths.stateWriteLockPath, async () => {
      child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        `import { bootstrapControlPlaneState } from ${JSON.stringify(migrationModuleUrl)};
try {
  bootstrapControlPlaneState({ repoRoot: process.argv[1], projectId: ${JSON.stringify(PROJECT_ID)}, now: '2026-03-29T05:00:00.000Z' });
  process.exitCode = 0;
} catch (error) {
  process.stderr.write(String(error.message));
  process.exitCode = 2;
}`,
        repoRoot,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      await waitForPath(`${paths.controllerLeasesPath}.lock`);
      const state = readJson(paths.statePath);
      state.actions.push({ action_id: 'legacy-writer-race' });
      fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
      childResult = new Promise((resolve) => {
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('close', (code) => resolve({ code, stderr }));
      });
    });
    const result = await childResult;

    expect(result).toMatchObject({ code: 2 });
    expect(result.stderr).toContain(
      'Legacy state writer changed state.json during v11 migration; quiescence not established',
    );
    expect(readJson(paths.schemaPath).current_version).toBe(10);
    expect(readJson(paths.statePath).actions).toContainEqual({ action_id: 'legacy-writer-race' });
  });

  it('requires explicit legacy-controller quiescence before rewriting v10 state', () => {
    const liveLease = {
      ...controllerLease(),
      expires_at: '2026-03-29T06:00:00.000Z',
    };
    const { repoRoot, paths } = materializeVersion10({ shadow: [liveLease] });

    expect(() => bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T05:00:00.000Z',
    })).toThrow('Legacy controller writer quiescence required before v11 migration');
    expect(readJson(paths.schemaPath).current_version).toBe(10);
    expect(readJson(paths.statePath).controller_leases).toEqual([liveLease]);
  });

  it('uses the bounded audit checkpoint on the steady-state bootstrap path', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    fs.renameSync(paths.auditPath, `${paths.auditPath}.held`);

    expect(bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toMatchObject({ bootstrapped: true, migrated: false });
    expect(fs.existsSync(paths.auditPath)).toBe(false);
  });

  it('fails closed if a legacy writer revives the forbidden shadow after migration', () => {
    const repoRoot = createTempRepo();
    bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW });
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    const state = readJson(paths.statePath);
    state.controller_leases = [controllerLease('controller-default-revived')];
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);

    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('Prohibited controller_leases shadow detected in v11 state.json');
  });

  it('resumes an atomically claimed fresh root with initializing provenance', () => {
    const repoRoot = createTempRepo();
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    fs.mkdirSync(paths.stateRoot, { recursive: true });
    fs.writeFileSync(paths.bootstrapProvenancePath, `${JSON.stringify({
      schema_version: 'ao.control-plane-bootstrap-provenance.v1',
      format: 'ao_control_plane_bootstrap_provenance',
      project_id: PROJECT_ID,
      status: 'initializing',
      source: 'fresh_state_root',
      recorded_at: FIXED_NOW,
    }, null, 2)}\n`);

    expect(bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toMatchObject({ bootstrapped: true, migrated: true });
    expect(readJson(paths.bootstrapProvenancePath).status).toBe('complete');
  });

  it('requires positive fresh-root provenance and rejects partially restored roots', () => {
    const repoRoot = createTempRepo();
    const paths = resolveControlPlanePaths({ repoRoot, projectId: PROJECT_ID });
    fs.mkdirSync(paths.stateRoot, { recursive: true });
    fs.writeFileSync(paths.auditPath, '{"surviving":"artifact"}\n', 'utf8');

    expect(() => bootstrapControlPlaneState({ repoRoot, projectId: PROJECT_ID, now: FIXED_NOW }))
      .toThrow('existing or orphaned state root cannot initialize empty authority');
    expect(fs.existsSync(paths.schemaPath)).toBe(false);
    expect(fs.existsSync(paths.statePath)).toBe(false);
    expect(fs.existsSync(paths.controllerLeasesPath)).toBe(false);
  });

  it('upgrades a stale schema version and backfills invalid task specs for enrolled tasks', () => {
    const repoRoot = createTempRepo();
    const paths = resolveControlPlanePaths({
      repoRoot,
      projectId: PROJECT_ID,
    });

    fs.mkdirSync(paths.stateRoot, { recursive: true });
    fs.writeFileSync(paths.schemaPath, `${JSON.stringify({
      schema_version: 'ao.control-plane.schema.v1alpha1',
      format: 'ao_control_plane_schema',
      project_id: PROJECT_ID,
      current_version: 1,
      latest_version: 7,
      created_at: '2026-03-29T03:00:00.000Z',
      updated_at: '2026-03-29T03:00:00.000Z',
      applied_migrations: [
        {
          version: 1,
          key: '0001_bootstrap_control_plane_v1',
          applied_at: '2026-03-29T03:00:00.000Z',
        },
      ],
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(paths.statePath, `${JSON.stringify({
      schema_version: 'ao.control-plane.state.v1alpha1',
      format: 'ao_control_plane_state',
      project_id: PROJECT_ID,
      created_at: '2026-03-29T03:00:00.000Z',
      updated_at: '2026-03-29T03:00:00.000Z',
      managed_tasks: [
        {
          task_id: 'issue-105',
          issue_number: 105,
          title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
          branch_name: 'feat/105',
          worktree_path: '/tmp/worker-52',
          status: 'active',
          created_at: '2026-03-29T03:00:00.000Z',
          updated_at: '2026-03-29T03:00:00.000Z',
          metadata: {},
        },
      ],
      pr_bindings: [],
      ownership_leases: [],
      controller_leases: [],
      actions: [],
      overrides: [],
      controller_modes: [
        {
          controller_id: 'default',
          mode: 'off',
          updated_at: '2026-03-29T03:00:00.000Z',
          updated_by: 'bootstrap',
          reason: 'Initialized repo-local AO control-plane state.',
        },
      ],
      observations: [],
      delivery_events: [],
      controller_cursors: [],
    }, null, 2)}\n`, 'utf8');

    const result = bootstrapControlPlaneState({
      repoRoot,
      projectId: PROJECT_ID,
      now: FIXED_NOW,
    });

    expect(result).toMatchObject({
      bootstrapped: true,
      migrated: true,
    });
    expect(readJson(paths.schemaPath)).toMatchObject({
      current_version: 11,
      applied_migrations: [
        {
          version: 1,
          key: '0001_bootstrap_control_plane_v1',
        },
        {
          version: 2,
          key: '0002_task_spec_v1',
        },
        {
          version: 3,
          key: '0003_delivery_events_v1',
        },
        {
          version: 4,
          key: '0004_policy_engine_v1',
        },
        {
          version: 5,
          key: '0005_runtime_preflight_v1',
        },
        {
          version: 6,
          key: '0006_checkpoint_v1',
        },
        {
          version: 7,
          key: '0007_handoff_protocol_v1',
        },
        {
          version: 8,
          key: '0008_measurement_metrics_v1',
        },
        {
          version: 9,
          key: '0009_repo_knowledge_v1',
        },
        {
          version: 10,
          key: '0010_review_gate_v1',
        },
        {
          version: 11,
          key: '0011_controller_lease_authority_v1',
        },
      ],
    });
    expect(readJson(paths.statePath)).toMatchObject({
      delivery_events: [],
      policy_decisions: [],
      credential_provenances: [],
      runtime_preflights: [],
      review_records: [],
      checkpoints: [],
      handoff_requests: [],
      handoff_claims: [],
      handoff_decisions: [],
      handoff_transfers: [],
      task_specs: [
        {
          task_id: 'issue-105',
          state: 'invalid',
          source_kind: 'migration_backfill',
          source_issue_number: 105,
          snapshot: {
            schema_version: 'ao.task-spec.v1alpha1',
            valid: false,
          },
        },
      ],
    });
  });
});
