import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunReconciliation = jest.fn();
const mockLoadDoctorLocalState = jest.fn();
const mockBuildDoctorReport = jest.fn();
const mockFindRepoRoot = jest.fn();
const mockCreateStateRepository = jest.fn();
const mockEnsureRuntimePreflights = jest.fn();
const controlPlaneSnapshot = {
  bootstrapped: true,
  schema: {
    current_version: 6,
    latest_version: 6,
  },
  state: {
    managed_tasks: [],
    task_specs: [],
    runtime_preflights: [],
    checkpoints: [],
  },
};
let currentControlPlaneSnapshot = controlPlaneSnapshot;

jest.unstable_mockModule('../../scripts/ao/lib/reconciliation-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  runReconciliation: mockRunReconciliation,
}));

jest.unstable_mockModule('../../scripts/ao/lib/doctor-local-state-source.js', () => ({
  loadDoctorLocalState: mockLoadDoctorLocalState,
}));

jest.unstable_mockModule('../../scripts/ao/lib/doctor-engine.js', () => ({
  buildDoctorReport: mockBuildDoctorReport,
}));

jest.unstable_mockModule('../../scripts/ao/lib/repo-root.js', () => ({
  findRepoRoot: mockFindRepoRoot,
}));

jest.unstable_mockModule('../../scripts/ao/lib/state-repository.js', () => ({
  createStateRepository: mockCreateStateRepository,
}));

const { runDoctor } = await import('../../scripts/ao/lib/doctor-runner.js');

describe('doctor runner', () => {
  beforeEach(() => {
    mockRunReconciliation.mockReset();
    mockLoadDoctorLocalState.mockReset();
    mockBuildDoctorReport.mockReset();
    mockFindRepoRoot.mockReset();
    mockCreateStateRepository.mockReset();
    mockEnsureRuntimePreflights.mockReset();
    currentControlPlaneSnapshot = controlPlaneSnapshot;
    mockFindRepoRoot.mockReturnValue('/home/user/my-project');
    mockCreateStateRepository.mockReturnValue({
      ensureRuntimePreflights: mockEnsureRuntimePreflights,
      getDiagnosticSnapshot: () => currentControlPlaneSnapshot,
    });
  });

  it('runs project mode through the shared doctor pipeline', async () => {
    mockRunReconciliation.mockResolvedValue({
      report: {
        top_status: 'warning',
        findings: [],
      },
    });
    mockLoadDoctorLocalState.mockResolvedValue({
      cwd: '/home/user/my-project',
      current_branch: 'runtime-post-pilot-0323-2239',
    });
    mockBuildDoctorReport.mockReturnValue({
      top_status: 'warning',
      findings: [],
      suggestions: [],
    });

    const result = await runDoctor({
      projectId: 'my-project',
      prNumber: null,
      cwd: '/home/user/my-project',
    });

    expect(mockRunReconciliation).toHaveBeenCalledWith({
      projectId: 'my-project',
      prNumber: null,
      cwd: '/home/user/my-project',
      env: process.env,
    });
    expect(mockEnsureRuntimePreflights).toHaveBeenCalledWith({
      cwd: '/home/user/my-project',
    });
    expect(mockLoadDoctorLocalState).toHaveBeenCalledWith({
      cwd: '/home/user/my-project',
    });
    expect(mockBuildDoctorReport).toHaveBeenCalledWith({
      scope: {
        mode: 'project',
        project_id: 'my-project',
        pr_number: null,
        authoritative_for_release: false,
        diagnose_only: true,
      },
      reconciliationReport: {
        top_status: 'warning',
        findings: [],
      },
      localState: {
        cwd: '/home/user/my-project',
        current_branch: 'runtime-post-pilot-0323-2239',
      },
      controlPlaneSnapshot: {
        bootstrapped: true,
        schema: {
          current_version: 6,
          latest_version: 6,
        },
        state: {
          managed_tasks: [],
          task_specs: [],
          runtime_preflights: [],
          checkpoints: [],
        },
      },
      runtimeStore: null,
    });
    expect(result).toEqual({
      scope: {
        mode: 'project',
        project_id: 'my-project',
        pr_number: null,
        authoritative_for_release: false,
        diagnose_only: true,
      },
      reconciliationReport: {
        top_status: 'warning',
        findings: [],
      },
      localState: {
        cwd: '/home/user/my-project',
        current_branch: 'runtime-post-pilot-0323-2239',
      },
      controlPlaneSnapshot: {
        bootstrapped: true,
        schema: {
          current_version: 6,
          latest_version: 6,
        },
        state: {
          managed_tasks: [],
          task_specs: [],
          runtime_preflights: [],
          checkpoints: [],
        },
      },
      report: {
        top_status: 'warning',
        findings: [],
        suggestions: [],
      },
    });
  });

  it('runs PR mode through the shared doctor pipeline', async () => {
    mockRunReconciliation.mockResolvedValue({
      report: {
        top_status: 'healthy',
        findings: [],
      },
    });
    mockLoadDoctorLocalState.mockResolvedValue({
      cwd: '/home/user/my-project',
      current_branch: 'feat/issue-44',
    });
    mockBuildDoctorReport.mockReturnValue({
      top_status: 'healthy',
      findings: [],
      suggestions: [],
    });

    const result = await runDoctor({
      projectId: 'my-project',
      prNumber: 44,
      cwd: '/home/user/my-project',
    });

    expect(mockRunReconciliation).toHaveBeenCalledWith({
      projectId: 'my-project',
      prNumber: 44,
      cwd: '/home/user/my-project',
      env: process.env,
    });
    expect(result.scope).toEqual({
      mode: 'pr',
      project_id: 'my-project',
      pr_number: 44,
      authoritative_for_release: false,
      diagnose_only: true,
    });
    expect(mockEnsureRuntimePreflights).toHaveBeenCalledWith({
      cwd: '/home/user/my-project',
    });
    expect(result.report.top_status).toBe('healthy');
  });

  it('returns raw graph diagnostics before runtime-preflight mutation', async () => {
    currentControlPlaneSnapshot = {
      ...controlPlaneSnapshot,
      task_graph_inspection: {
        structurally_healthy: false,
        findings: [{ code: 'task_graph_relation_malformed', severity: 'blocker' }],
      },
    };
    mockRunReconciliation.mockResolvedValue({ report: { top_status: 'warning', findings: [] } });
    mockLoadDoctorLocalState.mockResolvedValue({ cwd: '/home/user/my-project' });
    mockBuildDoctorReport.mockReturnValue({
      top_status: 'blocked',
      findings: [{ code: 'task_graph_relation_malformed' }],
      suggestions: [],
    });

    const result = await runDoctor({
      projectId: 'my-project',
      cwd: '/home/user/my-project',
    });

    expect(mockEnsureRuntimePreflights).not.toHaveBeenCalled();
    expect(mockBuildDoctorReport).toHaveBeenCalledWith(expect.objectContaining({
      controlPlaneSnapshot: currentControlPlaneSnapshot,
    }));
    expect(result.report.top_status).toBe('blocked');
  });
});
