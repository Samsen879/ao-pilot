import { describe, expect, it } from '@jest/globals';
import { renderHumanSummary } from '../../scripts/ao/lib/reconciliation-report.js';

function buildReport(overrides = {}) {
  return {
    top_status: 'blocked',
    automation_disposition: 'pause',
    source_health: {
      ao: 'degraded',
      github: 'ok',
    },
    project_summary: {
      selected_pr_count: 2,
      ready_pr_numbers: [],
      blocked_pr_numbers: [40],
      ambiguous_pr_numbers: [41],
      warning_pr_numbers: [41],
      not_applicable_pr_numbers: [],
      basis: ['ao_session_pr_reference', 'ao_session_branch_match'],
    },
    pr_assessments: [
      {
        pr_number: 40,
        ownership: {
          status: 'orphaned',
          owner_session: null,
        },
        release_readiness: {
          status: 'blocked',
        },
      },
      {
        pr_number: 41,
        ownership: {
          status: 'stale',
          owner_session: 'worker-41',
        },
        release_readiness: {
          status: 'ambiguous',
        },
      },
    ],
    findings: [
      {
        code: 'stale_worker_session',
        severity: 'warning',
        summary: 'PR #41 is linked to a stale worker',
      },
      {
        code: 'orphan_open_pr',
        severity: 'blocker',
        summary: 'Open PR #40 has no healthy AO owner',
      },
      {
        code: 'release_readiness_ambiguous',
        severity: 'ambiguous',
        summary: 'PR #41 is not clearly releasable',
      },
    ],
    recommended_actions: [
      {
        action_class: 'pause_autonomy',
        summary: 'Do not continue autonomous delivery until blockers are resolved.',
      },
    ],
    ...overrides,
  };
}

describe('reconciliation report', () => {
  it('renders key human summary sections and ordered findings', () => {
    const summary = renderHumanSummary(buildReport());

    expect(summary).toContain('top_status: blocked');
    expect(summary).toContain('automation_disposition: pause');
    expect(summary).toContain('source_health: ao=degraded, github=ok');
    expect(summary).toContain('selection_basis: ao_session_pr_reference, ao_session_branch_match');
    expect(summary).toContain('ownership_summary: PR #40 orphaned; PR #41 stale via worker-41');
    expect(summary).toContain('release_readiness_summary: PR #40 blocked; PR #41 ambiguous');
    expect(summary).toContain('recommended_actions: pause_autonomy');

    const blockerIndex = summary.indexOf('[blocker] orphan_open_pr');
    const ambiguousIndex = summary.indexOf('[ambiguous] release_readiness_ambiguous');
    const warningIndex = summary.indexOf('[warning] stale_worker_session');

    expect(blockerIndex).toBeGreaterThanOrEqual(0);
    expect(ambiguousIndex).toBeGreaterThan(blockerIndex);
    expect(warningIndex).toBeGreaterThan(ambiguousIndex);
  });

  it('keeps summary concise when there are no PR assessments or findings', () => {
    const summary = renderHumanSummary(buildReport({
      top_status: 'warning',
      automation_disposition: 'continue',
      source_health: {
        ao: 'ok',
        github: 'ok',
      },
      project_summary: {
        selected_pr_count: 0,
        ready_pr_numbers: [],
        blocked_pr_numbers: [],
        ambiguous_pr_numbers: [],
        warning_pr_numbers: [],
        not_applicable_pr_numbers: [],
        basis: [],
      },
      pr_assessments: [],
      findings: [],
      recommended_actions: [
        {
          action_class: 'continue_observe',
          summary: 'Continue observing the PR under the current owner.',
        },
      ],
    }));

    expect(summary).toContain('selected_prs: 0');
    expect(summary).toContain('selection_basis: none');
    expect(summary).toContain('ownership_summary: none');
    expect(summary).toContain('release_readiness_summary: none');
    expect(summary).toContain('key_findings: none');
    expect(summary).toContain('recommended_actions: continue_observe');
  });
});
