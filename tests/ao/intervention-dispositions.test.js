import fs from 'node:fs';

import { describe, expect, it } from '@jest/globals';

import { createLifecyclePrScope } from '../../scripts/ao/lib/lifecycle-contracts.js';
import { buildLifecycleReport } from '../../scripts/ao/lib/lifecycle-engine.js';
import {
  BOUNDED_SOURCE_RECOVERY,
  mapLegacyInterventionDecision,
} from '../../scripts/ao/lib/intervention-judgment.js';

const fixturePack = JSON.parse(fs.readFileSync(
  new URL('./fixtures/intervention-dispositions/pack.v1.json', import.meta.url),
  'utf8',
));

function buildReports(input = {}) {
  const assessment = {
    pr_number: 44,
    ownership: { status: 'clear', owner_session: 'worker-44' },
    release_readiness: input.release_ambiguity
      ? { status: 'ambiguous', basis: ['fallback_ambiguous'] }
      : input.ci_failure
        ? { status: 'blocked', basis: ['ci_blocked'] }
        : { status: 'ready', basis: ['all_release_signals_clear'] },
  };
  return {
    reconciliationReport: {
      observed_at: '2026-08-09T14:00:00.000Z',
      project_id: 'my-project',
      top_status: input.source_failure ? 'source_failure' : 'healthy',
      source_health: {
        ao: 'ok',
        github: input.source_failure ? 'failed' : (input.stale_observation ? 'degraded' : 'ok'),
      },
      scope: { selected_pr_numbers: [44] },
      pr_assessments: input.missing_assessment ? [] : [assessment],
      findings: [],
    },
    doctorReport: {
      observed_at: '2026-08-09T14:00:01.000Z',
      top_status: input.doctor_ambiguity ? 'ambiguous' : (input.source_failure ? 'source_failure' : 'healthy'),
      source_health: {
        reconciliation: input.source_failure ? 'failed' : 'ok',
        ao: 'ok', github: 'ok', git: 'ok', worktree: 'ok',
      },
      findings: input.doctor_ambiguity ? [{
        code: 'current_branch_mismatch', severity: 'ambiguous', origin: 'doctor',
        source_area: 'git', subject_type: 'branch', summary: 'Authority is ambiguous.',
      }] : [],
    },
  };
}

function runScenario(scenario) {
  const reports = buildReports(scenario.input);
  return buildLifecycleReport({
    scope: createLifecyclePrScope({
      projectId: 'my-project', prNumber: 44, trigger: 'manual',
    }),
    ...reports,
  });
}

describe('intervention disposition fixture pack', () => {
  it.each(fixturePack.scenarios)('$id produces its deterministic judgment', (scenario) => {
    const report = runScenario(scenario);
    expect(report.top_status).toBe(scenario.expected.top_status);
    expect(report.release_decision.disposition).toBe(scenario.expected.disposition);
    expect(report.actions.map((action) => action.id)).toContain(scenario.expected.action_id);
    if (['retry_required', 'refresh_required'].includes(scenario.expected.disposition)) {
      expect(report.actions.map((action) => action.id)).not.toContain('notify_human_blocked');
    }
  });

  it('keeps retry policy bounded, deterministic, and auditable', () => {
    const report = runScenario(fixturePack.scenarios.find(({ id }) => id === 'source-failure'));
    expect(report.release_decision.recovery).toEqual({
      ...BOUNDED_SOURCE_RECOVERY,
      backoff_ms: [...BOUNDED_SOURCE_RECOVERY.backoff_ms],
      auditable: true,
    });
  });

  it('replays byte-equivalent judgments and preserves legacy source interpretation', () => {
    const success = runScenario(fixturePack.scenarios.find(({ id }) => id === 'success'));
    const replay = runScenario(fixturePack.scenarios.find(({ id }) => id === 'replay'));
    expect(replay).toEqual(success);

    const legacy = { disposition: 'human_gate', basis: ['missing_pr_assessment'], authoritative: false };
    const projection = mapLegacyInterventionDecision(legacy, {
      scope: createLifecyclePrScope({ projectId: 'my-project', prNumber: 44 }),
    });
    expect(legacy).toEqual({
      disposition: 'human_gate', basis: ['missing_pr_assessment'], authoritative: false,
    });
    expect(projection).toMatchObject({
      disposition: 'refresh_required',
      authoritative: false,
      source_interpretation: { disposition: 'human_gate', immutable: true },
    });
  });

  it.each(['fallback_ambiguous', 'release_status_ambiguous'])(
    'maps produced legacy release ambiguity basis %s',
    (basis) => {
      expect(mapLegacyInterventionDecision({
        disposition: 'human_gate', basis: [basis], authoritative: false,
      }, {
        scope: createLifecyclePrScope({ projectId: 'my-project', prNumber: 44 }),
      })).toMatchObject({ disposition: 'escalation_required', basis: [basis] });
    },
  );
});
