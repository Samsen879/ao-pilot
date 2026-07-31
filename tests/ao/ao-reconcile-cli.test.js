import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadAoProjectObservation = jest.fn();
const mockLoadGitHubObservationSet = jest.fn();
const mockReconcileObservations = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/ao-observation-source.js', () => ({
  loadAoProjectObservation: mockLoadAoProjectObservation,
}));

jest.unstable_mockModule('../../scripts/ao/lib/github-observation-source.js', () => ({
  loadGitHubObservationSet: mockLoadGitHubObservationSet,
}));

jest.unstable_mockModule('../../scripts/ao/lib/reconciliation-engine.js', () => ({
  reconcileObservations: mockReconcileObservations,
}));

const { runCli } = await import('../../scripts/ao-reconcile.js');

describe('ao reconcile cli', () => {
  beforeEach(() => {
    mockLoadAoProjectObservation.mockReset();
    mockLoadGitHubObservationSet.mockReset();
    mockReconcileObservations.mockReset();
  });

  it('uses PR-scoped strict JSON mode for automation', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({ project_id: 'my-project' });
    mockLoadGitHubObservationSet.mockResolvedValue({ scope: { mode: 'pr', selected_pr_numbers: [44] } });
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'healthy',
      automation_disposition: 'continue',
      source_health: { ao: 'ok', github: 'ok' },
      pr_assessments: [],
      project_summary: {
        selected_pr_count: 1,
        ready_pr_numbers: [44],
        blocked_pr_numbers: [],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: [],
      },
      findings: [],
      recommended_actions: [],
    });

    const stdout = [];
    const result = await runCli(['--pr', '44', '--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      automation_disposition: 'continue',
      decision_chain: expect.objectContaining({
        contract_status: 'authoritative_pr_chain',
        scope: expect.objectContaining({
          mode: 'pr',
          project_id: 'my-project',
          pr_number: 44,
          trigger: 'manual',
        }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stage: 'reconcile',
            executed: true,
            authority: 'authoritative',
          }),
          expect.objectContaining({
            stage: 'doctor',
            executed: false,
            authority: 'diagnose_only',
          }),
          expect.objectContaining({
            stage: 'lifecycle',
            executed: false,
            authority: 'authoritative',
          }),
        ]),
      }),
    });
  });

  it('uses a configured default project in PR mode', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({ project_id: 'ciecopilot-home' });
    mockLoadGitHubObservationSet.mockResolvedValue({
      scope: { mode: 'pr', selected_pr_numbers: [44] },
    });
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'healthy',
      automation_disposition: 'continue',
      source_health: { ao: 'ok', github: 'ok' },
      pr_assessments: [],
      project_summary: {
        selected_pr_count: 1,
        ready_pr_numbers: [44],
        blocked_pr_numbers: [],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: [],
      },
      findings: [],
      recommended_actions: [],
    });

    const result = await runCli(['--pr', '44', '--strict'], {
      writeStdout: () => {},
      writeStderr: () => {},
    }, {
      defaultProjectId: 'ciecopilot-home',
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadAoProjectObservation).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'ciecopilot-home',
    }));
  });

  it('returns automation exit code 11 for blocked PR-scoped results', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({ project_id: 'my-project' });
    mockLoadGitHubObservationSet.mockResolvedValue({ scope: { mode: 'pr', selected_pr_numbers: [44] } });
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'blocked',
      automation_disposition: 'pause',
      source_health: { ao: 'ok', github: 'ok' },
      pr_assessments: [],
      project_summary: {
        selected_pr_count: 1,
        ready_pr_numbers: [],
        blocked_pr_numbers: [44],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: [],
      },
      findings: [],
      recommended_actions: [],
    });

    const result = await runCli(['--pr', '44', '--json', '--strict'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(11);
  });

  it('keeps default human mode permissive', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({
      project_id: 'my-project',
      workers: [{ pr_number: 44 }],
    });
    mockLoadGitHubObservationSet.mockResolvedValue({
      scope: { mode: 'project', selected_pr_numbers: [44] },
    });
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'ambiguous',
      automation_disposition: 'human_gate',
      source_health: { ao: 'degraded', github: 'ok' },
      pr_assessments: [],
      project_summary: {
        selected_pr_count: 1,
        ready_pr_numbers: [],
        blocked_pr_numbers: [],
        ambiguous_pr_numbers: [44],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: [],
      },
      findings: [],
      recommended_actions: [],
    });

    const result = await runCli([], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
  });

  it('builds project scope from AO worker branch hints when PR numbers are missing', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({
      project_id: 'my-project',
      workers: [{ pr_number: null, branch_name: 'feat/issue-48' }],
    });
    mockLoadGitHubObservationSet.mockImplementation(async ({ scope }) => ({
      scope,
      source_ok: true,
      source_error: null,
      prs: [],
    }));
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'warning',
      automation_disposition: 'continue',
      source_health: { ao: 'ok', github: 'ok' },
      pr_assessments: [],
      project_summary: {
        selected_pr_count: 0,
        ready_pr_numbers: [],
        blocked_pr_numbers: [],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: ['ao_session_branch_match'],
      },
      findings: [],
      recommended_actions: [],
    });

    const result = await runCli([], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadGitHubObservationSet).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        mode: 'project',
        selected_pr_numbers: [],
        selection_basis: ['ao_session_branch_match'],
        selection_notes: ['branch:feat/issue-48'],
      }),
    });
  });

  it('renders human summary output with findings and recommended actions', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({
      project_id: 'my-project',
      workers: [{ pr_number: 44, branch_name: 'feat/issue-44' }],
    });
    mockLoadGitHubObservationSet.mockResolvedValue({
      scope: { mode: 'project', selected_pr_numbers: [44] },
    });
    mockReconcileObservations.mockReturnValue({
      schema_version: 'ao.reconciliation.v1alpha1',
      report_format: 'ao_reconciliation_report',
      top_status: 'blocked',
      automation_disposition: 'pause',
      source_health: { ao: 'ok', github: 'ok' },
      pr_assessments: [
        {
          pr_number: 44,
          ownership: {
            status: 'orphaned',
            owner_session: null,
          },
          release_readiness: {
            status: 'blocked',
          },
        },
      ],
      project_summary: {
        selected_pr_count: 1,
        ready_pr_numbers: [],
        blocked_pr_numbers: [44],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: ['ao_session_pr_reference'],
      },
      findings: [
        {
          code: 'orphan_open_pr',
          severity: 'blocker',
          summary: 'Open PR #44 has no healthy AO owner',
        },
      ],
      recommended_actions: [
        {
          action_class: 'pause_autonomy',
          summary: 'Do not continue autonomous delivery until blockers are resolved.',
        },
      ],
    });

    const stdout = [];
    const result = await runCli([], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join('')).toContain('key_findings:');
    expect(stdout.join('')).toContain('[blocker] orphan_open_pr');
    expect(stdout.join('')).toContain('recommended_actions: pause_autonomy');
  });

  it('rejects strict mode without an explicit PR number', async () => {
    const stderr = [];

    const result = await runCli(['--json', '--strict'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockLoadAoProjectObservation).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Strict mode requires --pr <number>');
  });

  it('documents strict npm wrapper expectations in package scripts', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

    expect(packageJson.scripts['ao:reconcile:strict']).toBe('node scripts/ao-reconcile.js --json --strict');
    expect(packageJson.scripts['ao:reconcile:strict:pr']).toBe('node scripts/ao-reconcile.js --json --strict --pr');
    expect(packageJson.scripts['ao:doctor:strict']).toBe('node scripts/ao-doctor.js --strict');
    expect(packageJson.scripts['ao:doctor:strict:pr']).toBe('node scripts/ao-doctor.js --json --strict --pr');
    expect(packageJson.scripts['ao:lifecycle:strict']).toBe('node scripts/ao-lifecycle.js --strict');
    expect(packageJson.scripts['ao:lifecycle:strict:pr']).toBe('node scripts/ao-lifecycle.js --json --strict --pr');
  });
});
