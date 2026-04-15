import { createDefaultPolicyRules } from './policy-rules.js';
import {
  buildRepoKnowledgeRef,
  classifyRepoKnowledgeRisk,
} from './repo-knowledge.js';

export const POLICY_DECISION_SCHEMA_VERSION = 'ao.policy-decision.v1alpha1';
export const POLICY_DECISION_FORMAT = 'ao_control_plane_policy_decision_result';

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized === '' ? null : normalized;
}

function normalizeFilePath(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  return normalized.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeToolName(value) {
  const normalized = normalizeOptionalString(value);
  return normalized == null ? null : normalized.toLowerCase();
}

function normalizeMcpServerName(value) {
  const normalized = normalizeOptionalString(value);
  return normalized == null ? null : normalized.toLowerCase();
}

function normalizeNetworkTarget(value) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;

  try {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)) {
      return new URL(normalized).hostname.toLowerCase();
    }
  } catch {
    return normalized.toLowerCase();
  }

  return normalized
    .replace(/^[^@]+@/, '')
    .split(/[/?#:]/)[0]
    .toLowerCase();
}

function normalizeSecretNeed(need) {
  if (!isPlainObject(need)) return null;

  const credentialKind = normalizeOptionalString(need.credential_kind);
  const provenanceId = normalizeOptionalString(need.provenance_id);
  if (!credentialKind || !provenanceId) return null;

  return {
    credential_kind: credentialKind,
    provenance_id: provenanceId,
  };
}

function uniqueSortedStrings(values, normalizer) {
  return [...new Set((values ?? [])
    .map((value) => normalizer(value))
    .filter((value) => value != null))]
    .sort((left, right) => left.localeCompare(right));
}

function uniqueSortedSecretNeeds(values) {
  const items = (values ?? [])
    .map((value) => normalizeSecretNeed(value))
    .filter((value) => value != null);
  const deduped = new Map();
  for (const item of items) {
    deduped.set(`${item.credential_kind}:${item.provenance_id}`, item);
  }
  return [...deduped.values()].sort((left, right) => {
    const leftKey = `${left.credential_kind}:${left.provenance_id}`;
    const rightKey = `${right.credential_kind}:${right.provenance_id}`;
    return leftKey.localeCompare(rightKey);
  });
}

function normalizePositiveInteger(value) {
  if (value == null) return null;
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function tokenizeCommand(command) {
  return String(command ?? '')
    .match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
}

function stripQuotes(token) {
  return String(token).replace(/^['"]|['"]$/g, '');
}

function extractPrimaryTool(command) {
  const tokens = tokenizeCommand(command).map((token) => stripQuotes(token));
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0])) {
    tokens.shift();
  }

  if (tokens[0] === 'env') {
    tokens.shift();
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0])) {
      tokens.shift();
    }
  }

  return normalizeToolName(tokens[0]);
}

function extractNodeScriptPath(command) {
  const tokens = tokenizeCommand(command).map((token) => stripQuotes(token));
  if (normalizeToolName(tokens[0]) !== 'node') return null;
  if (tokens[1] == null || tokens[1].startsWith('-')) return null;
  return normalizeFilePath(tokens[1]);
}

