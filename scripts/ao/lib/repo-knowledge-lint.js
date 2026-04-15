import { createDefaultPolicyRules } from './policy-rules.js';

export const REPO_KNOWLEDGE_PROFILE_SCHEMA_VERSION = 'ao.repo-knowledge-profile.v1alpha1';
export const REPO_KNOWLEDGE_LINT_SCHEMA_VERSION = 'ao.repo-knowledge-lint.v1alpha1';
export const REPO_KNOWLEDGE_LINT_FORMAT = 'ao_repo_knowledge_lint';
export const REPO_KNOWLEDGE_LINT_STATUSES = ['pass', 'fail_closed'];
export const REPO_KNOWLEDGE_COMMAND_SURFACES = ['setup', 'verify', 'build'];
export const REPO_KNOWLEDGE_RISK_KINDS = ['workflow', 'infra', 'secret'];
export const REPO_KNOWLEDGE_MATCH_TYPES = ['prefix', 'suffix'];

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRequiredString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${fieldName}`);
  }

  return value.trim();
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

function normalizeIsoTimestamp(value, fieldName) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (Number.isNaN(new Date(normalized).getTime())) {
    throw new Error(`Invalid ${fieldName}`);
  }

  return normalized;
}

function normalizePositiveInteger(value, fieldName) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeEnum(value, fieldName, allowedValues) {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!allowedValues.includes(normalized)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return normalized;
}

function normalizeCommandRecord(command, surface, index) {
  if (!isPlainObject(command)) {
    throw new Error(`Invalid canonical_commands.${surface}[${index}]`);
  }

  return {
    command_id: normalizeRequiredString(
      command.command_id,
      `canonical_commands.${surface}[${index}].command_id`,
    ),
    command: normalizeRequiredString(
      command.command,
      `canonical_commands.${surface}[${index}].command`,
    ),
    source_ref: normalizeRequiredString(
      command.source_ref,
      `canonical_commands.${surface}[${index}].source_ref`,
    ),
  };
}

function normalizeCanonicalCommands(canonicalCommands = {}) {
  if (!isPlainObject(canonicalCommands)) {
    throw new Error('Invalid canonical_commands');
  }

  const normalized = {};
  for (const surface of REPO_KNOWLEDGE_COMMAND_SURFACES) {
    const commands = canonicalCommands[surface] ?? [];
    if (!Array.isArray(commands)) {
      throw new Error(`Invalid canonical_commands.${surface}`);
    }
    normalized[surface] = commands.map((command, index) => normalizeCommandRecord(command, surface, index));
  }

  return normalized;
}

function normalizeRiskSurface(surface, index) {
  if (!isPlainObject(surface)) {
    throw new Error(`Invalid risky_surfaces[${index}]`);
  }

  return {
    surface_id: normalizeRequiredString(surface.surface_id, `risky_surfaces[${index}].surface_id`),
    kind: normalizeEnum(surface.kind, `risky_surfaces[${index}].kind`, REPO_KNOWLEDGE_RISK_KINDS),
    match_type: normalizeEnum(
      surface.match_type,
      `risky_surfaces[${index}].match_type`,
      REPO_KNOWLEDGE_MATCH_TYPES,
    ),
    pattern: normalizeRequiredString(surface.pattern, `risky_surfaces[${index}].pattern`),
  };
}

function normalizeRuntimeHints(runtimeHints = {}) {
  if (!isPlainObject(runtimeHints)) {
    throw new Error('Invalid runtime_hints');
  }

  return {
    runtime_ref: normalizeRequiredString(runtimeHints.runtime_ref, 'runtime_hints.runtime_ref'),
    policy_ref: normalizeRequiredString(runtimeHints.policy_ref, 'runtime_hints.policy_ref'),
    node_engine: normalizeOptionalString(runtimeHints.node_engine),
    package_manager: normalizeRequiredString(runtimeHints.package_manager, 'runtime_hints.package_manager'),
    test_runner: normalizeRequiredString(runtimeHints.test_runner, 'runtime_hints.test_runner'),
    npm_engine: normalizeOptionalString(runtimeHints.npm_engine),
  };
}

function normalizeLintFinding(finding, index) {
  if (!isPlainObject(finding)) {
    throw new Error(`Invalid findings[${index}]`);
  }

  return {
    code: normalizeRequiredString(finding.code, `findings[${index}].code`),
    severity: normalizeRequiredString(finding.severity, `findings[${index}].severity`),
    surface: normalizeRequiredString(finding.surface, `findings[${index}].surface`),
    value: normalizeRequiredString(finding.value, `findings[${index}].value`),
    detail: normalizeOptionalString(finding.detail),
  };
}

function normalizeLintResult(lint = {}) {
  if (!isPlainObject(lint)) {
    throw new Error('Invalid lint');
  }

  return {
    schema_version: normalizeRequiredString(lint.schema_version, 'lint.schema_version'),
    format: normalizeRequiredString(lint.format, 'lint.format'),
    status: normalizeEnum(lint.status, 'lint.status', REPO_KNOWLEDGE_LINT_STATUSES),
    checked_at: normalizeIsoTimestamp(lint.checked_at, 'lint.checked_at'),
    findings: (lint.findings ?? []).map((finding, index) => normalizeLintFinding(finding, index)),
  };
}

function normalizeDocContract(contract) {
  if (contract == null) return null;
  return createRepoKnowledgeProfile(contract);
}

function normalizePackageJson(packageJson) {
  if (!isPlainObject(packageJson)) return {};
  return cloneJsonValue(packageJson);
}

function buildFinding(code, surface, value, detail = null) {
  return {
    code,
    severity: 'error',
    surface,
    value,
    detail: normalizeOptionalString(detail),
  };
}

function findCommandSurfaceViolations(profile, findings) {
  for (const surface of REPO_KNOWLEDGE_COMMAND_SURFACES) {
    if ((profile.canonical_commands?.[surface] ?? []).length > 0) continue;
    findings.push(buildFinding(`missing_canonical_${surface}_command`, 'command_surface', surface));
  }
}

function findMissingPackageScriptViolations(profile, packageJson, findings) {
  const scripts = isPlainObject(packageJson?.scripts) ? packageJson.scripts : {};
  for (const command of profile.canonical_commands.verify) {
    if (command.command.startsWith('npm test') && typeof scripts.test !== 'string') {
      findings.push(buildFinding('missing_package_script', 'command_surface', 'test'));
    }
  }

  for (const command of profile.canonical_commands.build) {
    if (command.command === 'npm run build' && typeof scripts.build !== 'string') {
      findings.push(buildFinding('missing_package_script', 'command_surface', 'build'));
    }
  }
}

function findDocContractViolations(profile, documentationContract, findings) {
  if (documentationContract == null) {
    findings.push(buildFinding('missing_doc_contract', 'doc_contract', 'docs/setup/AO_REPO_KNOWLEDGE.md'));
    return;
  }

  const normalizedDocumentationContract = normalizeDocContract(documentationContract);
  const comparableDocContract = {
    ...normalizedDocumentationContract,
    generated_at: null,
  };
  const comparableProfile = {
    ...profile,
    generated_at: null,
  };
  if (JSON.stringify(comparableDocContract) !== JSON.stringify(comparableProfile)) {
    findings.push(buildFinding(
      'contradictory_doc_contract',
      'doc_contract',
      'docs/setup/AO_REPO_KNOWLEDGE.md',
    ));
  }
}

function buildExpectedRiskSurfaceRefs(policyRules) {
  const refs = [];
  for (const pattern of policyRules.workflow_prefixes ?? []) {
    refs.push({ kind: 'workflow', match_type: 'prefix', pattern });
  }
  for (const pattern of policyRules.infra_prefixes ?? []) {
    refs.push({ kind: 'infra', match_type: 'prefix', pattern });
  }
  for (const pattern of policyRules.infra_suffixes ?? []) {
    refs.push({ kind: 'infra', match_type: 'suffix', pattern });
  }
  for (const pattern of policyRules.secret_prefixes ?? []) {
    refs.push({ kind: 'secret', match_type: 'prefix', pattern });
  }
  for (const pattern of policyRules.secret_suffixes ?? []) {
    refs.push({ kind: 'secret', match_type: 'suffix', pattern });
  }
  return refs;
}

function findUnknownRiskSurfaceViolations(profile, policyRules, findings) {
  const declared = new Set((profile.risky_surfaces ?? []).map((surface) => (
    `${surface.kind}:${surface.match_type}:${surface.pattern}`
  )));

  for (const expectedSurface of buildExpectedRiskSurfaceRefs(policyRules)) {
    const key = `${expectedSurface.kind}:${expectedSurface.match_type}:${expectedSurface.pattern}`;
    if (declared.has(key)) continue;
    findings.push(buildFinding('unknown_risky_surface', 'risky_surface', expectedSurface.pattern));
  }
}

function commandLooksUnsafe(command) {
  const normalized = String(command).toLowerCase();
  return [
    /\brm\s+-rf\b/,
    /\bgit\s+push\s+--force\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+clean\s+-fd\b/,
    /\bnpm\s+audit\s+fix\s+--force\b/,
  ].some((pattern) => pattern.test(normalized));
}

function findUnsafeCommandViolations(profile, findings) {
  for (const surface of REPO_KNOWLEDGE_COMMAND_SURFACES) {
    for (const command of profile.canonical_commands[surface]) {
      if (!commandLooksUnsafe(command.command)) continue;
      findings.push(buildFinding(
        'unsafe_canonical_command',
        'command_surface',
        command.command,
      ));
    }
  }
}

export function createRepoKnowledgeProfile({
  project_id,
  profile_version,
  generated_at,
  canonical_commands = {},
  risky_surfaces = [],
  runtime_hints = {},
} = {}) {
  return {
    schema_version: REPO_KNOWLEDGE_PROFILE_SCHEMA_VERSION,
    project_id: normalizeRequiredString(project_id, 'project_id'),
    profile_version: normalizePositiveInteger(profile_version, 'profile_version'),
    generated_at: normalizeIsoTimestamp(generated_at, 'generated_at'),
    canonical_commands: normalizeCanonicalCommands(canonical_commands),
    risky_surfaces: (risky_surfaces ?? []).map((surface, index) => normalizeRiskSurface(surface, index)),
    runtime_hints: normalizeRuntimeHints(runtime_hints),
  };
}

export function createRepoKnowledgeLintResult({
  status,
  checked_at,
  findings = [],
} = {}) {
  return normalizeLintResult({
    schema_version: REPO_KNOWLEDGE_LINT_SCHEMA_VERSION,
    format: REPO_KNOWLEDGE_LINT_FORMAT,
    status,
    checked_at,
    findings,
  });
}

export function lintRepoKnowledge({
  profile,
  packageJson = {},
  documentationContract = null,
  policyRules = createDefaultPolicyRules(),
  now = new Date().toISOString(),
} = {}) {
  const normalizedProfile = createRepoKnowledgeProfile(profile);
  const normalizedPackageJson = normalizePackageJson(packageJson);
  const normalizedPolicyRules = isPlainObject(policyRules)
    ? cloneJsonValue(policyRules)
    : createDefaultPolicyRules();
  const findings = [];

  findCommandSurfaceViolations(normalizedProfile, findings);
  findMissingPackageScriptViolations(normalizedProfile, normalizedPackageJson, findings);
  findDocContractViolations(normalizedProfile, documentationContract, findings);
  findUnknownRiskSurfaceViolations(normalizedProfile, normalizedPolicyRules, findings);
  findUnsafeCommandViolations(normalizedProfile, findings);

  const status = findings.length > 0 ? 'fail_closed' : 'pass';
  return createRepoKnowledgeLintResult({
    status,
    checked_at: normalizeIsoTimestamp(now, 'now'),
    findings,
  });
}
