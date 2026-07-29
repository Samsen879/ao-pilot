import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadAoMetricsReport = jest.fn();
const mockRenderAoMetricsHumanSummary = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/run-metrics.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  loadAoMetricsReport: mockLoadAoMetricsReport,
  renderAoMetricsHumanSummary: mockRenderAoMetricsHumanSummary,
}));

const { runCli } = await import('../../scripts/ao-metrics.js');

function buildReport(overrides = {}) {
  return {
    schema_version: 'ao.metrics-report.v1alpha1',
    report_format: 'ao_metrics_report',
    project_id: 'my-project',
    repo_root: '/home/user/my-project',
    summary: {
      controller_run_count: 2,
      execution_attempt_count: 3,
      intervention_counts: {
        human_gate: 0,
        override: 1,
        explicit_resume: 1,
        successor_handoff: 0,
        policy_block: 1,
        preflight_block: 0,
      },
      failure_class_counts: {
        none: 1,
        policy_block: 1,
        worker_exit: 1,
      },
      retry_cause_counts: {
        none: 2,
        explicit_resume: 1,
        successor_handoff: 0,
        policy_retry: 0,
        preflight_retry: 0,
        unknown: 0,
      },
    },
    recent_traces: {
      controller_runs: [],
      execution_attempts: [],
    },
    ...overrides,
  };
}

describe('ao metrics cli', () => {
  beforeEach(() => {
    mockLoadAoMetricsReport.mockReset();
    mockRenderAoMetricsHumanSummary.mockReset();

    mockLoadAoMetricsReport.mockResolvedValue(buildReport());
    mockRenderAoMetricsHumanSummary.mockReturnValue('controller_runs: 2');
  });

  it('renders project-mode human summary output', async () => {
    const stdout = [];

    const result = await runCli([], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadAoMetricsReport).toHaveBeenCalledWith({
      cwd: process.cwd(),
      projectId: 'my-project',
      traceLimit: 5,
      since: null,
      until: null,
    });
    expect(stdout.join('')).toContain('controller_runs: 2');
  });

  it('renders JSON output with an explicit trace limit', async () => {
    const stdout = [];

    const result = await runCli([
      '--json',
      '--limit', '2',
      '--since', '2026-07-01T00:00:00Z',
      '--until', '2026-07-31T23:59:59Z',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockLoadAoMetricsReport).toHaveBeenCalledWith({
      cwd: process.cwd(),
      projectId: 'my-project',
      traceLimit: 2,
      since: '2026-07-01T00:00:00Z',
      until: '2026-07-31T23:59:59Z',
    });
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      schema_version: 'ao.metrics-report.v1alpha1',
      summary: {
        controller_run_count: 2,
        execution_attempt_count: 3,
      },
    });
  });

  it('rejects invalid limit values and unknown flags before loading metrics', async () => {
    const stderr = [];

    const invalidLimit = await runCli(['--limit', '0'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const unknownArg = await runCli(['--bogus'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidWindow = await runCli([
      '--since', '2026-08-01T00:00:00Z',
      '--until', '2026-07-01T00:00:00Z',
    ], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(invalidLimit.exitCode).toBe(4);
    expect(unknownArg.exitCode).toBe(4);
    expect(invalidWindow.exitCode).toBe(4);
    expect(mockLoadAoMetricsReport).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Invalid value for --limit');
    expect(stderr.join('')).toContain('Unknown argument: --bogus');
    expect(stderr.join('')).toContain('--since is after --until');
  });

  it('rejects --project when the next token is another flag', async () => {
    const stderr = [];

    const result = await runCli(['--project', '--json'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(result.exitCode).toBe(4);
    expect(mockLoadAoMetricsReport).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Missing value for --project');
  });
});
