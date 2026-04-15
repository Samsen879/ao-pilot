import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  bootstrapControlPlaneState,
  resolveControlPlanePaths,
} from '../../scripts/ao/lib/state-migrations.js';

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
      current_version: 10,
      latest_version: 10,
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
    ]);
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
    expect(readAuditEntries(paths.auditPath)).toHaveLength(10);
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
      current_version: 10,
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
