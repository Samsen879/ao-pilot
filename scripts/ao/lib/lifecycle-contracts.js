export const LIFECYCLE_SCHEMA_VERSION = 'ao.lifecycle.v1alpha1';
export const LIFECYCLE_REPORT_FORMAT = 'ao_lifecycle_report';

export {
  GATE_BLOCKER_CODES,
  GATE_NAMES,
  GATE_STATES,
} from './gate-model.js';

export const LIFECYCLE_TRIGGERS = [
  'manual',
  'ci_failed',
  'changes_requested',
  'bugbot_comments',
  'merge_conflicts',
  'approved_and_green',
  'agent_stuck',
  'agent_needs_input',
  'agent_exited',
];

export const LIFECYCLE_DELIVERY_TRIGGER_PRIORITY = [
  'changes_requested',
  'ci_failed',
  'bugbot_comments',
  'merge_conflicts',
  'approved_and_green',
];

export const LIFECYCLE_TOP_STATUSES = [
  'continue',
  'observe',
  'hold',
  'handoff',
  'human_gate',
  'source_failure',
];

export const LIFECYCLE_STRICT_EXIT_CODES = {
  continue: 0,
  observe: 30,
  hold: 31,
  handoff: 32,
  human_gate: 33,
  source_failure: 34,
  invalid_usage: 35,
};

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

export function normalizeLifecycleTrigger(trigger = 'manual') {
  const normalizedTrigger = String(trigger)
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');

  if (!LIFECYCLE_TRIGGERS.includes(normalizedTrigger)) {
    throw new Error(`Unsupported lifecycle trigger: ${trigger}`);
  }

  return normalizedTrigger;
}

export function createLifecycleProjectScope({
  projectId,
  trigger = 'manual',
} = {}) {
  return {
    mode: 'project',
    project_id: String(projectId),
    pr_number: null,
    trigger: normalizeLifecycleTrigger(trigger),
    authoritative_for_release: false,
    decide_only: true,
  };
}

export function createLifecyclePrScope({
  projectId,
  prNumber,
  trigger = 'manual',
} = {}) {
  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  return {
    mode: 'pr',
    project_id: String(projectId),
    pr_number: normalizedPrNumber,
    trigger: normalizeLifecycleTrigger(trigger),
    authoritative_for_release: false,
    decide_only: true,
  };
}

export function createLifecycleFinding({
  code,
  severity,
  origin,
  source_area,
  subject_type,
  subject_id = null,
  summary,
  details = [],
  evidence_refs = [],
  action_ids = [],
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
    action_ids: toStringArray(action_ids),
  };
}

export function createLifecycleAction({
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
