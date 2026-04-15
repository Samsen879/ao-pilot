export const TASK_SPEC_SCHEMA_VERSION = 'ao.task-spec.v1alpha1';

const PROBLEM_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;
const REF_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9._/-]+$/;
const HUMAN_GATE_PATTERN = /^[a-z][a-z0-9_./-]*$/;

function normalizeOptionalString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function createFinding(code, field, summary) {
  return {
    code,
    field,
    severity: 'blocker',
    summary,
  };
}

function normalizeProblemType(value, findings) {
  if (value != null && typeof value !== 'string') {
    findings.push(createFinding(
      'task_spec_invalid_problem_type',
      'problem_type',
      'TaskSpec problem_type is invalid.',
    ));
    return null;
  }

  const normalized = normalizeOptionalString(value);
  if (normalized == null) {
    findings.push(createFinding(
      'task_spec_missing_problem_type',
      'problem_type',
      'TaskSpec is missing problem_type.',
    ));
    return null;
  }

  if (!PROBLEM_TYPE_PATTERN.test(normalized)) {
    findings.push(createFinding(
      'task_spec_invalid_problem_type',
      'problem_type',
      'TaskSpec problem_type is invalid.',
    ));
    return normalized;
  }

  return normalized;
}

function normalizeAcceptanceContract(value, findings) {
  if (value == null) {
    findings.push(createFinding(
      'task_spec_missing_acceptance_contract',
      'acceptance_contract',
      'TaskSpec is missing acceptance_contract.',
    ));
    return [];
  }

  if (!Array.isArray(value)) {
    findings.push(createFinding(
      'task_spec_invalid_acceptance_contract',
      'acceptance_contract',
      'TaskSpec acceptance_contract must be a non-empty string array.',
    ));
    return [];
  }

  if (value.some((entry) => entry != null && typeof entry !== 'string')) {
    findings.push(createFinding(
      'task_spec_invalid_acceptance_contract',
      'acceptance_contract',
      'TaskSpec acceptance_contract must be a non-empty string array.',
    ));
  }

  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter(Boolean);
  if (!normalized.length) {
    findings.push(createFinding(
      'task_spec_missing_acceptance_contract',
      'acceptance_contract',
      'TaskSpec is missing acceptance_contract.',
    ));
  }

  return normalized;
}

function normalizeRef(value, fieldName, missingCode, invalidCode, findings) {
  if (value != null && typeof value !== 'string') {
    findings.push(createFinding(
      invalidCode,
      fieldName,
      `TaskSpec ${fieldName} is invalid.`,
    ));
    return null;
  }

  const normalized = normalizeOptionalString(value);
  if (normalized == null) {
    findings.push(createFinding(
      missingCode,
      fieldName,
      `TaskSpec is missing ${fieldName}.`,
    ));
    return null;
  }

  if (!REF_PATTERN.test(normalized)) {
    findings.push(createFinding(
      invalidCode,
      fieldName,
      `TaskSpec ${fieldName} is invalid.`,
    ));
    return normalized;
  }

  return normalized;
}

function normalizeHumanGates(value, findings) {
  if (value == null) {
    findings.push(createFinding(
      'task_spec_missing_human_gates',
      'human_gates',
      'TaskSpec is missing human_gates.',
    ));
    return [];
  }

  if (!Array.isArray(value)) {
    findings.push(createFinding(
      'task_spec_invalid_human_gates',
      'human_gates',
      'TaskSpec human_gates must be a string array.',
    ));
    return [];
  }

  if (value.some((entry) => entry != null && typeof entry !== 'string')) {
    findings.push(createFinding(
      'task_spec_invalid_human_gates',
      'human_gates',
      'TaskSpec human_gates contains an invalid value.',
    ));
  }

  const normalized = value
    .map((entry) => normalizeOptionalString(entry))
    .filter(Boolean);
  if (!normalized.length) {
    findings.push(createFinding(
      'task_spec_missing_human_gates',
      'human_gates',
      'TaskSpec is missing human_gates.',
    ));
    return [];
  }

  if (normalized.some((entry) => !HUMAN_GATE_PATTERN.test(entry))) {
    findings.push(createFinding(
      'task_spec_invalid_human_gates',
      'human_gates',
      'TaskSpec human_gates contains an invalid value.',
    ));
  }

  return normalized;
}

export function createTaskSpecSnapshot({
  schema_version,
  problem_type,
  acceptance_contract,
  runtime_ref,
  policy_ref,
  human_gates,
} = {}) {
  const findings = [];

  if (schema_version != null && normalizeOptionalString(schema_version) !== TASK_SPEC_SCHEMA_VERSION) {
    findings.push(createFinding(
      'task_spec_schema_version_mismatch',
      'schema_version',
      'TaskSpec schema version does not match TaskSpec v1.',
    ));
  }

  const spec = {
    problem_type: normalizeProblemType(problem_type, findings),
    acceptance_contract: normalizeAcceptanceContract(acceptance_contract, findings),
    runtime_ref: normalizeRef(
      runtime_ref,
      'runtime_ref',
      'task_spec_missing_runtime_ref',
      'task_spec_invalid_runtime_ref',
      findings,
    ),
    policy_ref: normalizeRef(
      policy_ref,
      'policy_ref',
      'task_spec_missing_policy_ref',
      'task_spec_invalid_policy_ref',
      findings,
    ),
    human_gates: normalizeHumanGates(human_gates, findings),
  };

  return {
    schema_version: TASK_SPEC_SCHEMA_VERSION,
    valid: findings.length === 0,
    findings,
    spec,
  };
}
