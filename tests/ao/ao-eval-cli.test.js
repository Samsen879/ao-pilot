import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRunAoEvalHarness = jest.fn();
const mockBuildAoEvalScorecard = jest.fn();
const mockCompareAoEvalScorecards = jest.fn();
const mockLoadAoEvalBaseline = jest.fn();
const mockPersistAoEvalScorecard = jest.fn();
const mockRenderAoEvalHumanSummary = jest.fn();

jest.unstable_mockModule('../../scripts/ao/lib/eval-harness.js', () => ({
  runAoEvalHarness: mockRunAoEvalHarness,
}));

jest.unstable_mockModule('../../scripts/ao/lib/scorecard.js', () => ({
  DEFAULT_PROJECT_ID: 'my-project',
  buildAoEvalScorecard: mockBuildAoEvalScorecard,
  compareAoEvalScorecards: mockCompareAoEvalScorecards,
  loadAoEvalBaseline: mockLoadAoEvalBaseline,
  persistAoEvalScorecard: mockPersistAoEvalScorecard,
  renderAoEvalHumanSummary: mockRenderAoEvalHumanSummary,
}));

const { runCli } = await import('../../scripts/ao-eval.js');

function buildHarnessResult(overrides = {}) {
  return {
    schema_version: 'ao.eval-harness-run.v1alpha1',
    format: 'ao_eval_harness_run',
    project_id: 'my-project',
    pack_ids: ['all'],
    scenario_ids: ['parity-ci-failed-pr'],
    scenario_results: [],
    summary: {
      scenario_count: 1,
      passed_scenario_count: 1,
      failed_scenario_count: 0,
      replay_stable_scenario_count: 1,
      continuity_scenario_count: 0,
      continuity_success_count: 0,
    },
    ...overrides,
  };
}

function buildScorecard(overrides = {}) {
  return {
    schema_version: 'ao.eval-scorecard.v1alpha1',
    format: 'ao_eval_scorecard',
    scorecard_id: 'scorecard-1',
    project_id: 'my-project',
    summary: {
      scenario_count: 1,
      passed_scenario_count: 1,
      failed_scenario_count: 0,
    },
    findings: [],
    ...overrides,
  };
}

