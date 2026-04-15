import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  buildAoEvalScorecard,
  compareAoEvalScorecards,
  loadAoEvalBaseline,
  persistAoEvalScorecard,
} from '../../scripts/ao/lib/scorecard.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-scorecard-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createHarnessResult(overrides = {}) {
  return {
    schema_version: 'ao.eval-harness-run.v1alpha1',
    format: 'ao_eval_harness_run',
    project_id: PROJECT_ID,
    fixture_root: '/tmp/fixtures/eval',
    pack_ids: ['parity', 'resume-continuity', 'successor-handoff', 'continuity-incident-matrix'],
    scenario_ids: [
      'parity-ci-failed-pr',
      'resume-explicit-checkpoint',
      'handoff-successor-transfer',
      'ambiguous-competing-successors',
    ],
    scenario_results: [
      {
        scenario_id: 'parity-ci-failed-pr',
        pack_id: 'parity',
        runner: 'controller_shadow_parity',
        title: 'Parity scenario',
        status: 'passed',
        verification: {
          status: 'passed',
          findings: [],
        },
        replay: {
          stable: true,
          fingerprint: 'scenario:parity',
        },
        continuity: {
          kind: 'none',
          status: 'not_applicable',
          outcome: 'none',
        },
        metrics: {
          controller_run_count: 1,
          execution_attempt_count: 0,
          measurement_count: 1,
          intervened_measurement_count: 0,
          intervention_counts: {
            human_gate: 0,
            override: 0,
            explicit_resume: 0,
            successor_handoff: 0,
            policy_block: 0,
            preflight_block: 0,
          },
          failure_class_counts: {
            none: 1,
            ci_failure: 0,
            review_blocked: 0,
            merge_conflict: 0,
            source_failure: 0,
            human_gate: 0,
            override: 0,
            policy_block: 0,
            preflight_block: 0,
            worker_exit: 0,
            successor_handoff: 0,
            unknown: 0,
          },
        },
      },
      {
        scenario_id: 'resume-explicit-checkpoint',
        pack_id: 'resume-continuity',
        runner: 'managed_resume_continuity',
        title: 'Resume continuity scenario',
        status: 'passed',
        verification: {
          status: 'passed',
          findings: [],
        },
        replay: {
          stable: true,
          fingerprint: 'scenario:resume',
        },
        continuity: {
          kind: 'resume',
          status: 'success',
          outcome: 'explicit_resume',
          posture: 'restore_ready',
          recommended_action: 'restore_existing_worker',
        },
        metrics: {
          controller_run_count: 0,
          execution_attempt_count: 2,
          measurement_count: 2,
          intervened_measurement_count: 1,
          intervention_counts: {
            human_gate: 0,
            override: 0,
            explicit_resume: 1,
            successor_handoff: 0,
            policy_block: 0,
            preflight_block: 0,
          },
          failure_class_counts: {
            none: 1,
            ci_failure: 0,
            review_blocked: 0,
            merge_conflict: 0,
            source_failure: 0,
            human_gate: 0,
            override: 0,
            policy_block: 0,
            preflight_block: 0,
            worker_exit: 1,
            successor_handoff: 0,
            unknown: 0,
          },
        },
      },
      {
        scenario_id: 'handoff-successor-transfer',
        pack_id: 'successor-handoff',
        runner: 'managed_successor_handoff',
        title: 'Successor handoff scenario',
        status: 'failed',
        verification: {
          status: 'failed',
          findings: [
            {
              code: 'handoff_resume_failed',
              summary: 'Accepted handoff transfer did not complete.',
            },
          ],
        },
        replay: {
          stable: false,
          fingerprint: 'scenario:handoff',
        },
        continuity: {
          kind: 'handoff',
          status: 'failed',
          outcome: 'failed',
          posture: 'handoff_granted',
          recommended_action: 'handoff_to_successor',
        },
        metrics: {
          controller_run_count: 0,
          execution_attempt_count: 1,
          measurement_count: 1,
          intervened_measurement_count: 1,
          intervention_counts: {
            human_gate: 0,
            override: 0,
            explicit_resume: 0,
            successor_handoff: 0,
            policy_block: 1,
            preflight_block: 0,
          },
          failure_class_counts: {
            none: 0,
            ci_failure: 0,
            review_blocked: 0,
            merge_conflict: 0,
            source_failure: 0,
            human_gate: 0,
            override: 0,
            policy_block: 1,
            preflight_block: 0,
            worker_exit: 0,
            successor_handoff: 0,
            unknown: 0,
          },
        },
      },
      {
        scenario_id: 'ambiguous-competing-successors',
        pack_id: 'continuity-incident-matrix',
        runner: 'managed_ambiguous_continuity',
        title: 'Ambiguous competing successors scenario',
        status: 'passed',
        verification: {
          status: 'passed',
          findings: [],
        },
        replay: {
          stable: true,
          fingerprint: 'scenario:ambiguous',
        },
        continuity: {
          kind: 'human_gate',
          status: 'success',
          outcome: 'ambiguous_human_gate',
          posture: 'ambiguous',
          recommended_action: 'hold_for_human',
        },
        metrics: {
          controller_run_count: 0,
          execution_attempt_count: 1,
          measurement_count: 1,
          intervened_measurement_count: 0,
          intervention_counts: {
            human_gate: 0,
            override: 0,
            explicit_resume: 0,
            successor_handoff: 0,
            policy_block: 0,
            preflight_block: 0,
          },
          failure_class_counts: {
            none: 0,
            ci_failure: 0,
            review_blocked: 0,
            merge_conflict: 0,
            source_failure: 0,
            human_gate: 0,
            override: 0,
            policy_block: 0,
            preflight_block: 0,
            worker_exit: 1,
            successor_handoff: 0,
            unknown: 0,
          },
        },
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao eval scorecard', () => {
  it('builds scorecard metrics for verification success, replay stability, continuity, interventions, and failure classes', () => {
    const scorecard = buildAoEvalScorecard({
      projectId: PROJECT_ID,
      harnessResult: createHarnessResult(),
      generatedAt: '2026-03-31T12:30:00.000Z',
    });

    expect(scorecard).toMatchObject({
      schema_version: 'ao.eval-scorecard.v1alpha1',
      format: 'ao_eval_scorecard',
      project_id: PROJECT_ID,
      pack_ids: ['parity', 'resume-continuity', 'successor-handoff', 'continuity-incident-matrix'],
      scenario_ids: [
        'parity-ci-failed-pr',
        'resume-explicit-checkpoint',
        'handoff-successor-transfer',
        'ambiguous-competing-successors',
      ],
      summary: {
        scenario_count: 4,
        passed_scenario_count: 3,
        failed_scenario_count: 1,
        verification_success: {
          passed: 3,
          total: 4,
          rate: 0.75,
        },
        replay_stability: {
          stable: 3,
          total: 4,
          rate: 0.75,
        },
        continuity: {
          successful: 2,
          total: 3,
          rate: 2 / 3,
          outcome_counts: {
            explicit_resume_success: 1,
            successor_handoff_success: 0,
            ambiguous_human_gate_success: 1,
            failed: 1,
            not_applicable: 1,
          },
        },
        intervention_rate: {
          intervened_measurement_count: 2,
          total_measurement_count: 5,
          rate: 0.4,
        },
        failure_class_distribution: {
          counts: expect.objectContaining({
            none: 2,
            worker_exit: 2,
            policy_block: 1,
          }),
          rates: expect.objectContaining({
            none: 0.4,
            worker_exit: 0.4,
            policy_block: 0.2,
          }),
        },
      },
    });
    expect(scorecard.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'scenario_verification_failed',
        scenario_id: 'handoff-successor-transfer',
      }),
      expect.objectContaining({
        code: 'scenario_replay_unstable',
        scenario_id: 'handoff-successor-transfer',
      }),
    ]));
  });

  it('compares scorecards against a saved baseline and flags regressions explicitly', () => {
    const baseline = buildAoEvalScorecard({
      projectId: PROJECT_ID,
      generatedAt: '2026-03-31T12:00:00.000Z',
      harnessResult: createHarnessResult({
        scenario_results: createHarnessResult().scenario_results.map((scenario) => ({
          ...scenario,
          status: 'passed',
          verification: {
            status: 'passed',
            findings: [],
          },
          replay: {
            stable: true,
            fingerprint: scenario.replay.fingerprint,
          },
          continuity: scenario.continuity.kind === 'handoff'
            ? {
                kind: 'handoff',
                status: 'success',
                outcome: 'successor_handoff',
              }
            : scenario.continuity,
          metrics: {
            ...scenario.metrics,
            intervened_measurement_count: scenario.scenario_id === 'handoff-successor-transfer' ? 0 : scenario.metrics.intervened_measurement_count,
            intervention_counts: scenario.scenario_id === 'handoff-successor-transfer'
              ? {
                  ...scenario.metrics.intervention_counts,
                  policy_block: 0,
                }
              : scenario.metrics.intervention_counts,
            failure_class_counts: scenario.scenario_id === 'handoff-successor-transfer'
              ? {
                  ...scenario.metrics.failure_class_counts,
                  none: 1,
                  policy_block: 0,
                }
              : scenario.metrics.failure_class_counts,
          },
        })),
      }),
    });
    const current = buildAoEvalScorecard({
      projectId: PROJECT_ID,
      generatedAt: '2026-03-31T12:30:00.000Z',
      harnessResult: createHarnessResult(),
    });

    const comparison = compareAoEvalScorecards({
      baselineScorecard: baseline,
      currentScorecard: current,
      comparedAt: '2026-03-31T12:31:00.000Z',
    });

    expect(comparison).toMatchObject({
      status: 'regressed',
      baseline_scorecard_id: baseline.scorecard_id,
      current_scorecard_id: current.scorecard_id,
    });
    expect(comparison.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'verification_success_regressed',
      }),
      expect.objectContaining({
        code: 'replay_stability_regressed',
      }),
      expect.objectContaining({
        code: 'continuity_success_regressed',
      }),
      expect.objectContaining({
        code: 'intervention_rate_regressed',
      }),
      expect.objectContaining({
        code: 'failure_class_distribution_regressed',
        metric: 'policy_block',
      }),
    ]));
  });

  it('persists versioned scorecards and baseline aliases under AO artifact roots', () => {
    const repoRoot = createTempRepo();
    const scorecard = buildAoEvalScorecard({
      projectId: PROJECT_ID,
      generatedAt: '2026-03-31T12:40:00.000Z',
      harnessResult: createHarnessResult(),
    });

    const persisted = persistAoEvalScorecard({
      repoRoot,
      projectId: PROJECT_ID,
      scorecard,
      baselineName: 'wave-2-mainline',
    });

    expect(fs.existsSync(persisted.scorecard_path)).toBe(true);
    expect(fs.existsSync(persisted.operator_scorecard_path)).toBe(true);
    expect(fs.existsSync(persisted.baseline_path)).toBe(true);
    expect(fs.existsSync(persisted.operator_baseline_path)).toBe(true);

    const loadedBaseline = loadAoEvalBaseline({
      repoRoot,
      projectId: PROJECT_ID,
      baselineRef: 'wave-2-mainline',
    });

    expect(loadedBaseline).toMatchObject({
      scorecard_id: scorecard.scorecard_id,
      generated_at: '2026-03-31T12:40:00.000Z',
    });
  });
});
