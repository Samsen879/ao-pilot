import path from 'node:path';

import {
  AO_EVAL_HARNESS_RUN_FORMAT,
  AO_EVAL_HARNESS_RUN_SCHEMA_VERSION,
} from './state-contracts.js';
import {
  loadEvalPackRegistry,
  loadEvalScenario,
  resolveEvalPacks,
  resolveEvalScenarioIds,
} from './eval/catalog.js';
import { createBuiltinEvalRunners } from './eval/builtin-runners.js';
import { replayEvalScenario } from './eval/replay.js';

export const DEFAULT_PROJECT_ID = 'my-project';

function resolveContinuityKindForRunner(runner = null) {
  if (runner === 'managed_resume_continuity') return 'resume';
  if (runner === 'managed_successor_handoff') return 'handoff';
  if (runner === 'managed_ambiguous_continuity') return 'human_gate';
  return 'none';
}

function buildHarnessSummary(scenarioResults = []) {
  const continuityScenarios = scenarioResults.filter(
    (scenario) => scenario.continuity.kind !== 'none',
  );
  return {
    scenario_count: scenarioResults.length,
    passed_scenario_count: scenarioResults.filter((scenario) => scenario.status === 'passed').length,
    failed_scenario_count: scenarioResults.filter((scenario) => scenario.status === 'failed').length,
    replay_stable_scenario_count: scenarioResults.filter((scenario) => scenario.replay.stable).length,
    continuity_scenario_count: continuityScenarios.length,
    continuity_success_count: continuityScenarios.filter(
      (scenario) => scenario.continuity.status === 'success',
    ).length,
  };
}

function buildRuntimeFailure(scenario, error, replayCount) {
  return {
    scenario_id: scenario.scenario_id,
    pack_id: scenario.pack_id,
    runner: scenario.runner,
    title: scenario.title,
    status: 'failed',
    verification: {
      status: 'failed',
      findings: [{
        code: 'scenario_runtime_error',
        summary: error.message,
        details: null,
      }],
    },
    replay: {
      stable: false,
      fingerprint: null,
      replay_fingerprint: null,
      fingerprints: [],
      execution_count: replayCount,
    },
    continuity: {
      kind: resolveContinuityKindForRunner(scenario.runner),
      status: 'failed',
      outcome: 'failed',
    },
    metrics: {
      controller_run_count: 0,
      execution_attempt_count: 0,
      measurement_count: 0,
      intervened_measurement_count: 0,
      intervention_counts: {},
      failure_class_counts: {},
    },
  };
}

function createRunnerRegistry(runnerOverrides = {}) {
  const runners = createBuiltinEvalRunners();
  const entries = runnerOverrides instanceof Map
    ? runnerOverrides.entries()
    : Object.entries(runnerOverrides ?? {});
  for (const [runnerId, runner] of entries) {
    if (typeof runner !== 'function') throw new Error(`Invalid eval runner: ${runnerId}`);
    runners.set(runnerId, runner);
  }
  return runners;
}

export async function runAoEvalHarness({
  projectId = DEFAULT_PROJECT_ID,
  fixtureRoot,
  packNames = ['all'],
  replayCount = 2,
  runnerOverrides = {},
} = {}) {
  if (typeof fixtureRoot !== 'string' || fixtureRoot.trim() === '') {
    throw new Error('Missing eval fixtureRoot');
  }
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const packRegistry = loadEvalPackRegistry(resolvedFixtureRoot);
  const resolvedPackIds = resolveEvalPacks(packRegistry, packNames);
  const scenarioIds = resolveEvalScenarioIds(packRegistry, resolvedPackIds);
  const runners = createRunnerRegistry(runnerOverrides);
  const scenarioResults = [];

  for (const scenarioId of scenarioIds) {
    const scenario = loadEvalScenario(resolvedFixtureRoot, scenarioId);
    const runner = runners.get(scenario.runner);
    if (!runner) {
      scenarioResults.push(buildRuntimeFailure(
        scenario,
        new Error(`Unsupported eval runner: ${scenario.runner}`),
        replayCount,
      ));
      continue;
    }

    try {
      const execution = await replayEvalScenario({
        replayCount,
        execute: () => runner({
          scenario,
          fixtureRoot: resolvedFixtureRoot,
          projectId,
        }),
      });
      scenarioResults.push({
        scenario_id: scenario.scenario_id,
        pack_id: scenario.pack_id,
        runner: scenario.runner,
        title: scenario.title,
        status: execution.primary.verification.status === 'passed' ? 'passed' : 'failed',
        verification: execution.primary.verification,
        replay: execution.replay,
        continuity: execution.primary.continuity,
        metrics: execution.primary.metrics,
      });
    } catch (error) {
      scenarioResults.push(buildRuntimeFailure(scenario, error, replayCount));
    }
  }

  return {
    schema_version: AO_EVAL_HARNESS_RUN_SCHEMA_VERSION,
    format: AO_EVAL_HARNESS_RUN_FORMAT,
    project_id: projectId,
    fixture_root: resolvedFixtureRoot,
    pack_ids: resolvedPackIds,
    scenario_ids: scenarioIds,
    replay_count: replayCount,
    scenario_results: scenarioResults,
    summary: buildHarnessSummary(scenarioResults),
  };
}
