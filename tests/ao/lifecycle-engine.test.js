import { describe, expect, it } from '@jest/globals';
import {
  createLifecyclePrScope,
  createLifecycleProjectScope,
} from '../../scripts/ao/lib/lifecycle-contracts.js';
import { createGateSnapshot } from '../../scripts/ao/lib/gate-model.js';
import { buildLifecycleReport } from '../../scripts/ao/lib/lifecycle-engine.js';

function buildReconciliationReport(overrides = {}) {
  return {
    schema_version: 'ao.reconciliation.v1alpha1',
    report_format: 'ao_reconciliation_report',
    engine_version: 'phase1-foundation',
    observed_at: '2026-03-24T14:00:00.000Z',
    project_id: 'my-project',
    top_status: 'healthy',
    source_health: {
      ao: 'ok',
      github: 'ok',
    },
    scope: {
      mode: 'pr',
      selected_pr_numbers: [44],
    },
    pr_assessments: [{
      pr_number: 44,
      branch_name: 'feat/issue-44',
      ownership: {
        status: 'clear',
        owner_session: 'worker-44',
        candidate_sessions: ['worker-44'],
      },
      release_readiness: {
        status: 'ready',
        basis: ['all_release_signals_clear'],
      },
    }],
    findings: [],
    ...overrides,
  };
}

function buildDoctorReport(overrides = {}) {
  return {
    schema_version: 'ao.doctor.v1alpha1',
    report_format: 'ao_doctor_report',
    engine_version: 'phase2-doctor',
    observed_at: '2026-03-24T14:00:01.000Z',
    project_id: 'my-project',
    top_status: 'healthy',
    source_health: {
      reconciliation: 'ok',
      ao: 'ok',
      github: 'ok',
      git: 'ok',
      worktree: 'ok',
    },
    findings: [],
    suggestions: [],
    ...overrides,
  };
}

