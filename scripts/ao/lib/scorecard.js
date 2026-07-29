import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  AO_EVAL_SCORECARD_FORMAT,
  AO_EVAL_SCORECARD_SCHEMA_VERSION,
} from './state-contracts.js';
import { resolveControlPlanePaths } from './state-migrations.js';
import { createStateRepository } from './state-repository.js';

export const DEFAULT_PROJECT_ID = 'my-project';

function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function buildScorecardId({ projectId, generatedAt, scenarioIds, packIds }) {
  const digest = createHash('sha1')
    .update(JSON.stringify({
      project_id: projectId,
      generated_at: generatedAt,
      scenario_ids: scenarioIds,
      pack_ids: packIds,
    }))
    .digest('hex')
    .slice(0, 12);
  return `scorecard-${digest}`;
}

function normalizeScopeValues(values = []) {
  return [...new Set(values.map((value) => String(value)))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function buildScorecardScope({ projectId, scenarioIds, packIds }) {
  const scope = {
    project_id: projectId,
    pack_ids: normalizeScopeValues(packIds),
    scenario_ids: normalizeScopeValues(scenarioIds),
  };
  return {
    ...scope,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(scope))
      .digest('hex'),
  };
}

function sumCountMaps(countMaps = []) {
  const result = {};
  for (const countMap of countMaps) {
    for (const [key, value] of Object.entries(countMap ?? {})) {
      result[key] = (result[key] ?? 0) + Number(value ?? 0);
    }
  }
  return result;
}

function buildFailureRates(counts, totalMeasurementCount) {
  const rates = {};
  for (const [key, value] of Object.entries(counts)) {
    rates[key] = ratio(value, totalMeasurementCount);
  }
  return rates;
}

function buildDefaultGuardrails() {
  return {
    verification_success: 'non_decreasing',
    replay_stability: 'non_decreasing',
    continuity_success: 'non_decreasing',
    intervention_rate: 'non_increasing',
    failure_class_distribution: 'non_increasing_non_none',
  };
}

export function buildAoEvalScorecard({
  projectId = DEFAULT_PROJECT_ID,
  harnessResult,
  generatedAt = new Date().toISOString(),
} = {}) {
  const scenarioResults = Array.isArray(harnessResult?.scenario_results)
    ? harnessResult.scenario_results
    : [];
  const packIds = Array.isArray(harnessResult?.pack_ids) ? harnessResult.pack_ids : [];
  const scenarioIds = Array.isArray(harnessResult?.scenario_ids)
    ? harnessResult.scenario_ids
    : scenarioResults.map((scenario) => scenario.scenario_id);
  const totalMeasurementCount = scenarioResults.reduce(
    (total, scenario) => total + Number(scenario?.metrics?.measurement_count ?? 0),
    0,
  );
  const verificationPassedCount = scenarioResults.filter(
    (scenario) => scenario?.verification?.status === 'passed',
  ).length;
  const replayStableCount = scenarioResults.filter(
    (scenario) => scenario?.replay?.stable === true,
  ).length;
  const continuityResults = scenarioResults.filter((scenario) => scenario?.continuity?.kind !== 'none');
  const continuitySuccessCount = continuityResults.filter(
    (scenario) => scenario?.continuity?.status === 'success',
  ).length;
  const interventionCount = scenarioResults.reduce(
    (total, scenario) => total + Number(scenario?.metrics?.intervened_measurement_count ?? 0),
    0,
  );
  const failureCounts = sumCountMaps(
    scenarioResults.map((scenario) => scenario?.metrics?.failure_class_counts ?? {}),
  );
  const interventionCounts = sumCountMaps(
    scenarioResults.map((scenario) => scenario?.metrics?.intervention_counts ?? {}),
  );
  const continuityOutcomeCounts = {
    explicit_resume_success: 0,
    successor_handoff_success: 0,
    ambiguous_human_gate_success: 0,
    failed: 0,
    not_applicable: 0,
  };
  for (const scenario of scenarioResults) {
    if (scenario?.continuity?.kind === 'none') {
      continuityOutcomeCounts.not_applicable += 1;
      continue;
    }
    if (scenario?.continuity?.outcome === 'explicit_resume' && scenario?.continuity?.status === 'success') {
      continuityOutcomeCounts.explicit_resume_success += 1;
      continue;
    }
    if (scenario?.continuity?.outcome === 'successor_handoff' && scenario?.continuity?.status === 'success') {
      continuityOutcomeCounts.successor_handoff_success += 1;
      continue;
    }
    if (scenario?.continuity?.outcome === 'ambiguous_human_gate' && scenario?.continuity?.status === 'success') {
      continuityOutcomeCounts.ambiguous_human_gate_success += 1;
      continue;
    }
    continuityOutcomeCounts.failed += 1;
  }

  const findings = [];
  for (const scenario of scenarioResults) {
    if (scenario?.verification?.status === 'failed') {
      findings.push({
        code: 'scenario_verification_failed',
        scenario_id: scenario.scenario_id,
        summary: `Scenario ${scenario.scenario_id} failed verification.`,
      });
    }
    if (scenario?.replay?.stable === false) {
      findings.push({
        code: 'scenario_replay_unstable',
        scenario_id: scenario.scenario_id,
        summary: `Scenario ${scenario.scenario_id} was not stable under replay.`,
      });
    }
    if (scenario?.continuity?.kind !== 'none' && scenario?.continuity?.status === 'failed') {
      findings.push({
        code: 'scenario_continuity_failed',
        scenario_id: scenario.scenario_id,
        summary: `Scenario ${scenario.scenario_id} failed its continuity contract.`,
      });
    }
  }
  const scope = buildScorecardScope({
    projectId,
    scenarioIds,
    packIds,
  });

  return {
    schema_version: AO_EVAL_SCORECARD_SCHEMA_VERSION,
    format: AO_EVAL_SCORECARD_FORMAT,
    scorecard_id: buildScorecardId({
      projectId,
      generatedAt,
      scenarioIds,
      packIds,
    }),
    project_id: projectId,
    generated_at: generatedAt,
    pack_ids: packIds,
    scenario_ids: scenarioIds,
    scope,
    guardrails: buildDefaultGuardrails(),
    summary: {
      scenario_count: scenarioResults.length,
      passed_scenario_count: scenarioResults.filter((scenario) => scenario?.status === 'passed').length,
      failed_scenario_count: scenarioResults.filter((scenario) => scenario?.status === 'failed').length,
      verification_success: {
        passed: verificationPassedCount,
        total: scenarioResults.length,
        rate: ratio(verificationPassedCount, scenarioResults.length),
      },
      replay_stability: {
        stable: replayStableCount,
        total: scenarioResults.length,
        rate: ratio(replayStableCount, scenarioResults.length),
      },
      continuity: {
        successful: continuitySuccessCount,
        total: continuityResults.length,
        rate: ratio(continuitySuccessCount, continuityResults.length),
        outcome_counts: continuityOutcomeCounts,
      },
      intervention_rate: {
        intervened_measurement_count: interventionCount,
        total_measurement_count: totalMeasurementCount,
        rate: ratio(interventionCount, totalMeasurementCount),
      },
      intervention_counts: interventionCounts,
      failure_class_distribution: {
        counts: failureCounts,
        rates: buildFailureRates(failureCounts, totalMeasurementCount),
      },
    },
    scenarios: scenarioResults,
    findings,
    quality_gate: {
      status: findings.length === 0 ? 'passed' : 'failed',
      finding_count: findings.length,
      required_checks: [
        'verification_success',
        'replay_stability',
        'continuity_success',
      ],
    },
  };
}

function createRegressionFinding(code, metric, baselineValue, currentValue) {
  return {
    code,
    metric,
    baseline_value: baselineValue,
    current_value: currentValue,
  };
}

export function compareAoEvalScorecards({
  baselineScorecard,
  currentScorecard,
  comparedAt = new Date().toISOString(),
} = {}) {
  const findings = [];

  const baselineScope = baselineScorecard?.scope ?? buildScorecardScope({
    projectId: baselineScorecard?.project_id ?? null,
    packIds: baselineScorecard?.pack_ids ?? [],
    scenarioIds: baselineScorecard?.scenario_ids ?? [],
  });
  const currentScope = currentScorecard?.scope ?? buildScorecardScope({
    projectId: currentScorecard?.project_id ?? null,
    packIds: currentScorecard?.pack_ids ?? [],
    scenarioIds: currentScorecard?.scenario_ids ?? [],
  });
  if (baselineScope.fingerprint !== currentScope.fingerprint) {
    return {
      status: 'invalid',
      compared_at: comparedAt,
      baseline_scorecard_id: baselineScorecard?.scorecard_id ?? null,
      current_scorecard_id: currentScorecard?.scorecard_id ?? null,
      findings: [
        createRegressionFinding(
          'scorecard_scope_mismatch',
          'scope.fingerprint',
          baselineScope,
          currentScope,
        ),
      ],
    };
  }

  const baselineVerificationRate = baselineScorecard?.summary?.verification_success?.rate ?? 0;
  const currentVerificationRate = currentScorecard?.summary?.verification_success?.rate ?? 0;
  if (currentVerificationRate < baselineVerificationRate) {
    findings.push(createRegressionFinding(
      'verification_success_regressed',
      'verification_success.rate',
      baselineVerificationRate,
      currentVerificationRate,
    ));
  }

  const baselineReplayRate = baselineScorecard?.summary?.replay_stability?.rate ?? 0;
  const currentReplayRate = currentScorecard?.summary?.replay_stability?.rate ?? 0;
  if (currentReplayRate < baselineReplayRate) {
    findings.push(createRegressionFinding(
      'replay_stability_regressed',
      'replay_stability.rate',
      baselineReplayRate,
      currentReplayRate,
    ));
  }

  const baselineContinuityRate = baselineScorecard?.summary?.continuity?.rate ?? 0;
  const currentContinuityRate = currentScorecard?.summary?.continuity?.rate ?? 0;
  if (currentContinuityRate < baselineContinuityRate) {
    findings.push(createRegressionFinding(
      'continuity_success_regressed',
      'continuity.rate',
      baselineContinuityRate,
      currentContinuityRate,
    ));
  }

  const baselineInterventionRate = baselineScorecard?.summary?.intervention_rate?.rate ?? 0;
  const currentInterventionRate = currentScorecard?.summary?.intervention_rate?.rate ?? 0;
  if (currentInterventionRate > baselineInterventionRate) {
    findings.push(createRegressionFinding(
      'intervention_rate_regressed',
      'intervention_rate.rate',
      baselineInterventionRate,
      currentInterventionRate,
    ));
  }

  const baselineFailureCounts = baselineScorecard?.summary?.failure_class_distribution?.counts ?? {};
  const currentFailureCounts = currentScorecard?.summary?.failure_class_distribution?.counts ?? {};
  const failureMetrics = new Set([
    ...Object.keys(baselineFailureCounts),
    ...Object.keys(currentFailureCounts),
  ]);
  for (const metric of failureMetrics) {
    if (metric === 'none') continue;
    const baselineValue = Number(baselineFailureCounts[metric] ?? 0);
    const currentValue = Number(currentFailureCounts[metric] ?? 0);
    if (currentValue > baselineValue) {
      findings.push(createRegressionFinding(
        'failure_class_distribution_regressed',
        metric,
        baselineValue,
        currentValue,
      ));
    }
  }

  return {
    status: findings.length === 0 ? 'ok' : 'regressed',
    compared_at: comparedAt,
    baseline_scorecard_id: baselineScorecard?.scorecard_id ?? null,
    current_scorecard_id: currentScorecard?.scorecard_id ?? null,
    findings,
  };
}

export function persistAoEvalScorecard({
  repoRoot,
  projectId = DEFAULT_PROJECT_ID,
  scorecard,
  baselineName = null,
} = {}) {
  const repository = createStateRepository({
    repoRoot,
    projectId,
  });
  return repository.persistEvalScorecardArtifact({
    scorecard,
    baselineName,
  });
}

export function loadAoEvalBaseline({
  repoRoot,
  projectId = DEFAULT_PROJECT_ID,
  baselineRef,
  cwd = repoRoot ?? process.cwd(),
} = {}) {
  if (typeof baselineRef !== 'string' || baselineRef.trim() === '') {
    throw new Error('Missing baselineRef');
  }

  const normalizedBaselineRef = baselineRef.trim();
  const candidatePath = path.isAbsolute(normalizedBaselineRef)
    ? normalizedBaselineRef
    : path.resolve(cwd, normalizedBaselineRef);
  if (fs.existsSync(candidatePath)) {
    return JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
  }

  const repository = createStateRepository({
    repoRoot,
    projectId,
  });
  const baseline = repository.readEvalBaselineArtifact({
    baselineName: normalizedBaselineRef,
  });
  if (baseline != null) return baseline;

  const controlPlanePaths = resolveControlPlanePaths({
    repoRoot,
    projectId,
  });
  if (normalizedBaselineRef === 'latest' && fs.existsSync(controlPlanePaths.latestEvalScorecardPath)) {
    return JSON.parse(fs.readFileSync(controlPlanePaths.latestEvalScorecardPath, 'utf8'));
  }

  const scorecard = repository.readEvalScorecardArtifact({
    scorecardId: normalizedBaselineRef,
  });
  if (scorecard != null) return scorecard;

  throw new Error(`Unknown eval baseline: ${normalizedBaselineRef}`);
}

function formatFailureCounts(counts = {}) {
  return Object.entries(counts)
    .filter(([, value]) => Number(value) > 0)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ') || 'none';
}

export function renderAoEvalHumanSummary({
  scorecard,
  comparison = null,
  persisted = null,
} = {}) {
  return [
    `scorecard_id: ${scorecard?.scorecard_id ?? 'unknown'}`,
    `packs: ${(scorecard?.pack_ids ?? []).join(', ') || 'none'}`,
    `scenarios: ${scorecard?.summary?.scenario_count ?? 0}`,
    `verification_success: ${scorecard?.summary?.verification_success?.passed ?? 0}/${scorecard?.summary?.verification_success?.total ?? 0}`,
    `replay_stability: ${scorecard?.summary?.replay_stability?.stable ?? 0}/${scorecard?.summary?.replay_stability?.total ?? 0}`,
    `continuity_success: ${scorecard?.summary?.continuity?.successful ?? 0}/${scorecard?.summary?.continuity?.total ?? 0}`,
    `intervention_rate: ${scorecard?.summary?.intervention_rate?.intervened_measurement_count ?? 0}/${scorecard?.summary?.intervention_rate?.total_measurement_count ?? 0}`,
    `failure_classes: ${formatFailureCounts(scorecard?.summary?.failure_class_distribution?.counts ?? {})}`,
    `comparison: ${comparison?.status ?? 'not_requested'}`,
    `scorecard_path: ${persisted?.scorecard_path ?? 'not_persisted'}`,
    `baseline_path: ${persisted?.baseline_path ?? 'none'}`,
  ].join('\n');
}