function extractUrlHosts(command) {
  return uniqueSortedStrings(
    [...String(command ?? '').matchAll(/https?:\/\/[^\s'"]+/g)].map((match) => match[0]),
    normalizeNetworkTarget,
  );
}

function buildFinding(code, severity, surface, value, detail = null) {
  return {
    code,
    severity,
    surface,
    value,
    detail: normalizeOptionalString(detail),
  };
}

function classifyFilePath(filePath, rules) {
  const normalized = normalizeFilePath(filePath);
  if (!normalized) return 'ordinary';

  if ((rules.workflow_prefixes ?? []).some((prefix) => normalized.startsWith(prefix))) {
    return 'workflow';
  }

  if (
    (rules.infra_prefixes ?? []).some((prefix) => normalized.startsWith(prefix))
    || (rules.infra_suffixes ?? []).some((suffix) => normalized.endsWith(suffix))
  ) {
    return 'infra';
  }

  if (
    (rules.secret_prefixes ?? []).some((prefix) => normalized.startsWith(prefix))
    || (rules.secret_suffixes ?? []).some((suffix) => normalized.endsWith(suffix))
  ) {
    return 'secret';
  }

  return 'ordinary';
}

function buildDecisionSummary(decision, findings) {
  if (decision === 'allow') {
    return 'Allow seeded policy action.';
  }

  if (findings.length === 1) {
    return `${decision[0].toUpperCase()}${decision.slice(1)} action due to ${findings[0].code}.`;
  }

  return `${decision[0].toUpperCase()}${decision.slice(1)} action due to ${findings.length} policy findings.`;
}

export function normalizePolicyInput(input = {}) {
  const workflowPaths = uniqueSortedStrings(input.workflow_paths, normalizeFilePath);
  const filePaths = uniqueSortedStrings(
    [...(input.file_paths ?? []), ...workflowPaths],
    normalizeFilePath,
  );

  return {
    task_id: normalizeOptionalString(input.task_id),
    pr_number: normalizePositiveInteger(input.pr_number),
    action_kind: normalizeOptionalString(input.action_kind) ?? 'unknown_action',
    action_class: normalizeOptionalString(input.action_class) ?? 'unknown',
    task_risk: normalizeOptionalString(input.task_risk) ?? 'medium',
    tools: uniqueSortedStrings(input.tools, normalizeToolName),
    mcp_servers: uniqueSortedStrings(input.mcp_servers, normalizeMcpServerName),
    file_paths: filePaths,
    workflow_paths: workflowPaths,
    network_targets: uniqueSortedStrings(input.network_targets, normalizeNetworkTarget),
    secret_needs: uniqueSortedSecretNeeds(input.secret_needs),
  };
}

export function buildPolicyInputForAction({
  task,
  prNumber = null,
  action,
} = {}) {
  const explicitInputs = isPlainObject(action?.policy_inputs) ? action.policy_inputs : {};
  const toolSet = new Set(uniqueSortedStrings(explicitInputs.tools, normalizeToolName));
  const mcpServerSet = new Set(uniqueSortedStrings(explicitInputs.mcp_servers, normalizeMcpServerName));
  const filePathSet = new Set(uniqueSortedStrings(explicitInputs.file_paths, normalizeFilePath));
  const workflowPathSet = new Set(uniqueSortedStrings(explicitInputs.workflow_paths, normalizeFilePath));
  const networkTargetSet = new Set(uniqueSortedStrings(explicitInputs.network_targets, normalizeNetworkTarget));

  for (const command of action?.commands ?? []) {
    const tool = extractPrimaryTool(command);
    if (tool) {
      toolSet.add(tool);
      if (tool === 'gh') {
        networkTargetSet.add('api.github.com');
        networkTargetSet.add('github.com');
      }
    }

    const nodeScriptPath = extractNodeScriptPath(command);
    if (nodeScriptPath) {
      filePathSet.add(nodeScriptPath);
    }

    for (const host of extractUrlHosts(command)) {
      networkTargetSet.add(host);
    }
  }

  return normalizePolicyInput({
    ...explicitInputs,
    task_id: task?.task_id ?? explicitInputs.task_id ?? null,
    pr_number: prNumber ?? explicitInputs.pr_number ?? null,
    action_kind: action?.id ?? explicitInputs.action_kind ?? null,
    action_class: action?.action_class ?? explicitInputs.action_class ?? null,
    task_risk: task?.metadata?.task_risk ?? explicitInputs.task_risk ?? 'medium',
    tools: [...toolSet],
    mcp_servers: [...mcpServerSet],
    file_paths: [...filePathSet],
    workflow_paths: [...workflowPathSet],
    network_targets: [...networkTargetSet],
    secret_needs: explicitInputs.secret_needs ?? [],
  });
}

export function evaluatePolicyDecision({
  input,
  credentialProvenances = [],
  rules = createDefaultPolicyRules(),
  repoKnowledge = null,
} = {}) {
  const normalizedInput = normalizePolicyInput(input);
  const activeRules = createDefaultPolicyRules();
  const providedRules = isPlainObject(rules) ? rules : {};
  Object.assign(activeRules, cloneJsonValue(providedRules));

  const allowedTools = new Set((activeRules.allowed_tools ?? []).map((value) => String(value).toLowerCase()));
  const allowedMcpServers = new Set((activeRules.allowed_mcp_servers ?? []).map((value) => String(value).toLowerCase()));
  const allowedNetworkTargets = new Set((activeRules.allowed_network_targets ?? []).map((value) => String(value).toLowerCase()));
  const credentialProvenanceMap = new Map((credentialProvenances ?? [])
    .filter((record) => record?.provenance_id != null)
    .map((record) => [String(record.provenance_id), record]));
  const repoKnowledgeRef = buildRepoKnowledgeRef(repoKnowledge);
  const findings = [];

  if (repoKnowledgeRef?.lint_status && repoKnowledgeRef.lint_status !== 'pass') {
    findings.push(buildFinding(
      'repo_knowledge_invalid',
      'deny',
      'repo_knowledge',
      `${repoKnowledgeRef.project_id}@${repoKnowledgeRef.profile_version}`,
    ));
  }

  for (const tool of normalizedInput.tools) {
    if (!allowedTools.has(tool)) {
      findings.push(buildFinding('unknown_tool', 'deny', 'tool', tool));
    }
  }

  for (const server of normalizedInput.mcp_servers) {
    if (!allowedMcpServers.has(server)) {
      findings.push(buildFinding('unknown_mcp_server', 'deny', 'mcp_server', server));
    }
  }

  for (const secretNeed of normalizedInput.secret_needs) {
    const provenance = credentialProvenanceMap.get(secretNeed.provenance_id) ?? null;
    if (!provenance) {
      findings.push(buildFinding(
        'unknown_credential_provenance',
        'deny',
        'secret',
        `${secretNeed.credential_kind}:${secretNeed.provenance_id}`,
      ));
      continue;
    }

    if (provenance.trust_decision !== 'trusted') {
      findings.push(buildFinding(
        'untrusted_credential_provenance',
        'deny',
        'secret',
        `${secretNeed.credential_kind}:${secretNeed.provenance_id}`,
      ));
      continue;
    }

    if (provenance.credential_kind !== secretNeed.credential_kind) {
      findings.push(buildFinding(
        'credential_kind_mismatch',
        'deny',
        'secret',
        `${secretNeed.credential_kind}:${secretNeed.provenance_id}`,
      ));
      continue;
    }

    const allowedSources = activeRules.credential_source_allowlist?.[secretNeed.credential_kind] ?? [];
    if (!allowedSources.includes(provenance.source_kind)) {
      findings.push(buildFinding(
        'credential_provenance_not_allowlisted',
        'deny',
        'secret',
        `${secretNeed.credential_kind}:${secretNeed.provenance_id}`,
      ));
    }
  }

  for (const target of normalizedInput.network_targets) {
    if (!allowedNetworkTargets.has(target)) {
      findings.push(buildFinding(
        'network_target_requires_review',
        'downgrade',
        'network',
        target,
      ));
    }
  }

  for (const filePath of normalizedInput.file_paths) {
    const classification = classifyFilePath(filePath, activeRules);
    const repoKnowledgeRiskSurface = classifyRepoKnowledgeRisk(filePath, repoKnowledge);
    const effectiveClassification = repoKnowledgeRiskSurface?.kind ?? classification;
    if (
      repoKnowledgeRef != null
      && classification !== 'ordinary'
      && repoKnowledgeRiskSurface == null
    ) {
      findings.push(buildFinding(
        'unknown_risky_surface',
        'deny',
        'file',
        filePath,
      ));
      continue;
    }
    if (effectiveClassification === 'workflow') {
      findings.push(buildFinding(
        'workflow_mutation_requires_review',
        'downgrade',
        'file',
        filePath,
      ));
      continue;
    }

    if (effectiveClassification === 'infra') {
      findings.push(buildFinding(
        'infra_mutation_requires_review',
        'downgrade',
        'file',
        filePath,
      ));
      continue;
    }

    if (effectiveClassification === 'secret') {
      findings.push(buildFinding(
        'secret_file_requires_review',
        'downgrade',
        'file',
        filePath,
      ));
    }
  }

  const decision = findings.some((finding) => finding.severity === 'deny')
    ? 'deny'
    : findings.some((finding) => finding.severity === 'downgrade')
      ? 'downgrade'
      : 'allow';

  return {
    schema_version: POLICY_DECISION_SCHEMA_VERSION,
    format: POLICY_DECISION_FORMAT,
    policy_version: activeRules.policy_version,
    decision,
    summary: buildDecisionSummary(decision, findings),
    repo_knowledge_ref: repoKnowledgeRef,
    input: cloneJsonValue(normalizedInput),
    findings,
  };
}
