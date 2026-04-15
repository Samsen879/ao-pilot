import { describe, expect, it } from '@jest/globals';
import {
  DOCTOR_SCHEMA_VERSION,
  DOCTOR_REPORT_FORMAT,
  DOCTOR_STRICT_EXIT_CODES,
  DOCTOR_ACTION_CLASSES,
  createDoctorProjectScope,
  createDoctorPrScope,
  createDoctorFinding,
  createDoctorSuggestion,
  createDoctorLocalState,
} from '../../scripts/ao/lib/doctor-contracts.js';

describe('doctor contracts', () => {
  it('freezes the schema identity and strict exit mapping', () => {
    expect(DOCTOR_SCHEMA_VERSION).toBe('ao.doctor.v1alpha1');
    expect(DOCTOR_REPORT_FORMAT).toBe('ao_doctor_report');
    expect(DOCTOR_STRICT_EXIT_CODES).toEqual({
      healthy: 0,
      warning: 20,
      blocked: 21,
      ambiguous: 22,
      source_failure: 23,
      invalid_usage: 24,
    });
  });

  it('builds project and PR doctor scopes', () => {
    expect(createDoctorProjectScope({ projectId: 'my-project' })).toEqual({
      mode: 'project',
      project_id: 'my-project',
      pr_number: null,
      authoritative_for_release: false,
      diagnose_only: true,
    });

    expect(createDoctorPrScope({ projectId: 'my-project', prNumber: 44 })).toEqual({
      mode: 'pr',
      project_id: 'my-project',
      pr_number: 44,
      authoritative_for_release: false,
      diagnose_only: true,
    });
  });

  it('freezes doctor action classes', () => {
    expect(DOCTOR_ACTION_CLASSES).toEqual([
      'inspect',
      'reconcile',
      'git_check',
      'runtime_check',
      'artifact_review',
      'human_review',
    ]);
  });

  it('creates doctor findings and suggestions with normalized arrays', () => {
    expect(createDoctorFinding({
      code: 'dirty_worktree',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'worktree',
      subject_type: 'worktree',
      subject_id: '/tmp/repo',
      summary: 'Worktree is dirty',
      details: ['unstaged changes present'],
      evidence_refs: [{ source: 'repo_local', kind: 'git_status', id: null, summary: 'git status --porcelain=v1 --branch' }],
      suggestion_ids: ['git_status'],
    })).toEqual({
      code: 'dirty_worktree',
      severity: 'warning',
      origin: 'doctor',
      source_area: 'worktree',
      subject_type: 'worktree',
      subject_id: '/tmp/repo',
      summary: 'Worktree is dirty',
      details: ['unstaged changes present'],
      evidence_refs: [{ source: 'repo_local', kind: 'git_status', id: null, summary: 'git status --porcelain=v1 --branch' }],
      suggestion_ids: ['git_status'],
    });

    expect(createDoctorSuggestion({
      id: 'git_status',
      action_class: 'git_check',
      summary: 'Inspect git status',
      commands: ['git status --short'],
      rationale: 'Dirty worktree needs confirmation.',
    })).toEqual({
      id: 'git_status',
      action_class: 'git_check',
      summary: 'Inspect git status',
      commands: ['git status --short'],
      rationale: 'Dirty worktree needs confirmation.',
    });
  });

  it('creates normalized local state defaults without guessing missing values', () => {
    expect(createDoctorLocalState({
      cwd: '/home/user/my-project',
    })).toEqual({
      repo_root: null,
      cwd: '/home/user/my-project',
      current_branch: null,
      head_sha: null,
      detached_head: null,
      upstream_branch: null,
      upstream_tracking: 'unknown',
      worktree_dirty: null,
      staged_changes: null,
      unstaged_changes: null,
      untracked_file_count: null,
      untracked_file_samples: [],
      ao_artifact_paths: [],
      git_observable: false,
      git_error: null,
    });
  });
});
