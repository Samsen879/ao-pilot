import { describe, expect, it } from '@jest/globals';
import { buildDecisionChainReport, buildDecisionChainStagePlan } from '../../scripts/ao/lib/decision-chain.js';
import { createDecisionChainScope } from '../../scripts/ao/lib/decision-chain-contracts.js';

describe('decision chain report', () => {
  it('marks PR-scoped chains as authoritative and requires all three stages', () => {
    const scope = createDecisionChainScope({
      projectId: 'my-project',
      prNumber: 44,
      trigger: 'ci_failed',
    });

    expect(buildDecisionChainStagePlan({ scope })).toEqual([
      expect.objectContaining({
        stage: 'reconcile',
        required: true,
        authority: 'authoritative',
        scope_mode: 'pr',
      }),
      expect.objectContaining({
        stage: 'doctor',
        required: true,
        authority: 'diagnose_only',
        scope_mode: 'pr',
      }),
      expect.objectContaining({
        stage: 'lifecycle',
        required: true,
        authority: 'authoritative',
        scope_mode: 'pr',
      }),
    ]);
  });

  it('marks project-scoped manual chains as advisory with optional doctor/lifecycle stages', () => {
    const scope = createDecisionChainScope({
      projectId: 'my-project',
      trigger: 'manual',
    });

    expect(buildDecisionChainStagePlan({ scope })).toEqual([
      expect.objectContaining({
        stage: 'reconcile',
        required: true,
        authority: 'advisory',
      }),
      expect.objectContaining({
        stage: 'doctor',
        required: false,
        authority: 'advisory',
      }),
      expect.objectContaining({
        stage: 'lifecycle',
        required: false,
        authority: 'advisory',
      }),
    ]);
  });

  it('normalizes blocking reasons, next actions, and next commands into one report', () => {
    const scope = createDecisionChainScope({
      projectId: 'my-project',
      prNumber: 44,
      trigger: 'approved_and_green',
    });

    const report = buildDecisionChainReport({
      scope,
      reconciliationReport: {
        observed_at: '2026-04-03T10:00:00.000Z',
        top_status: 'healthy',
        automation_disposition: 'continue',
        findings: [],
      },
      doctorReport: {
        observed_at: '2026-04-03T10:00:01.000Z',
        top_status: 'warning',
        findings: [
          {
            code: 'dirty_worktree',
            severity: 'warning',
            origin: 'doctor',
            summary: 'Worktree is dirty.',
          },
        ],
        suggestions: [
          {
            id: 'git_status',
            action_class: 'git_check',
            summary: 'Inspect git status.',
            commands: ['git status --short'],
            rationale: 'Dirty worktree needs confirmation.',
          },
        ],
      },
      lifecycleReport: {
        observed_at: '2026-04-03T10:00:02.000Z',
        top_status: 'continue',
        routing_decision: {
          action: 'continue_current_worker',
          reason_codes: ['ownership_clear'],
          authoritative: true,
        },
        release_decision: {
          disposition: 'notify_human_ready',
          basis: ['ready_for_human_notification'],
          authoritative: true,
        },
        findings: [
          {
            code: 'release_ready_human_notification',
            severity: 'info',
            origin: 'lifecycle',
            summary: 'PR appears ready for explicit human notification.',
          },
        ],
        actions: [
          {
            id: 'notify_human_ready',
            action_class: 'notify_human',
            summary: 'Notify the human that the PR appears ready.',
            commands: ['gh pr view 44 --json mergeable,reviewDecision,isDraft,url'],
            rationale: 'Human approval remains required.',
          },
        ],
      },
    });

    expect(report).toMatchObject({
      schema_version: 'ao.decision-chain.v1alpha1',
      report_format: 'ao_decision_chain_report',
      contract_status: 'authoritative_pr_chain',
      top_status: 'continue',
      automation_disposition: 'continue',
      key_findings: [
        expect.objectContaining({
          stage: 'doctor',
          code: 'dirty_worktree',
          severity: 'warning',
        }),
      ],
      blocking_reasons: [
        expect.objectContaining({
          stage: 'doctor',
          code: 'dirty_worktree',
        }),
      ],
      next_actions: [
        expect.objectContaining({
          stage: 'doctor',
          id: 'git_status',
        }),
        expect.objectContaining({
          stage: 'lifecycle',
          id: 'notify_human_ready',
          action_class: 'notify_human',
        }),
      ],
      next_commands: [
        'git status --short',
        'gh pr view 44 --json mergeable,reviewDecision,isDraft,url',
      ],
      release_decision: expect.objectContaining({
        disposition: 'notify_human_ready',
      }),
      release_decision_observation: expect.objectContaining({
        disposition: 'release_ready',
        authority_scope: 'observation_only',
      }),
      deprecation_findings: [
        expect.objectContaining({
          code: 'legacy_notify_human_ready_deprecated',
          severity: 'info',
        }),
      ],
    });
  });

  it('surfaces malformed current release judgments without repairing their claims', () => {
    const scope = createDecisionChainScope({
      projectId: 'my-project',
      prNumber: 44,
      trigger: 'approved_and_green',
    });
    const report = buildDecisionChainReport({
      scope,
      lifecycleReport: {
        schema_version: 'ao.lifecycle.v1alpha2',
        top_status: 'continue',
        findings: [],
        actions: [],
        release_decision: {
          disposition: 'release_ready',
          basis: ['release_preflight_authorized'],
          authoritative: true,
          judgment_contract: 'ao.release-judgment.v1',
          authority_scope: 'or_preflight_only',
          claims: {
            merge: true,
            external_effect: false,
            human_approval: false,
          },
        },
      },
    });

    expect(report.release_decision.claims.merge).toBe(true);
    expect(report.release_decision_observation.claims.merge).toBe(true);
    expect(report.blocking_reasons).toEqual([
      expect.objectContaining({
        code: 'release_ready_contract_invalid',
        severity: 'blocker',
      }),
    ]);
  });
});
