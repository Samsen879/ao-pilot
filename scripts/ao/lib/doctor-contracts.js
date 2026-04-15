export const DOCTOR_SCHEMA_VERSION = 'ao.doctor.v1alpha1';
export const DOCTOR_REPORT_FORMAT = 'ao_doctor_report';

export const DOCTOR_STRICT_EXIT_CODES = {
  healthy: 0,
  warning: 20,
  blocked: 21,
  ambiguous: 22,
  source_failure: 23,
  invalid_usage: 24,
};

export const DOCTOR_ACTION_CLASSES = [
  'inspect',
  'reconcile',
  'git_check',
  'runtime_check',
  'artifact_review',
  'human_review',
];

function toStringArray(values) {
  return (values ?? []).map((value) => String(value));
}

function toEvidenceRefs(values) {
  return (values ?? []).map((value) => ({
    source: String(value.source),
    kind: String(value.kind),
    id: value.id ?? null,
    summary: String(value.summary),
  }));
}

export function createDoctorProjectScope({ projectId } = {}) {
  return {
    mode: 'project',
    project_id: String(projectId),
    pr_number: null,
    authoritative_for_release: false,
    diagnose_only: true,
  };
}

export function createDoctorPrScope({ projectId, prNumber } = {}) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  return {
    mode: 'pr',
    project_id: String(projectId),
    pr_number: normalizedPrNumber,
    authoritative_for_release: false,
    diagnose_only: true,
  };
}

export function createDoctorFinding({
  code,
  severity,
  origin,
  source_area,
  subject_type,
  subject_id = null,
  summary,
  details = [],
  evidence_refs = [],
  suggestion_ids = [],
}) {
  return {
    code: String(code),
    severity: String(severity),
    origin: String(origin),
    source_area: String(source_area),
    subject_type: String(subject_type),
    subject_id,
    summary: String(summary),
    details: toStringArray(details),
    evidence_refs: toEvidenceRefs(evidence_refs),
    suggestion_ids: toStringArray(suggestion_ids),
  };
}

export function createDoctorSuggestion({
  id,
  action_class,
  summary,
  commands = [],
  rationale,
}) {
  return {
    id: String(id),
    action_class: String(action_class),
    summary: String(summary),
    commands: toStringArray(commands),
    rationale: String(rationale),
  };
}

export function createDoctorLocalState({
  repo_root = null,
  cwd,
  current_branch = null,
  head_sha = null,
  detached_head = null,
  upstream_branch = null,
  upstream_tracking = 'unknown',
  worktree_dirty = null,
  staged_changes = null,
  unstaged_changes = null,
  untracked_file_count = null,
  untracked_file_samples = [],
  ao_artifact_paths = [],
  git_observable = false,
  git_error = null,
} = {}) {
  return {
    repo_root,
    cwd: String(cwd),
    current_branch,
    head_sha,
    detached_head,
    upstream_branch,
    upstream_tracking: String(upstream_tracking),
    worktree_dirty,
    staged_changes,
    unstaged_changes,
    untracked_file_count,
    untracked_file_samples: toStringArray(untracked_file_samples),
    ao_artifact_paths: toStringArray(ao_artifact_paths),
    git_observable,
    git_error,
  };
}
