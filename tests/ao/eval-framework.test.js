import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { runAoEvalHarness } from '../../scripts/ao/lib/eval-harness.js';
import { replayEvalScenario } from '../../scripts/ao/lib/eval/replay.js';

const tempDirs = [];

function createFixtureRoot({ runner = 'custom_runner' } = {}) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-eval-framework-'));
  tempDirs.push(fixtureRoot);
  fs.mkdirSync(path.join(fixtureRoot, 'scenarios'));
  fs.writeFileSync(path.join(fixtureRoot, 'packs.json'), JSON.stringify({
    schema_version: 'ao.eval-pack-registry.v1alpha1',
    format: 'ao_eval_pack_registry',
    packs: [
      {
        pack_id: 'all',
        title: 'All',
        scenario_ids: ['custom-scenario'],
      },
      {
        pack_id: 'custom',
        title: 'Custom',
        scenario_ids: ['custom-scenario'],
      },
    ],
  }));
  fs.writeFileSync(path.join(fixtureRoot, 'scenarios', 'custom-scenario.json'), JSON.stringify({
    schema_version: 'ao.eval-scenario.v1alpha1',
    format: 'ao_eval_scenario',
    scenario_id: 'custom-scenario',
    pack_id: 'custom',
    runner,
    title: 'Custom generic runner',
  }));
  return fixtureRoot;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('generic AO eval framework', () => {
  it('runs caller-supplied runners with configurable deterministic replay', async () => {
    const fixtureRoot = createFixtureRoot();
    const result = await runAoEvalHarness({
      projectId: 'portable-project',
      fixtureRoot,
      packNames: ['custom'],
      replayCount: 3,
      runnerOverrides: {
        custom_runner: async () => ({
          verification: {
            status: 'passed',
            findings: [],
          },
          continuity: {
            kind: 'none',
            status: 'not_applicable',
            outcome: 'none',
          },
          metrics: {
            measurement_count: 1,
          },
          stabilityVector: {
            outcome: 'stable',
            nested: {
              beta: 2,
              alpha: 1,
            },
          },
        }),
      },
    });

    expect(result).toMatchObject({
      project_id: 'portable-project',
      replay_count: 3,
      pack_ids: ['custom'],
      summary: {
        scenario_count: 1,
        passed_scenario_count: 1,
        replay_stable_scenario_count: 1,
      },
    });
    expect(result.scenario_results[0].replay).toMatchObject({
      stable: true,
      execution_count: 3,
      fingerprints: [
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
        expect.stringMatching(/^[a-f0-9]{64}$/),
      ],
    });
  });

  it('turns unsupported runners into explicit failed scenario results', async () => {
    const fixtureRoot = createFixtureRoot({ runner: 'missing_runner' });
    const result = await runAoEvalHarness({
      fixtureRoot,
      packNames: ['custom'],
    });

    expect(result.summary.failed_scenario_count).toBe(1);
    expect(result.scenario_results[0]).toMatchObject({
      status: 'failed',
      verification: {
        findings: [
          {
            code: 'scenario_runtime_error',
            summary: 'Unsupported eval runner: missing_runner',
          },
        ],
      },
    });
  });

  it('rejects invalid replay counts before executing', async () => {
    await expect(replayEvalScenario({
      replayCount: 1,
      execute: async () => ({}),
    })).rejects.toThrow(/replayCount/);
  });
});
