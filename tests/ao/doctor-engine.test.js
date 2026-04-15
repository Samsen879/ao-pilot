import { describe, expect, it } from '@jest/globals';
import {
  createDoctorLocalState,
  createDoctorPrScope,
  createDoctorProjectScope,
} from '../../scripts/ao/lib/doctor-contracts.js';
import { CONTROL_PLANE_LATEST_VERSION } from '../../scripts/ao/lib/state-contracts.js';
import { buildDoctorReport } from '../../scripts/ao/lib/doctor-engine.js';

function buildReconciliationReport(overrides = {}) {
  return {
    schema_version: 'ao.reconciliation.v1alpha1',
    report_format: 'ao_reconciliation_report',
    engine_version: 'phase1-foundation',
    project_id: 'my-project',
    observed_at: '2026-03-24T14:00:00.000Z',
    scope: {
      mode: 'project',
      selected_pr_numbers: [],
    },
    top_status: 'healthy',
    automation_disposition: 'continue',
    source_health: {
      ao: 'ok',
      github: 'ok',
    },
    pr_assessments: [],
    project_summary: {
      selected_pr_count: 0,
      ready_pr_numbers: [],
      blocked_pr_numbers: [],
      ambiguous_pr_numbers: [],
      warning_pr_numbers: [],
      not_applicable_pr_numbers: [],
      basis: [],
    },
    findings: [],
    recommended_actions: [],
    ...overrides,
  };
}

function buildLocalState(overrides = {}) {
  return createDoctorLocalState({
    repo_root: '/home/user/my-project',
    cwd: '/home/user/my-project',
    current_branch: 'feat/issue-44',
    head_sha: 'abc123',
    detached_head: false,
    upstream_branch: 'origin/feat/issue-44',
    upstream_tracking: 'present',
    worktree_dirty: false,
    staged_changes: false,
    unstaged_changes: false,
    untracked_file_count: 0,
    untracked_file_samples: [],
    ao_artifact_paths: [],
    git_observable: true,
    git_error: null,
    ...overrides,
  });
}

function buildControlPlaneSnapshot(overrides = {}) {
  return {
    bootstrapped: true,
    schema: {
      current_version: CONTROL_PLANE_LATEST_VERSION,
      latest_version: CONTROL_PLANE_LATEST_VERSION,
    },
    state: {
      managed_tasks: [],
      task_specs: [],
      runtime_preflights: [],
    },
    ...overrides,
  };
}

