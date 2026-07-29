import { describe, expect, it } from '@jest/globals';

import { buildAoMetricsReport } from '../../scripts/ao/lib/run-metrics.js';

const ZERO_INTERVENTIONS = {
  human_gate: 0,
  override: 0,
  explicit_resume: 0,
  successor_handoff: 0,
  policy_block: 0,
  preflight_block: 0,
};

function createSnapshot() {
  return {
    state: {
      controller_run_metrics: [
        {
          controller_run_metric_id: 'controller-early',
          task_id: 'task-1',
          completed_at: '2026-07-01T10:00:00.000Z',
          trigger_kind: 'scheduled_tick',
          failure_class: 'none',
          action_class_counts: {},
          intervention_counts: ZERO_INTERVENTIONS,
        },
        {
          controller_run_metric_id: 'controller-late',
          task_id: 'task-2',
          completed_at: '2026-07-01T12:00:00.000Z',
          trigger_kind: 'ci_failed',
          failure_class: 'ci_failure',
          action_class_counts: {},
          intervention_counts: {
            ...ZERO_INTERVENTIONS,
            policy_block: 1,
          },
        },
      ],
      execution_attempt_metrics: [
        {
          execution_attempt_metric_id: 'execution-middle',
          task_id: 'task-1',
          completed_at: '2026-07-01T11:00:00.000Z',
          status: 'failed',
          failure_class: 'worker_exit',
          retry_cause: 'explicit_resume',
          intervention_counts: {
            ...ZERO_INTERVENTIONS,
            explicit_resume: 1,
          },
        },
      ],
    },
  };
}

describe('AO metrics report', () => {
  it('filters an inclusive time window and derives portable quality rates', () => {
    const report = buildAoMetricsReport({
      projectId: 'portable-project',
      snapshot: createSnapshot(),
      since: '2026-07-01T10:30:00Z',
      until: '2026-07-01T11:30:00Z',
    });

    expect(report).toMatchObject({
      project_id: 'portable-project',
      window: {
        since: '2026-07-01T10:30:00.000Z',
        until: '2026-07-01T11:30:00.000Z',
      },
      summary: {
        controller_run_count: 0,
        execution_attempt_count: 1,
        measurement_count: 1,
        intervened_measurement_count: 1,
        failed_measurement_count: 1,
        intervention_rate: 1,
        failure_rate: 1,
      },
    });
    expect(report.recent_traces.execution_attempts).toHaveLength(1);
  });

  it('rejects inverted and malformed windows', () => {
    expect(() => buildAoMetricsReport({
      snapshot: createSnapshot(),
      since: 'not-a-date',
    })).toThrow('Invalid metrics since');
    expect(() => buildAoMetricsReport({
      snapshot: createSnapshot(),
      since: '2026-07-02T00:00:00Z',
      until: '2026-07-01T00:00:00Z',
    })).toThrow('since is after until');
  });
});
