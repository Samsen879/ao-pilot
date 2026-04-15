import { describe, expect, it } from '@jest/globals';
import {
  createPrScope,
  createProjectScope,
} from '../../scripts/ao/lib/reconciliation-contracts.js';
import { createGateSnapshot } from '../../scripts/ao/lib/gate-model.js';
import { reconcileObservations } from '../../scripts/ao/lib/reconciliation-engine.js';

function buildAoWorker(overrides = {}) {
  return {
    session_name: 'worker-44',
    session_runtime_id: 'worker-44',
    session_role: 'worker',
    issue_number: 44,
    branch_name: 'feat/issue-44',
    pr_number: 44,
    lifecycle_state: null,
    agent_label: 'codex',
    observed_owner_hint: null,
    linkage_basis: ['session_pr_number'],
    worktree_path: '/tmp/worker-44',
    last_seen_at: '2026-03-24T10:05:00.000Z',
    freshness: {
      status: 'fresh',
      observed_at: '2026-03-24T10:05:00.000Z',
      stale_after_ms: 900000,
      reason: null,
    },
    ...overrides,
  };
}

function buildAoObservation(overrides = {}) {
  return {
    project_id: 'my-project',
    observed_at: '2026-03-24T10:10:00.000Z',
    source_ok: true,
    source_error: null,
    orchestrator: null,
    workers: [],
    raw_summary: {
      session_count: 0,
      orchestrator_count: 0,
      orchestrator_session_names: [],
      worker_count: 0,
      branch_count: 0,
      pr_count: 0,
    },
    ...overrides,
  };
}

function buildAoOrchestrator(overrides = {}) {
  return {
    session_name: 'ao-orchestrator',
    session_runtime_id: 'ao-orchestrator',
    session_role: 'orchestrator',
    issue_number: null,
    branch_name: 'runtime-post-pilot-0323-2239',
    pr_number: null,
    lifecycle_state: null,
    agent_label: 'codex',
    observed_owner_hint: null,
    linkage_basis: ['unknown'],
    worktree_path: '/tmp/ao-orchestrator',
    last_seen_at: '2026-03-24T10:05:00.000Z',
    freshness: {
      status: 'fresh',
      observed_at: '2026-03-24T10:05:00.000Z',
      stale_after_ms: 900000,
      reason: null,
    },
    ...overrides,
  };
}

function buildGitHubPr(overrides = {}) {
  return {
    pr_number: 44,
    observed_at: '2026-03-24T10:10:00.000Z',
    source_ok: true,
    source_error: null,
    state: 'OPEN',
    head_branch: 'feat/issue-44',
    head_sha: 'abc123',
    review_status: 'approved',
    ci_status: 'passing',
    mergeability: 'mergeable',
    is_draft: false,
    url: 'https://example.test/pr/44',
    ...overrides,
  };
}

function buildGitHubObservation(scope, prs) {
  return {
    scope,
    observed_at: '2026-03-24T10:10:00.000Z',
    source_ok: true,
    source_error: null,
    prs,
  };
}

