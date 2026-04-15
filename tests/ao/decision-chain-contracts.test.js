import { describe, expect, it } from '@jest/globals';
import {
  DECISION_CHAIN_AUTHORITIES,
  DECISION_CHAIN_CONTRACT_STATUSES,
  DECISION_CHAIN_REPORT_FORMAT,
  DECISION_CHAIN_SCHEMA_VERSION,
  DECISION_CHAIN_STAGES,
  createDecisionChainScope,
  createDecisionChainStage,
} from '../../scripts/ao/lib/decision-chain-contracts.js';

describe('decision chain contracts', () => {
  it('freezes the schema identity, stages, authorities, and contract statuses', () => {
    expect(DECISION_CHAIN_SCHEMA_VERSION).toBe('ao.decision-chain.v1alpha1');
    expect(DECISION_CHAIN_REPORT_FORMAT).toBe('ao_decision_chain_report');
    expect(DECISION_CHAIN_STAGES).toEqual(['reconcile', 'doctor', 'lifecycle']);
    expect(DECISION_CHAIN_AUTHORITIES).toEqual(['authoritative', 'diagnose_only', 'advisory']);
    expect(DECISION_CHAIN_CONTRACT_STATUSES).toEqual([
      'authoritative_pr_chain',
      'advisory_project_chain',
      'pr_scope_required',
    ]);
  });

  it('builds normalized PR and project scopes', () => {
    expect(createDecisionChainScope({
      projectId: 'my-project',
      prNumber: 44,
      trigger: 'ci_failed',
    })).toEqual({
      mode: 'pr',
      project_id: 'my-project',
      pr_number: 44,
      trigger: 'ci_failed',
    });

    expect(createDecisionChainScope({
      projectId: 'my-project',
      trigger: 'approved-and-green',
    })).toEqual({
      mode: 'project',
      project_id: 'my-project',
      pr_number: null,
      trigger: 'approved_and_green',
    });
  });

  it('creates normalized stage records', () => {
    expect(createDecisionChainStage({
      stage: 'doctor',
      role: 'diagnose',
      required: true,
      executed: true,
      authority: 'diagnose_only',
      scopeMode: 'pr',
      rationale: 'PR-scoped continuity diagnosis is part of the authoritative chain.',
    })).toEqual({
      stage: 'doctor',
      role: 'diagnose',
      required: true,
      executed: true,
      authority: 'diagnose_only',
      scope_mode: 'pr',
      rationale: 'PR-scoped continuity diagnosis is part of the authoritative chain.',
    });
  });
});