describe('doctor engine', () => {
  it('preserves reconciliation findings with reconciliation origin', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport({
        findings: [{
          code: 'no_orchestrator_session',
          severity: 'warning',
          subject_type: 'project',
          subject_id: 'my-project',
          summary: 'No orchestrator session is visible.',
          details: [],
          evidence_refs: [],
        }],
      }),
      localState: buildLocalState(),
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'no_orchestrator_session',
        origin: 'reconciliation',
      }),
    ]));
  });

  it('adds dirty worktree warnings and deduplicated suggestions', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState({
        worktree_dirty: true,
        staged_changes: true,
        unstaged_changes: true,
      }),
    });

    expect(report.top_status).toBe('warning');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'dirty_worktree',
      'staged_changes_present',
    ]));
    expect(report.suggestions.map((suggestion) => suggestion.id)).toEqual([
      'git_status',
    ]);
  });

  it('blocks on detached head and warns on upstream tracking gaps', () => {
    const report = buildDoctorReport({
      scope: createDoctorPrScope({ projectId: 'my-project', prNumber: 44 }),
      reconciliationReport: buildReconciliationReport({
        scope: { mode: 'pr', selected_pr_numbers: [44] },
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          release_readiness: { status: 'ready' },
        }],
      }),
      localState: buildLocalState({
        current_branch: null,
        detached_head: true,
        upstream_branch: null,
        upstream_tracking: 'missing',
      }),
    });

    expect(report.top_status).toBe('blocked');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'detached_head',
      'missing_upstream_tracking',
    ]));
  });

  it('adds branch mismatch ambiguity only when one active target is resolved', () => {
    const report = buildDoctorReport({
      scope: createDoctorPrScope({ projectId: 'my-project', prNumber: 44 }),
      reconciliationReport: buildReconciliationReport({
        scope: { mode: 'pr', selected_pr_numbers: [44] },
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          release_readiness: { status: 'ready' },
        }],
      }),
      localState: buildLocalState({
        current_branch: 'feat/other-branch',
      }),
    });

    expect(report.top_status).toBe('ambiguous');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'current_branch_mismatch',
      'pr_scope_not_linked_to_current_branch',
    ]));
    expect(report.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'reconcile_scope',
        commands: ['node scripts/ao-reconcile.js --pr 44 --json --strict'],
      }),
    ]));
  });

  it('suppresses branch-alignment findings when project mode has multiple targets', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport({
        scope: { mode: 'project', selected_pr_numbers: [40, 41] },
        pr_assessments: [
          { pr_number: 40, branch_name: 'feat/issue-40', release_readiness: { status: 'ready' } },
          { pr_number: 41, branch_name: 'feat/issue-41', release_readiness: { status: 'ambiguous' } },
        ],
      }),
      localState: buildLocalState({
        current_branch: 'feat/issue-40',
      }),
    });

    expect(report.findings.map((finding) => finding.code)).toContain('doctor_scope_multiple_targets');
    expect(report.findings.map((finding) => finding.code)).not.toContain('current_branch_mismatch');
    expect(report.findings.map((finding) => finding.code)).not.toContain('pr_scope_not_linked_to_current_branch');
  });

  it('treats missing git observability as source failure', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState({
        repo_root: null,
        current_branch: null,
        git_observable: false,
        git_error: 'fatal: not a git repository',
        worktree_dirty: null,
        staged_changes: null,
        unstaged_changes: null,
      }),
    });

    expect(report.source_health.git).toBe('failed');
    expect(report.source_health.worktree).toBe('failed');
    expect(report.top_status).toBe('source_failure');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'local_git_not_observable',
      'worktree_not_observable',
    ]));
  });

  it('records AO artifact leftovers as info and scope conflicts as warnings', () => {
    const report = buildDoctorReport({
      scope: createDoctorPrScope({ projectId: 'my-project', prNumber: 44 }),
      reconciliationReport: buildReconciliationReport({
        scope: { mode: 'pr', selected_pr_numbers: [44] },
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          release_readiness: { status: 'ready' },
        }],
      }),
      localState: buildLocalState({
        current_branch: 'feat/other-branch',
        ao_artifact_paths: ['.ao-current-issue', 'ao-artifacts/'],
      }),
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ao_artifact_leftovers',
        severity: 'info',
      }),
      expect.objectContaining({
        code: 'ao_artifact_scope_conflict',
        severity: 'warning',
      }),
    ]));
  });

  it('blocks when a managed task is missing durable task spec state', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState(),
      controlPlaneSnapshot: buildControlPlaneSnapshot({
        state: {
          managed_tasks: [
            {
              task_id: 'issue-105',
              issue_number: 105,
              title: 'feat(ao): add TaskSpec v1, admission normalization, and migration/backfill',
            },
          ],
          task_specs: [],
        },
      }),
    });

    expect(report.top_status).toBe('blocked');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'task_spec_missing',
        severity: 'blocker',
        origin: 'doctor',
      }),
    ]));
  });

  it('surfaces stale control-plane task spec schema versions as explicit findings', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState(),
      controlPlaneSnapshot: buildControlPlaneSnapshot({
        schema: {
          current_version: CONTROL_PLANE_LATEST_VERSION - 1,
          latest_version: CONTROL_PLANE_LATEST_VERSION,
        },
      }),
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'task_spec_state_schema_stale',
        origin: 'doctor',
      }),
    ]));
  });

  it('blocks when a managed task runtime ref has no durable preflight state', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState(),
      controlPlaneSnapshot: buildControlPlaneSnapshot({
        state: {
          managed_tasks: [
            {
              task_id: 'issue-108',
              issue_number: 108,
              title: 'feat(ao): add runtime-provider contract and bootstrap preflight',
            },
          ],
          task_specs: [
            {
              task_id: 'issue-108',
              state: 'valid',
              snapshot: {
                schema_version: 'ao.task-spec.v1alpha1',
                valid: true,
                findings: [],
                spec: {
                  problem_type: 'issue_delivery',
                  acceptance_contract: ['runtime preflight is durable'],
                  runtime_ref: 'runtime.github_local',
                  policy_ref: 'policy.operator_gated',
                  human_gates: ['operator_enroll'],
                },
              },
            },
          ],
          runtime_preflights: [],
        },
      }),
    });

    expect(report.top_status).toBe('blocked');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime_preflight_missing',
        severity: 'blocker',
        origin: 'doctor',
      }),
    ]));
  });

  it('surfaces mixed-version runtime preflight snapshots as explicit findings', () => {
    const report = buildDoctorReport({
      scope: createDoctorProjectScope({ projectId: 'my-project' }),
      reconciliationReport: buildReconciliationReport(),
      localState: buildLocalState(),
      controlPlaneSnapshot: buildControlPlaneSnapshot({
        state: {
          managed_tasks: [
            {
              task_id: 'issue-108',
              issue_number: 108,
              title: 'feat(ao): add runtime-provider contract and bootstrap preflight',
            },
          ],
          task_specs: [
            {
              task_id: 'issue-108',
              state: 'valid',
              snapshot: {
                schema_version: 'ao.task-spec.v1alpha1',
                valid: true,
                findings: [],
                spec: {
                  problem_type: 'issue_delivery',
                  acceptance_contract: ['runtime preflight is durable'],
                  runtime_ref: 'runtime.github_local',
                  policy_ref: 'policy.operator_gated',
                  human_gates: ['operator_enroll'],
                },
              },
            },
          ],
          runtime_preflights: [
            {
              runtime_ref: 'runtime.github_local',
              status: 'clean',
              snapshot: {
                schema_version: 'ao.runtime-preflight.v0',
                runtime_ref: 'runtime.github_local',
              },
            },
          ],
        },
      }),
    });

    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime_preflight_mixed_version',
        origin: 'doctor',
      }),
    ]));
  });
});
