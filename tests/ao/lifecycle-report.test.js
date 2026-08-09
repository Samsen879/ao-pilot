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

  it('renders the current release judgment boundary without suggesting an effect', () => {
    const summary = renderLifecycleHumanSummary(buildReport({
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
          merge: false,
          external_effect: false,
          human_approval: false,
        },
      },
    }));

    expect(summary).toContain('release: release_ready authoritative=true');
    expect(summary).toContain('release_authority: or_preflight_only claims_merge=false claims_external_effect=false claims_human_approval=false');
    expect(summary).toContain('key_findings: none');
    expect(summary).toContain('suggested_actions: none');
  });

  it('renders legacy notification records through the compatibility adapter with deprecation context', () => {
    const summary = renderLifecycleHumanSummary(buildReport({
      schema_version: 'ao.lifecycle.v1alpha1',
      top_status: 'continue',
      findings: [],
      actions: [{
        id: 'notify_human_ready',
        action_class: 'notify_human',
        commands: ['gh pr view 44'],
      }],
      release_decision: {
        disposition: 'notify_human_ready',
        basis: ['ready_for_human_notification'],
        authoritative: true,
      },
    }));

    expect(summary).toContain('release: notify_human_ready authoritative=true observed_as=release_ready');
    expect(summary).toContain('release_authority: observation_only claims_merge=false claims_external_effect=false claims_human_approval=false');
    expect(summary).toContain('legacy_notify_human_ready_deprecated');
    expect(summary).toContain('suggested_actions: gh pr view 44');
  });

  it('renders malformed current claim values without converting them into non-claims', () => {
    const summary = renderLifecycleHumanSummary(buildReport({
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
          merge: false,
          external_effect: 'yes',
        },
      },
    }));

    expect(summary).toContain('claims_merge=false claims_external_effect=invalid("yes") claims_human_approval=missing');
    expect(summary).toContain('[blocker] release_ready_contract_invalid');
  });
});
