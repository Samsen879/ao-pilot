import { describe, expect, it } from '@jest/globals';
import { renderLifecycleHumanSummary } from '../../scripts/ao/lib/lifecycle-report.js';

function buildReport(overrides = {}) {
  return {
    top_status: 'hold',
    scope: {
      mode: 'pr',
      project_id: 'my-project',
      pr_number: 44,
      trigger: 'ci_failed',
    },
    source_health: {
      reconciliation: 'ok',
      doctor: 'ok',
    },
    routing_decision: {
      action: 'continue_current_worker',
      owner_session: 'worker-44',
      target_pr_number: 44,
      reason_codes: ['ownership_clear'],
      authoritative: true,
    },
    release_decision: {
      disposition: 'await_ci',
      basis: ['ci_blocked'],
      authoritative: true,
    },
    findings: [
      {
        code: 'release_waiting_on_ci',
        severity: 'warning',
        summary: 'Release-facing progress is waiting on CI.',
      },
      {
        code: 'worker_continuation_clear',
        severity: 'info',
        summary: 'Current worker ownership continuity is clear.',
      },
    ],
    actions: [
      {
        id: 'hold_ci',
        action_class: 'hold',
        commands: ['gh pr checks 44'],
      },
      {
        id: 'continue_worker',
        action_class: 'continue_worker',
        commands: ['ao status -p my-project --json'],
      },
    ],
    ...overrides,
  };
}

describe('lifecycle report', () => {
  it('renders the key lifecycle summary lines', () => {
    const summary = renderLifecycleHumanSummary(buildReport());

    expect(summary).toContain('top_status: hold');
    expect(summary).toContain('trigger: ci_failed');
    expect(summary).toContain('routing: continue_current_worker owner=worker-44 authoritative=true');
    expect(summary).toContain('release: await_ci authoritative=true');
    expect(summary).toContain('source_health: reconciliation=ok, doctor=ok');
    expect(summary).toContain('key_findings: [warning] release_waiting_on_ci: Release-facing progress is waiting on CI.; [info] worker_continuation_clear: Current worker ownership continuity is clear.');
    expect(summary).toContain('suggested_actions: ao status -p my-project --json | gh pr checks 44');
  });

  it('renders missing findings and actions as none', () => {
    const summary = renderLifecycleHumanSummary(buildReport({
      top_status: 'continue',
      findings: [],
      actions: [],
      release_decision: {
        disposition: 'notify_human_ready',
        basis: ['ready_for_human_notification'],
        authoritative: true,
      },
    }));

    expect(summary).toContain('key_findings: none');
    expect(summary).toContain('suggested_actions: none');
  });
});