describe('reconciliation engine', () => {
  it('marks an open PR with no healthy owner as orphaned and blocked', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation(),
      githubObservation: buildGitHubObservation(scope, [buildGitHubPr()]),
    });

    expect(report.pr_assessments[0].ownership.status).toBe('orphaned');
    expect(report.pr_assessments[0].release_readiness).toMatchObject({
      status: 'blocked',
      blocker_codes: ['orphan_open_pr'],
      gates: createGateSnapshot({
        ownership: {
          state: 'blocked',
          blocker_codes: ['orphan_open_pr'],
          reason_codes: ['ownership_orphaned'],
        },
        review: {
          state: 'open',
        },
        ci: {
          state: 'open',
        },
        mergeability: {
          state: 'open',
        },
        release: {
          state: 'blocked',
          blocker_codes: ['orphan_open_pr'],
          reason_codes: ['ownership_orphaned'],
        },
      }),
    });
    expect(report.top_status).toBe('blocked');
  });

  it('keeps draft PRs not_applicable even when checks are green', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({ workers: [buildAoWorker()] }),
      githubObservation: buildGitHubObservation(scope, [
        buildGitHubPr({ is_draft: true }),
      ]),
    });

    expect(report.pr_assessments[0].release_readiness.status).toBe('not_applicable');
  });

  it('treats unknown mergeability as ambiguous, not ready', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({ workers: [buildAoWorker()] }),
      githubObservation: buildGitHubObservation(scope, [
        buildGitHubPr({ mergeability: 'unknown' }),
      ]),
    });

    expect(report.pr_assessments[0].release_readiness).toMatchObject({
      status: 'ambiguous',
      blocker_codes: [],
      gates: createGateSnapshot({
        ownership: {
          state: 'open',
        },
        review: {
          state: 'open',
        },
        ci: {
          state: 'open',
        },
        mergeability: {
          state: 'ambiguous',
          reason_codes: ['mergeability_unknown'],
        },
        release: {
          state: 'ambiguous',
          reason_codes: ['mergeability_unknown'],
        },
      }),
    });
    expect(report.automation_disposition).toBe('human_gate');
  });

  it('emits typed gate snapshots and blocker codes for CI-blocked PRs', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({ workers: [buildAoWorker()] }),
      githubObservation: buildGitHubObservation(scope, [
        buildGitHubPr({ ci_status: 'failing' }),
      ]),
    });

    expect(report.pr_assessments[0].release_readiness).toMatchObject({
      status: 'blocked',
      blocker_codes: ['ci_blocked'],
      gates: createGateSnapshot({
        ownership: {
          state: 'open',
        },
        review: {
          state: 'open',
        },
        ci: {
          state: 'blocked',
          blocker_codes: ['ci_blocked'],
        },
        mergeability: {
          state: 'open',
        },
        release: {
          state: 'blocked',
          blocker_codes: ['ci_blocked'],
        },
      }),
    });
  });

  it('treats multiple worker matches at the winning linkage tier as ambiguous ownership', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        workers: [
          buildAoWorker(),
          buildAoWorker({
            session_name: 'worker-45',
            session_runtime_id: 'worker-45',
          }),
        ],
      }),
      githubObservation: buildGitHubObservation(scope, [buildGitHubPr()]),
    });

    expect(report.pr_assessments[0].ownership.status).toBe('ambiguous');
  });

  it('treats AO and GitHub branch disagreement as ambiguous cross-source ownership', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        workers: [
          buildAoWorker({
            branch_name: 'feat/issue-44-stale',
          }),
        ],
      }),
      githubObservation: buildGitHubObservation(scope, [
        buildGitHubPr({
          head_branch: 'feat/issue-44',
        }),
      ]),
    });

    expect(report.pr_assessments[0].ownership).toMatchObject({
      status: 'ambiguous',
      reason: 'branch_mismatch_with_github',
      owner_session: 'worker-44',
      owner_branch_name: 'feat/issue-44-stale',
    });
    expect(report.pr_assessments[0].release_readiness).toMatchObject({
      status: 'ambiguous',
      basis: expect.arrayContaining(['branch_mismatch_with_github']),
    });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ao_github_branch_disagreement',
        severity: 'ambiguous',
      }),
    ]));
    expect(report.findings.map((finding) => finding.code)).not.toContain('multiple_candidate_workers');
  });

  it('aggregates mixed PR states in project mode', () => {
    const scope = createProjectScope({
      prNumbers: [40, 41],
      selectionBasis: ['ao_session_pr_reference'],
    });
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        workers: [
          buildAoWorker({
            session_name: 'worker-40',
            session_runtime_id: 'worker-40',
            pr_number: 40,
            branch_name: 'feat/issue-40',
          }),
          buildAoWorker({
            session_name: 'worker-41a',
            session_runtime_id: 'worker-41a',
            pr_number: 41,
            branch_name: 'feat/issue-41',
          }),
          buildAoWorker({
            session_name: 'worker-41b',
            session_runtime_id: 'worker-41b',
            pr_number: 41,
            branch_name: 'feat/issue-41',
          }),
        ],
      }),
      githubObservation: buildGitHubObservation(scope, [
        buildGitHubPr({
          pr_number: 40,
          head_branch: 'feat/issue-40',
          ci_status: 'failing',
        }),
        buildGitHubPr({
          pr_number: 41,
          head_branch: 'feat/issue-41',
        }),
      ]),
    });

    expect(report.project_summary.blocked_pr_numbers).toEqual([40]);
    expect(report.project_summary.ambiguous_pr_numbers).toEqual([41]);
    expect(report.top_status).toBe('blocked');
  });

  it('marks AO runtime ambiguous when multiple orchestrators are visible', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        orchestrator: buildAoOrchestrator(),
        workers: [buildAoWorker()],
        raw_summary: {
          session_count: 3,
          orchestrator_count: 2,
          orchestrator_session_names: ['ao-orchestrator', 'ao-orchestrator-2'],
          worker_count: 1,
          branch_count: 1,
          pr_count: 1,
        },
      }),
      githubObservation: buildGitHubObservation(scope, [buildGitHubPr()]),
    });

    expect(report.source_health.ao).toBe('degraded');
    expect(report.top_status).toBe('ambiguous');
    expect(report.automation_disposition).toBe('human_gate');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'multiple_orchestrator_sessions',
      'ao_runtime_ambiguous',
    ]));
  });

  it('warns when the visible orchestrator session is stale', () => {
    const scope = createProjectScope({
      prNumbers: [],
      selectionBasis: [],
    });
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        orchestrator: buildAoOrchestrator({
          freshness: {
            status: 'stale',
            observed_at: '2026-03-24T09:00:00.000Z',
            stale_after_ms: 900000,
            reason: null,
          },
        }),
        raw_summary: {
          session_count: 1,
          orchestrator_count: 1,
          orchestrator_session_names: ['ao-orchestrator'],
          worker_count: 0,
          branch_count: 0,
          pr_count: 0,
        },
      }),
      githubObservation: buildGitHubObservation(scope, []),
    });

    expect(report.top_status).toBe('warning');
    expect(report.automation_disposition).toBe('continue');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'stale_orchestrator_session',
        severity: 'warning',
      }),
    ]));
  });

  it('emits explicit AO source failure findings', () => {
    const scope = createProjectScope({
      prNumbers: [],
      selectionBasis: [],
    });
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        source_ok: false,
        source_error: 'ao unavailable',
      }),
      githubObservation: buildGitHubObservation(scope, []),
    });

    expect(report.source_health.ao).toBe('failed');
    expect(report.top_status).toBe('source_failure');
    expect(report.automation_disposition).toBe('source_failure');
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      'ao_source_failed',
      'ao_project_not_observable',
    ]));
  });

  it('emits explicit GitHub source failure findings', () => {
    const scope = createPrScope(44);
    const report = reconcileObservations({
      scope,
      aoObservation: buildAoObservation({
        orchestrator: buildAoOrchestrator(),
        raw_summary: {
          session_count: 1,
          orchestrator_count: 1,
          orchestrator_session_names: ['ao-orchestrator'],
          worker_count: 0,
          branch_count: 0,
          pr_count: 0,
        },
      }),
      githubObservation: {
        scope,
        observed_at: '2026-03-24T10:10:00.000Z',
        source_ok: false,
        source_error: 'gh auth missing',
        prs: [],
      },
    });

    expect(report.source_health.github).toBe('failed');
    expect(report.top_status).toBe('source_failure');
    expect(report.automation_disposition).toBe('source_failure');
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'github_source_failed',
        severity: 'ambiguous',
      }),
    ]));
  });
});
