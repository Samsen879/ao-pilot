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

const {
  DEFAULT_PROJECT_ID,
  buildProjectScopeFromAoObservation,
  runReconciliation,
} = await import('../../scripts/ao/lib/reconciliation-runner.js');

describe('reconciliation runner', () => {
  beforeEach(() => {
    mockLoadAoProjectObservation.mockReset();
    mockLoadGitHubObservationSet.mockReset();
    mockReconcileObservations.mockReset();
  });

  it('exports the default project id', () => {
    expect(DEFAULT_PROJECT_ID).toBe('my-project');
  });

  it('runs PR-scoped reconciliation through the shared pipeline', async () => {
    mockLoadAoProjectObservation.mockResolvedValue({
      project_id: 'my-project',
      workers: [],
    });
    mockLoadGitHubObservationSet.mockResolvedValue({
      scope: { mode: 'pr', selected_pr_numbers: [44] },
      prs: [],
    });
    mockReconcileObservations.mockReturnValue({
      top_status: 'healthy',
      automation_disposition: 'continue',
    });

    const result = await runReconciliation({
      projectId: 'my-project',
      prNumber: 44,
    });

    expect(mockLoadAoProjectObservation).toHaveBeenCalledWith({
      projectId: 'my-project',
      cwd: process.cwd(),
      env: process.env,
    });
    expect(mockLoadGitHubObservationSet).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        mode: 'pr',
        selected_pr_numbers: [44],
      }),
    });
    expect(mockReconcileObservations).toHaveBeenCalledWith({
      scope: expect.objectContaining({
        mode: 'pr',
        selected_pr_numbers: [44],
      }),
      aoObservation: expect.any(Object),
      githubObservation: expect.any(Object),
    });
    expect(result.report.top_status).toBe('healthy');
  });

  it('builds project scope from worker PR numbers and branch hints', () => {
    const scope = buildProjectScopeFromAoObservation({
      workers: [
        { pr_number: 41, branch_name: 'feat/issue-41' },
        { pr_number: null, branch_name: 'feat/issue-48' },
        { pr_number: 40, branch_name: 'feat/issue-40' },
      ],
    });

    expect(scope).toEqual({
      mode: 'project',
      authoritative_for_automation: false,
      authoritative_for_orphan_detection: false,
      selected_pr_numbers: [40, 41],
      selection_basis: ['ao_session_pr_reference', 'ao_session_branch_match'],
      selection_notes: ['branch:feat/issue-40', 'branch:feat/issue-41', 'branch:feat/issue-48'],
    });
  });
});