describe('ao eval cli', () => {
  beforeEach(() => {
    mockRunAoEvalHarness.mockReset();
    mockBuildAoEvalScorecard.mockReset();
    mockCompareAoEvalScorecards.mockReset();
    mockLoadAoEvalBaseline.mockReset();
    mockPersistAoEvalScorecard.mockReset();
    mockRenderAoEvalHumanSummary.mockReset();

    mockRunAoEvalHarness.mockResolvedValue(buildHarnessResult());
    mockBuildAoEvalScorecard.mockReturnValue(buildScorecard());
    mockCompareAoEvalScorecards.mockReturnValue({
      status: 'ok',
      findings: [],
    });
    mockPersistAoEvalScorecard.mockReturnValue({
      scorecard_path: '/tmp/.ao-control-plane/my-project/eval/scorecards/scorecard-1.json',
      operator_scorecard_path: '/tmp/ao-artifacts/ao-eval/scorecards/scorecard-1.json',
      baseline_path: null,
      operator_baseline_path: null,
    });
    mockRenderAoEvalHumanSummary.mockReturnValue('scorecard_id: scorecard-1');
  });

  it('runs the full suite by default and renders human summary output', async () => {
    const stdout = [];

    const result = await runCli([], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunAoEvalHarness).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      packNames: ['all'],
      replayCount: 2,
      fixtureRoot: expect.stringMatching(/tests[/\\]ao[/\\]fixtures[/\\]eval$/),
    }));
    expect(mockPersistAoEvalScorecard).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      scorecard: expect.objectContaining({
        scorecard_id: 'scorecard-1',
      }),
      baselineName: null,
    }));
    expect(stdout.join('')).toContain('scorecard_id: scorecard-1');
  });

  it('supports named pack subsets, baseline comparison, baseline saving, and JSON output', async () => {
    const stdout = [];
    const baseline = buildScorecard({
      scorecard_id: 'baseline-1',
    });

    mockLoadAoEvalBaseline.mockReturnValue(baseline);
    mockCompareAoEvalScorecards.mockReturnValue({
      status: 'ok',
      findings: [],
      baseline_scorecard_id: 'baseline-1',
      current_scorecard_id: 'scorecard-1',
    });
    mockPersistAoEvalScorecard.mockReturnValue({
      scorecard_path: '/tmp/.ao-control-plane/my-project/eval/scorecards/scorecard-1.json',
      operator_scorecard_path: '/tmp/ao-artifacts/ao-eval/scorecards/scorecard-1.json',
      baseline_path: '/tmp/.ao-control-plane/my-project/eval/baselines/wave-2.json',
      operator_baseline_path: '/tmp/ao-artifacts/ao-eval/baselines/wave-2.json',
    });

    const result = await runCli([
      '--pack', 'parity',
      '--pack', 'successor-handoff',
      '--baseline', 'wave-1',
      '--save-baseline', 'wave-2',
      '--fixture-root', '/tmp/custom-eval',
      '--replay-count', '3',
      '--json',
    ], {
      writeStdout: (text) => stdout.push(text),
      writeStderr: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(mockRunAoEvalHarness).toHaveBeenCalledWith(expect.objectContaining({
      packNames: ['parity', 'successor-handoff'],
      fixtureRoot: '/tmp/custom-eval',
      replayCount: 3,
    }));
    expect(mockLoadAoEvalBaseline).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'my-project',
      baselineRef: 'wave-1',
    }));
    expect(mockCompareAoEvalScorecards).toHaveBeenCalledWith({
      baselineScorecard: baseline,
      currentScorecard: expect.objectContaining({
        scorecard_id: 'scorecard-1',
      }),
    });
    expect(mockPersistAoEvalScorecard).toHaveBeenCalledWith(expect.objectContaining({
      baselineName: 'wave-2',
    }));
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      scorecard: {
        scorecard_id: 'scorecard-1',
      },
      comparison: {
        status: 'ok',
      },
      persisted: {
        baseline_path: '/tmp/.ao-control-plane/my-project/eval/baselines/wave-2.json',
      },
    });
  });

  it('fails closed when the scorecard contains failed scenarios or baseline regressions', async () => {
    mockBuildAoEvalScorecard
      .mockReturnValueOnce(buildScorecard({
        summary: {
          scenario_count: 1,
          passed_scenario_count: 0,
          failed_scenario_count: 1,
        },
        findings: [
          {
            code: 'scenario_verification_failed',
          },
        ],
      }))
      .mockReturnValueOnce(buildScorecard());
    mockLoadAoEvalBaseline.mockReturnValue(buildScorecard({
      scorecard_id: 'baseline-1',
    }));
    mockCompareAoEvalScorecards.mockReturnValue({
      status: 'regressed',
      findings: [
        {
          code: 'verification_success_regressed',
        },
      ],
    });

    const failedScenarioResult = await runCli([], {
      writeStdout: () => {},
      writeStderr: () => {},
    });
    const regressedResult = await runCli(['--baseline', 'wave-1'], {
      writeStdout: () => {},
      writeStderr: () => {},
    });

    expect(failedScenarioResult.exitCode).toBe(1);
    expect(regressedResult.exitCode).toBe(1);
  });

  it('rejects invalid flags and missing option values before running the harness', async () => {
    const stderr = [];

    const missingPackValue = await runCli(['--pack'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const missingBaselineValue = await runCli(['--baseline'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const unknownFlag = await runCli(['--bogus'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });
    const invalidReplayCount = await runCli(['--replay-count', '1'], {
      writeStdout: () => {},
      writeStderr: (text) => stderr.push(text),
    });

    expect(missingPackValue.exitCode).toBe(4);
    expect(missingBaselineValue.exitCode).toBe(4);
    expect(unknownFlag.exitCode).toBe(4);
    expect(invalidReplayCount.exitCode).toBe(4);
    expect(mockRunAoEvalHarness).not.toHaveBeenCalled();
    expect(stderr.join('')).toContain('Missing value for --pack');
    expect(stderr.join('')).toContain('Missing value for --baseline');
    expect(stderr.join('')).toContain('Unknown argument: --bogus');
    expect(stderr.join('')).toContain('Invalid value for --replay-count');
  });
});
