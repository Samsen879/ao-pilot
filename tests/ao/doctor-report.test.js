import { describe, expect, it } from '@jest/globals';
import { renderDoctorHumanSummary } from '../../scripts/ao/lib/doctor-report.js';

function buildDoctorReport(overrides = {}) {
  return {
    top_status: 'ambiguous',
    source_health: {
      reconciliation: 'degraded',
      ao: 'ok',
      github: 'ok',
      git: 'degraded',
      worktree: 'ok',
    },
    reconciliation_summary: {
      top_status: 'blocked',
      automation_disposition: 'pause',
      selected_pr_numbers: [44],
      finding_codes: ['orphan_open_pr'],
    },
    local_state: {
      current_branch: 'feat/other-branch',
      upstream_branch: 'origin/feat/other-branch',
      worktree_dirty: true,
      ao_artifact_paths: ['.ao-current-issue', 'ao-artifacts/'],
    },
    findings: [
      {
        code: 'detached_head',
        severity: 'blocker',
        summary: 'Current repo is in detached HEAD state.',
      },
      {
        code: 'current_branch_mismatch',
        severity: 'ambiguous',
        summary: 'Current local branch does not match the expected diagnosis branch.',
      },
      {
        code: 'dirty_worktree',
        severity: 'warning',
        summary: 'Current worktree has local modifications.',
      },
    ],
    suggestions: [
      {
        id: 'git_branch_context',
        action_class: 'git_check',
        commands: ['git branch --show-current', 'git status --short'],
      },
      {
        id: 'reconcile_scope',
        action_class: 'reconcile',
        commands: ['node scripts/ao-reconcile.js --json'],
      },
    ],
    ...overrides,
  };
}

describe('doctor report', () => {
  it('renders key sections, severity-ordered findings, and suggested commands', () => {
    const summary = renderDoctorHumanSummary(buildDoctorReport());

    expect(summary).toContain('top_status: ambiguous');
    expect(summary).toContain('source_health: reconciliation=degraded, ao=ok, github=ok, git=degraded, worktree=ok');
    expect(summary).toContain('reconciliation_top_status: blocked');
    expect(summary).toContain('reconciliation_targets: 44');
    expect(summary).toContain('current_branch: feat/other-branch');
    expect(summary).toContain('upstream_branch: origin/feat/other-branch');
    expect(summary).toContain('worktree_dirty: true');
    expect(summary).toContain('ao_artifacts: .ao-current-issue, ao-artifacts/');
    expect(summary).toContain('suggested_commands: git branch --show-current | git status --short | node scripts/ao-reconcile.js --json');

    const blockerIndex = summary.indexOf('[blocker] detached_head');
    const ambiguousIndex = summary.indexOf('[ambiguous] current_branch_mismatch');
    const warningIndex = summary.indexOf('[warning] dirty_worktree');

    expect(blockerIndex).toBeGreaterThanOrEqual(0);
    expect(ambiguousIndex).toBeGreaterThan(blockerIndex);
    expect(warningIndex).toBeGreaterThan(ambiguousIndex);
  });

  it('renders concise output for informational or empty states', () => {
    const summary = renderDoctorHumanSummary(buildDoctorReport({
      top_status: 'healthy',
      source_health: {
        reconciliation: 'ok',
        ao: 'ok',
        github: 'ok',
        git: 'ok',
        worktree: 'ok',
      },
      reconciliation_summary: {
        top_status: 'healthy',
        automation_disposition: 'continue',
        selected_pr_numbers: [],
        finding_codes: [],
      },
      local_state: {
        current_branch: 'runtime-post-pilot-0323-2239',
        upstream_branch: null,
        worktree_dirty: false,
        ao_artifact_paths: [],
      },
      findings: [],
      suggestions: [],
    }));

    expect(summary).toContain('reconciliation_targets: none');
    expect(summary).toContain('ao_artifacts: none');
    expect(summary).toContain('key_findings: none');
    expect(summary).toContain('suggested_commands: none');
  });
});
