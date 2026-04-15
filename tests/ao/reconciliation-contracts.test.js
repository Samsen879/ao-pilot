import { describe, expect, it } from '@jest/globals';
import {
  SCHEMA_VERSION,
  REPORT_FORMAT,
  ACTION_CLASSES,
  AUTOMATION_DISPOSITIONS,
  createPrScope,
  createProjectScope,
  createFinding,
  createProjectSummary,
} from '../../scripts/ao/lib/reconciliation-contracts.js';

describe('ao reconciliation contracts', () => {
  it('freezes the schema identity', () => {
    expect(SCHEMA_VERSION).toBe('ao.reconciliation.v1alpha1');
    expect(REPORT_FORMAT).toBe('ao_reconciliation_report');
  });

  it('builds a PR-scoped reconciliation scope for automation', () => {
    expect(createPrScope(42)).toEqual({
      mode: 'pr',
      authoritative_for_automation: true,
      authoritative_for_orphan_detection: true,
      selected_pr_numbers: [42],
      selection_basis: ['explicit_pr'],
      selection_notes: [],
    });
  });

  it('builds a project-scoped aggregate scope for AO-linked PRs only', () => {
    expect(createProjectScope({
      prNumbers: [40, 41],
      selectionBasis: ['ao_session_pr_reference', 'ao_session_branch_match'],
    })).toEqual({
      mode: 'project',
      authoritative_for_automation: false,
      authoritative_for_orphan_detection: false,
      selected_pr_numbers: [40, 41],
      selection_basis: ['ao_session_pr_reference', 'ao_session_branch_match'],
      selection_notes: [],
    });
  });

  it('freezes action classes and automation dispositions', () => {
    expect(ACTION_CLASSES).toContain('pause_autonomy');
    expect(AUTOMATION_DISPOSITIONS).toEqual(['continue', 'pause', 'human_gate', 'source_failure']);
  });

  it('creates findings with typed evidence references', () => {
    expect(createFinding({
      code: 'orphan_open_pr',
      severity: 'blocker',
      subject_type: 'pr',
      subject_id: 40,
      summary: 'Open PR has no healthy owner',
      details: ['No non-stale AO worker matched PR #40'],
      evidence_refs: [{ source: 'github', kind: 'pr', id: 40, summary: 'PR is OPEN' }],
    })).toMatchObject({
      code: 'orphan_open_pr',
      severity: 'blocker',
      evidence_refs: [{ source: 'github', kind: 'pr', id: 40 }],
    });
  });

  it('creates empty aggregate project summaries without guessing readiness', () => {
    expect(createProjectSummary()).toEqual({
      selected_pr_count: 0,
      ready_pr_numbers: [],
      blocked_pr_numbers: [],
      ambiguous_pr_numbers: [],
      warning_pr_numbers: [],
      not_applicable_pr_numbers: [],
      basis: [],
    });
  });
});
