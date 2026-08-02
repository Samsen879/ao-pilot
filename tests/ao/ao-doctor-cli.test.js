import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunDoctor = jest.fn();
const mockRenderDoctorHumanSummary = jest.fn();
const mockInspectRuntime = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/doctor-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  runDoctor: mockRunDoctor,
}));

jest.unstable_mockModule('../../scripts/ao/lib/doctor-report.js', () => ({
  renderDoctorHumanSummary: mockRenderDoctorHumanSummary,
}));
jest.unstable_mockModule('../../scripts/ao/lib/runtime-control.js', () => ({
  inspectRuntimeControl: mockInspectRuntime,
}));

const { runCli } = await import('../../scripts/ao-doctor.js');

function buildReport(overrides = {}) {
  return {
    top_status: 'healthy',
    source_health: {
      reconciliation: 'ok',
      ao: 'ok',
      github: 'ok',
      git: 'ok',
      worktree: 'ok',
    },
    findings: [],
    suggestions: [],
    ...overrides,
  };
}

describe('ao doctor cli', () => {
  beforeEach(() => {
    mockRunDoctor.mockReset();
    mockRenderDoctorHumanSummary.mockReset();
    mockInspectRuntime.mockReset();

    mockRunDoctor.mockResolvedValue({
      report: {
        top_status: 'healthy',
        source_health: { ao: 'ok', github: 'ok' },
        scope: { selected_pr_numbers: [] },
        findings: [],
      },
    });
    mockRenderDoctorHumanSummary.mockReturnValue('top_status: healthy');
    mockInspectRuntime.mockReturnValue({
      status: 'verified',
      runtime: {
        status: 'verified',
        runtime_ref: 'runtime.test.v1',
        source: {},
      },
      authentication: {
        github: { available: true, authenticated: true },
        codex: { available: true, authenticated: true },
      },
    });
  });

  it('renders project-mode human summary output', async () => {
    const stdout = [];

    const result = await runCli([], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunDoctor).toHaveBeenCalledWith({
      projectId: 'my-project',
      prNumber: null,
      cwd: process.cwd(),
      env: process.env,
    });
    expect(stdout.join('')).toContain('top_status: healthy');
  });

  it('renders PR-mode JSON output', async () => {
    mockRunDoctor.mockResolvedValue({
      report: buildReport({
        top_status: 'warning',
      }),
      reconciliationReport: {
        top_status: 'healthy',
        automation_disposition: 'continue',
        findings: [],
      },
    });
    const stdout = [];

    const result = await runCli(['--pr', '44', '--json'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunDoctor).toHaveBeenCalledWith({
      projectId: 'my-project',
      prNumber: 44,
      cwd: process.cwd(),
      env: process.env,
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'warning',
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
            executed: true,
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

  it('uses a configured default project in PR mode without weakening mixed-scope validation', async () => {
    await runCli(['--pr', '44'], {
      writeStdout: () => {},
      writeStderr: () => {},
    }, {
      defaultProjectId: 'ciecopilot-home',
    });

    expect(mockRunDoctor).toHaveBeenCalledWith({
      projectId: 'ciecopilot-home',
      prNumber: 44,
      cwd: process.cwd(),
      env: process.env,
    });
  });

  it('routes an explicit runtime store into reconciliation and provenance inspection', async () => {
    await runCli(['--runtime-store', '/managed/store'], {
      writeStdout: () => {},
      writeStderr: () => {},
    }, { env: { PATH: '/safe' } });

    expect(mockRunDoctor).toHaveBeenCalledWith(expect.objectContaining({
      env: {
        PATH: '/safe',
        AO_PILOT_RUNTIME_STORE: '/managed/store',
      },
    }));
    expect(mockInspectRuntime).toHaveBeenCalledWith(expect.objectContaining({
      storeRoot: '/managed/store',
    }));
  });

  it('uses fixed strict exit-code mapping in human and JSON modes', async () => {
    mockRunDoctor
      .mockResolvedValueOnce({ report: buildReport({ top_status: 'warning' }) })
      .mockResolvedValueOnce({ report: buildReport({ top_status: 'blocked' }) })
      .mockResolvedValueOnce({ report: buildReport({ top_status: 'ambiguous' }) })
      .mockResolvedValueOnce({ report: buildReport({ top_status: 'source_failure' }) });

    const warningResult = await runCli(['--strict'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const blockedResult = await runCli(['--strict'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const ambiguousResult = await runCli(['--strict', '--json'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const sourceFailureResult = await runCli(['--strict'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(warningResult.exitCode).toBe(20);
    expect(blockedResult.exitCode).toBe(21);
    expect(ambiguousResult.exitCode).toBe(22);
    expect(sourceFailureResult.exitCode).toBe(23);
  });

  it('rejects invalid PR values and mixed project/PR flags before probes run', async () => {
    const stderr = [];

    const invalidPr = await runCli(['--pr', 'abc'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    const mixedScope = await runCli(['--project', 'my-project', '--pr', '44'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(invalidPr.exitCode).toBe(4);
    expect(mixedScope.exitCode).toBe(4);
    expect(mockRunDoctor).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Invalid value for --pr');
    expect(stderr.join('')).toContain('Cannot use --project and --pr together');
  });

  it('promotes a shadowed managed runtime to a blocker without exposing auth output', async () => {
    mockInspectRuntime.mockReturnValue({
      status: 'blocked',
      runtime: {
        status: 'blocked',
        code: 'runtime_path_shadowed',
        message: 'PATH contains a different ao',
        source: {},
        path_candidate: '/wrong/bin/ao',
      },
      authentication: {
        github: { available: true, authenticated: true },
        codex: { available: true, authenticated: false },
      },
    });
    const stdout = [];
    const result = await runCli(['--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(21);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'blocked',
      source_health: { runtime: 'failed' },
      runtime: {
        code: 'runtime_path_shadowed',
        path_candidate: '/wrong/bin/ao',
      },
      authentication: {
        codex: { available: true, authenticated: false },
      },
    });
  });

  it('promotes a runtime integrity failure over an ambiguous base diagnosis', async () => {
    mockRunDoctor.mockResolvedValue({
      report: buildReport({
        top_status: 'ambiguous',
        source_health: { ao: 'ok', github: 'ok' },
        scope: { selected_pr_numbers: [] },
      }),
      reconciliationReport: {
        top_status: 'ambiguous',
        automation_disposition: 'pause',
        findings: [],
      },
    });
    mockInspectRuntime.mockReturnValue({
      status: 'blocked',
      runtime: {
        status: 'blocked',
        runtime_ref: 'runtime.test.v1',
        code: 'runtime_path_shadowed',
        message: 'PATH contains a different ao',
        source: {},
      },
      authentication: {},
    });
    const stdout = [];

    const result = await runCli(['--json', '--strict'], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(21);
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      top_status: 'blocked',
      source_health: { runtime: 'failed' },
      findings: expect.arrayContaining([
        expect.objectContaining({ code: 'runtime_path_shadowed', severity: 'blocker' }),
      ]),
    });
  });
});
