import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import { runAoEvalHarness } from '../../scripts/ao/lib/eval-harness.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'eval');

describe('ao eval harness', () => {
  it('runs the full fixture-backed suite reproducibly across named packs', async () => {
    const result = await runAoEvalHarness({
      projectId: 'my-project',
      fixtureRoot: FIXTURE_ROOT,
      packNames: ['all'],
    });

    expect(result).toMatchObject({
      schema_version: 'ao.eval-harness-run.v1alpha1',
      format: 'ao_eval_harness_run',
      project_id: 'my-project',
      pack_ids: [
        'parity',
        'policy-fail-closed',
        'resume-continuity',
        'successor-handoff',
        'continuity-incident-matrix',
      ],
      scenario_ids: [
        'parity-ci-failed-pr',
        'parity-approved-and-green-pr',
        'parity-orphaned-ownership',
        'policy-unknown-tool-fail-closed',
        'resume-explicit-checkpoint',
        'handoff-successor-transfer',
        'ambiguous-competing-successors',
      ],
      summary: {
        scenario_count: 7,
        passed_scenario_count: 7,
        failed_scenario_count: 0,
        replay_stable_scenario_count: 7,
        continuity_scenario_count: 3,
        continuity_success_count: 3,
      },
    });

    expect(result.scenario_results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scenario_id: 'parity-ci-failed-pr',
        pack_id: 'parity',
        status: 'passed',
        verification: {
          status: 'passed',
          findings: [],
        },
        replay: expect.objectContaining({
          stable: true,
          fingerprint: expect.any(String),
        }),
        continuity: {
          kind: 'none',
          status: 'not_applicable',
          outcome: 'none',
        },
        metrics: expect.objectContaining({
          controller_run_count: 1,
          execution_attempt_count: 0,
          failure_class_counts: expect.objectContaining({
            ci_failure: 1,
          }),
        }),
      }),
      expect.objectContaining({
        scenario_id: 'policy-unknown-tool-fail-closed',
        pack_id: 'policy-fail-closed',
        status: 'passed',
        metrics: expect.objectContaining({
          controller_run_count: 1,
          measurement_count: 1,
          intervened_measurement_count: 1,
          intervention_counts: expect.objectContaining({
            policy_block: 2,
          }),
          failure_class_counts: expect.objectContaining({
            policy_block: 1,
          }),
        }),
      }),
      expect.objectContaining({
        scenario_id: 'resume-explicit-checkpoint',
        pack_id: 'resume-continuity',
        status: 'passed',
        continuity: {
          kind: 'resume',
          status: 'success',
          outcome: 'explicit_resume',
          posture: 'restore_ready',
          recommended_action: 'restore_existing_worker',
          checkpoint_state: 'valid',
        },
        metrics: expect.objectContaining({
          controller_run_count: 0,
          execution_attempt_count: 2,
          intervention_counts: expect.objectContaining({
            explicit_resume: 1,
          }),
          failure_class_counts: expect.objectContaining({
            worker_exit: 1,
          }),
        }),
      }),
      expect.objectContaining({
        scenario_id: 'handoff-successor-transfer',
        pack_id: 'successor-handoff',
        status: 'passed',
        continuity: {
          kind: 'handoff',
          status: 'success',
          outcome: 'successor_handoff',
          posture: 'handoff_granted',
          recommended_action: 'handoff_to_successor',
          checkpoint_state: 'valid',
        },
        metrics: expect.objectContaining({
          controller_run_count: 0,
          execution_attempt_count: 2,
          intervention_counts: expect.objectContaining({
            successor_handoff: 1,
          }),
          failure_class_counts: expect.objectContaining({
            worker_exit: 1,
          }),
        }),
      }),
      expect.objectContaining({
        scenario_id: 'ambiguous-competing-successors',
        pack_id: 'continuity-incident-matrix',
        status: 'passed',
        continuity: {
          kind: 'human_gate',
          status: 'success',
          outcome: 'ambiguous_human_gate',
          posture: 'ambiguous',
          recommended_action: 'hold_for_human',
          checkpoint_state: 'valid',
        },
        metrics: expect.objectContaining({
          controller_run_count: 0,
          execution_attempt_count: 1,
          intervention_counts: expect.objectContaining({
            explicit_resume: 0,
            successor_handoff: 0,
          }),
          failure_class_counts: expect.objectContaining({
            worker_exit: 1,
          }),
        }),
      }),
    ]));
  });

  it('supports the task-level continuity incident matrix pack and rejects unknown pack names fail closed', async () => {
    const subset = await runAoEvalHarness({
      projectId: 'my-project',
      fixtureRoot: FIXTURE_ROOT,
      packNames: ['continuity-incident-matrix'],
    });

    expect(subset.pack_ids).toEqual([
      'continuity-incident-matrix',
    ]);
    expect(subset.scenario_ids).toEqual([
      'resume-explicit-checkpoint',
      'handoff-successor-transfer',
      'ambiguous-competing-successors',
    ]);
    expect(subset.summary).toMatchObject({
      scenario_count: 3,
      continuity_scenario_count: 3,
      continuity_success_count: 3,
    });

    await expect(runAoEvalHarness({
      projectId: 'my-project',
      fixtureRoot: FIXTURE_ROOT,
      packNames: ['does-not-exist'],
    })).rejects.toThrow(/unknown eval pack/i);
  });
});
