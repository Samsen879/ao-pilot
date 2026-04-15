export const SCHEMA_VERSION = 'ao.reconciliation.v1alpha1';
export const REPORT_FORMAT = 'ao_reconciliation_report';

export {
  GATE_BLOCKER_CODES,
  GATE_NAMES,
  GATE_STATES,
} from './gate-model.js';

export const ACTION_CLASSES = [
  'continue_observe',
  'inspect_worker',
  'pause_autonomy',
  'require_human_review',
  'refresh_ao_runtime',
  'check_github_state',
  'no_auto_release',
];

export const AUTOMATION_DISPOSITIONS = [
  'continue',
  'pause',
  'human_gate',
  'source_failure',
];

function toSortedNumberArray(values) {
  return [...new Set((values ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function toStringArray(values) {
  return (values ?? []).map((value) => String(value));
}

export function createPrScope(prNumber) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  return {
    mode: 'pr',
    authoritative_for_automation: true,
    authoritative_for_orphan_detection: true,
    selected_pr_numbers: [normalizedPrNumber],
    selection_basis: ['explicit_pr'],
    selection_notes: [],
  };
}

export function createProjectScope({ prNumbers, selectionBasis, notes = [] } = {}) {
  return {
    mode: 'project',
    authoritative_for_automation: false,
    authoritative_for_orphan_detection: false,
    selected_pr_numbers: toSortedNumberArray(prNumbers),
    selection_basis: toStringArray(selectionBasis),
    selection_notes: toStringArray(notes),
  };
}

export function createFinding({
  code,
  severity,
  subject_type,
  subject_id = null,
  summary,
  details = [],
  evidence_refs = [],
}) {
  return {
    code: String(code),
    severity: String(severity),
    subject_type: String(subject_type),
    subject_id,
    summary: String(summary),
    details: toStringArray(details),
    evidence_refs: evidence_refs.map((ref) => ({
      source: String(ref.source),
      kind: String(ref.kind),
      id: ref.id ?? null,
      summary: String(ref.summary),
    })),
  };
}

export function createProjectSummary(overrides = {}) {
  return {
    selected_pr_count: 0,
    ready_pr_numbers: [],
    blocked_pr_numbers: [],
    ambiguous_pr_numbers: [],
    warning_pr_numbers: [],
    not_applicable_pr_numbers: [],
    basis: [],
    ...overrides,
  };
}
