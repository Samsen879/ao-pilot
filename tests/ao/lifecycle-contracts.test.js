import { describe, expect, it } from '@jest/globals';
import {
  LIFECYCLE_SCHEMA_VERSION,
  LIFECYCLE_REPORT_FORMAT,
  LIFECYCLE_TRIGGERS,
  LIFECYCLE_TOP_STATUSES,
  LIFECYCLE_STRICT_EXIT_CODES,
  LIFECYCLE_DELIVERY_TRIGGER_PRIORITY,
  normalizeLifecycleTrigger,
  createLifecycleProjectScope,
  createLifecyclePrScope,
  createLifecycleFinding,
  createLifecycleAction,
} from '../../scripts/ao/lib/lifecycle-contracts.js';

describe('lifecycle contracts', () => {
  it('freezes the schema identity, trigger vocabulary, and strict exit mapping', () => {
    expect(LIFECYCLE_SCHEMA_VERSION).toBe('ao.lifecycle.v1alpha1');
    expect(LIFECYCLE_REPORT_FORMAT).toBe('ao_lifecycle_report');
    expect(LIFECYCLE_TRIGGERS).toEqual([
      'manual',
      'ci_failed',
      'changes_requested',
      'bugbot_comments',
      'merge_conflicts',
      'approved_and_green',
      'agent_stuck',
      'agent_needs_input',
      'agent_exited',
    ]);
    expect(LIFECYCLE_TOP_STATUSES).toEqual([
      'continue',
      'observe',
      'hold',
      'handoff',
      'human_gate',
      'source_failure',
    ]);
    expect(LIFECYCLE_STRICT_EXIT_CODES).toEqual({
      continue: 0,
      observe: 30,
      hold: 31,
      handoff: 32,
      human_gate: 33,
      source_failure: 34,
      invalid_usage: 35,
    });
    expect(LIFECYCLE_DELIVERY_TRIGGER_PRIORITY).toEqual([
      'changes_requested',
      'ci_failed',
      'bugbot_comments',
      'merge_conflicts',
      'approved_and_green',
    ]);
  });

  it('normalizes supported lifecycle triggers', () => {
    expect(normalizeLifecycleTrigger()).toBe('manual');
    expect(normalizeLifecycleTrigger('ci_failed')).toBe('ci_failed');
    expect(normalizeLifecycleTrigger('approved-and-green')).toBe('approved_and_green');
    expect(normalizeLifecycleTrigger('agent-needs-input')).toBe('agent_needs_input');
  });

  it('builds project and PR lifecycle scopes', () => {
    expect(createLifecycleProjectScope({
      projectId: 'my-project',
      trigger: 'manual',
    })).toEqual({
      mode: 'project',
      project_id: 'my-project',
      pr_number: null,
      trigger: 'manual',
      authoritative_for_release: false,
      decide_only: true,
    });

    expect(createLifecyclePrScope({
      projectId: 'my-project',
      prNumber: 44,
      trigger: 'ci_failed',
    })).toEqual({
      mode: 'pr',
      project_id: 'my-project',
      pr_number: 44,
      trigger: 'ci_failed',
      authoritative_for_release: false,
      decide_only: true,
    });
  });

  it('creates lifecycle findings and actions with normalized arrays', () => {
    expect(createLifecycleFinding({
      code: 'worker_restore_recommended',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'session',
      subject_id: 'worker-44',
      summary: 'Prior worker restoration is recommended.',
      details: ['Ownership is stale but still specific.'],
      evidence_refs: [{ source: 'ao', kind: 'session', id: 'worker-44', summary: 'Visible stale worker session' }],
      action_ids: ['restore_worker'],
    })).toEqual({
      code: 'worker_restore_recommended',
      severity: 'warning',
      origin: 'lifecycle',
      source_area: 'control',
      subject_type: 'session',
      subject_id: 'worker-44',
      summary: 'Prior worker restoration is recommended.',
      details: ['Ownership is stale but still specific.'],
      evidence_refs: [{ source: 'ao', kind: 'session', id: 'worker-44', summary: 'Visible stale worker session' }],
      action_ids: ['restore_worker'],
    });

    expect(createLifecycleAction({
      id: 'notify_human_ready',
      action_class: 'notify_human',
      summary: 'Notify the human that the PR appears ready.',
      commands: ['gh pr view 44 --json mergeable,reviewDecision,isDraft,url'],
      rationale: 'Release authority remains human-controlled.',
    })).toEqual({
      id: 'notify_human_ready',
      action_class: 'notify_human',
      summary: 'Notify the human that the PR appears ready.',
      commands: ['gh pr view 44 --json mergeable,reviewDecision,isDraft,url'],
      rationale: 'Release authority remains human-controlled.',
    });
  });
});