describe('lifecycle engine', () => {
  it('keeps project mode advisory-only', () => {
    const report = buildLifecycleReport({
      scope: createLifecycleProjectScope({
        projectId: 'my-project',
        trigger: 'manual',
      }),
      reconciliationReport: buildReconciliationReport({
        scope: {
          mode: 'project',
          selected_pr_numbers: [44, 45],
        },
      }),
      doctorReport: buildDoctorReport({
        top_status: 'warning',
      }),
    });

    expect(report.top_status).toBe('observe');
    expect(report.routing_decision.action).toBe('no_action');
    expect(report.routing_decision.authoritative).toBe(false);
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'project_scope_advisory_only',
        origin: 'lifecycle',
      }),
    ]));
  });

  it('routes clear ownership to the current worker for worker-follow-up triggers', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'ci_failed',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'clear',
            owner_session: 'worker-44',
            candidate_sessions: ['worker-44'],
          },
          release_readiness: {
            status: 'blocked',
            basis: ['ci_blocked'],
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('hold');
    expect(report.routing_decision).toMatchObject({
      action: 'continue_current_worker',
      owner_session: 'worker-44',
      authoritative: true,
    });
    expect(report.release_decision.disposition).toBe('await_ci');
  });

  it('prefers typed CI blocker data over narrative basis strings', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'ci_failed',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'clear',
            owner_session: 'worker-44',
            candidate_sessions: ['worker-44'],
          },
          release_readiness: {
            status: 'blocked',
            basis: ['legacy_basis_should_not_drive_routing'],
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
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('hold');
    expect(report.release_decision).toMatchObject({
      disposition: 'await_ci',
      authoritative: true,
    });
  });

  it('does not let pending CI override an already blocked typed release gate', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'ci_failed',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'clear',
            owner_session: 'worker-44',
            candidate_sessions: ['worker-44'],
          },
          release_readiness: {
            status: 'blocked',
            basis: ['legacy_basis_should_not_drive_routing'],
            blocker_codes: ['merge_conflict_blocked'],
            gates: createGateSnapshot({
              ownership: {
                state: 'open',
              },
              review: {
                state: 'open',
              },
              ci: {
                state: 'pending',
                reason_codes: ['ci_pending'],
              },
              mergeability: {
                state: 'blocked',
                blocker_codes: ['merge_conflict_blocked'],
              },
              release: {
                state: 'blocked',
                blocker_codes: ['merge_conflict_blocked'],
                reason_codes: ['ci_pending'],
              },
            }),
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('hold');
    expect(report.release_decision).toMatchObject({
      disposition: 'await_mergeability',
      basis: ['merge_conflict_blocked'],
      authoritative: true,
    });
  });

  it('routes stale ownership to restore the previous worker', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'agent_exited',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'stale',
            owner_session: 'worker-44',
            candidate_sessions: ['worker-44'],
          },
          release_readiness: {
            status: 'ambiguous',
            basis: ['stale_worker_session'],
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.routing_decision).toMatchObject({
      action: 'restore_existing_worker',
      owner_session: 'worker-44',
      authoritative: true,
    });
    expect(report.top_status).toBe('human_gate');
  });

  it('routes orphaned ownership to successor handoff', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'agent_exited',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'orphaned',
            owner_session: null,
            candidate_sessions: [],
          },
          release_readiness: {
            status: 'blocked',
            basis: ['ownership_orphaned'],
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('handoff');
    expect(report.routing_decision.action).toBe('handoff_to_successor');
    expect(report.findings.map((finding) => finding.code)).toContain('successor_handoff_recommended');
  });

  it('human-gates ambiguous ownership', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'changes_requested',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'ambiguous',
            owner_session: null,
            candidate_sessions: ['worker-44', 'worker-44b'],
          },
          release_readiness: {
            status: 'ambiguous',
            basis: ['multiple_candidate_workers'],
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('human_gate');
    expect(report.routing_decision.action).toBe('hold_for_human');
    expect(report.findings.map((finding) => finding.code)).toContain('ownership_control_ambiguous');
  });

  it('waits on mergeability when typed gates show mergeability remains ambiguous', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'merge_conflicts',
      }),
      reconciliationReport: buildReconciliationReport({
        pr_assessments: [{
          pr_number: 44,
          branch_name: 'feat/issue-44',
          ownership: {
            status: 'clear',
            owner_session: 'worker-44',
            candidate_sessions: ['worker-44'],
          },
          release_readiness: {
            status: 'ambiguous',
            basis: ['fallback_ambiguous'],
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
          },
        }],
      }),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('hold');
    expect(report.release_decision).toMatchObject({
      disposition: 'await_mergeability',
      authoritative: true,
    });
  });

  it('holds when doctor blocks local control', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'agent_stuck',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport({
        top_status: 'blocked',
        findings: [{
          code: 'detached_head',
          severity: 'blocker',
          origin: 'doctor',
          source_area: 'git',
          subject_type: 'branch',
          subject_id: 'abc123',
          summary: 'Current repo is in detached HEAD state.',
          details: [],
          evidence_refs: [],
          suggestion_ids: [],
        }],
      }),
    });

    expect(report.top_status).toBe('hold');
    expect(report.routing_decision.action).toBe('hold_for_human');
    expect(report.findings.map((finding) => finding.code)).toContain('doctor_blocks_control');
  });

  it('human-gates when doctor remains ambiguous in PR mode', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'agent_needs_input',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport({
        top_status: 'ambiguous',
        findings: [{
          code: 'current_branch_mismatch',
          severity: 'ambiguous',
          origin: 'doctor',
          source_area: 'git',
          subject_type: 'branch',
          subject_id: 'feat/other-branch',
          summary: 'Current local branch does not match the expected diagnosis branch.',
          details: [],
          evidence_refs: [],
          suggestion_ids: [],
        }],
      }),
    });

    expect(report.top_status).toBe('human_gate');
    expect(report.routing_decision.action).toBe('hold_for_human');
  });

  it('notifies the human when approved-and-green is truly ready', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'approved_and_green',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('continue');
    expect(report.release_decision).toMatchObject({
      disposition: 'notify_human_ready',
      authoritative: true,
    });
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'notify_human_ready',
        action_class: 'notify_human',
      }),
    ]));
  });

  it('fails closed when independent review is required and no matching pass exists', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'approved_and_green',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport(),
      reviewRequired: true,
      reviewInspection: null,
      currentHeadSha: 'abc123',
    });

    expect(report.top_status).toBe('hold');
    expect(report.release_decision).toMatchObject({
      disposition: 'await_review',
      basis: ['review_missing'],
      authoritative: true,
    });
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'hold_review',
        action_class: 'hold',
      }),
    ]));
    expect(report.actions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'notify_human_ready',
      }),
    ]));
  });

  it('returns review changes_required verdicts back to implementation flow', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'approved_and_green',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport(),
      reviewRequired: true,
      reviewInspection: {
        review_id: 'review-44',
        task_id: 'issue-44',
        status: 'changes_required',
        posture: 'review_changes_required',
        target_head_sha: 'abc123',
        freeze_status: 'released',
        freeze_active: false,
      },
      currentHeadSha: 'abc123',
    });

    expect(report.top_status).toBe('continue');
    expect(report.release_decision).toMatchObject({
      disposition: 'no_release_action',
      basis: ['review_changes_required'],
      authoritative: true,
    });
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'review_changes_required',
        origin: 'lifecycle',
      }),
    ]));
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'continue_worker',
        action_class: 'continue_worker',
      }),
    ]));
  });

  it('converts escalated review verdicts into a human gate', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'approved_and_green',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport(),
      reviewRequired: true,
      reviewInspection: {
        review_id: 'review-44',
        task_id: 'issue-44',
        status: 'escalated',
        posture: 'review_escalated',
        target_head_sha: 'abc123',
        freeze_status: 'active',
        freeze_active: true,
      },
      currentHeadSha: 'abc123',
    });

    expect(report.top_status).toBe('human_gate');
    expect(report.release_decision).toMatchObject({
      disposition: 'human_gate',
      basis: ['review_escalated'],
      authoritative: false,
    });
  });

  it('treats bugbot review comments as a deterministic review hold', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'bugbot_comments',
      }),
      reconciliationReport: buildReconciliationReport(),
      doctorReport: buildDoctorReport(),
    });

    expect(report.top_status).toBe('hold');
    expect(report.release_decision).toMatchObject({
      disposition: 'await_review',
      authoritative: true,
    });
    expect(report.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'hold_review',
        action_class: 'hold',
      }),
    ]));
  });

  it('treats failed inputs as source failure', () => {
    const report = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: 'my-project',
        prNumber: 44,
        trigger: 'manual',
      }),
      reconciliationReport: buildReconciliationReport({
        source_health: {
          ao: 'failed',
          github: 'ok',
        },
      }),
      doctorReport: buildDoctorReport({
        top_status: 'source_failure',
        source_health: {
          reconciliation: 'failed',
          ao: 'ok',
          github: 'ok',
          git: 'failed',
          worktree: 'failed',
        },
      }),
    });

    expect(report.source_health).toEqual({
      reconciliation: 'failed',
      doctor: 'failed',
    });
    expect(report.top_status).toBe('source_failure');
  });
});
