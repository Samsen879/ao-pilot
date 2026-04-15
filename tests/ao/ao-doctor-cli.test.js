import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunDoctor = jest.fn();
const mockRenderDoctorHumanSummary = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/doctor-runner.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  runDoctor: mockRunDoctor,
}));

jest.unstable_mockModule('../../scripts/ao/lib/doctor-report.js', () => ({
  renderDoctorHumanSummary: mockRenderDoctorHumanSummary,
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

    mockRunDoctor.mockResolvedValue({
      report: {
        top_status: 'healthy',
        source_health: { ao: 'ok', github: 'ok' },
        scope: { selected_pr_numbers: [] },
        findings: [],
      },
    });
    mockRenderDoctorHumanSummary.mockReturnValue('top_status: healthy');
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
});
