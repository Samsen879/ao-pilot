import { normalizeLifecycleTrigger } from './lifecycle-contracts.js';

export const DECISION_CHAIN_SCHEMA_VERSION = 'ao.decision-chain.v1alpha1';
export const DECISION_CHAIN_REPORT_FORMAT = 'ao_decision_chain_report';
export const DECISION_CHAIN_STAGES = ['reconcile', 'doctor', 'lifecycle'];
export const DECISION_CHAIN_AUTHORITIES = ['authoritative', 'diagnose_only', 'advisory'];
export const DECISION_CHAIN_CONTRACT_STATUSES = [
  'authoritative_pr_chain',
  'advisory_project_chain',
  'pr_scope_required',
];

function normalizeProjectId(projectId) {
  const normalizedProjectId = String(projectId ?? '').trim();
  if (normalizedProjectId === '') {
    throw new Error('projectId is required');
  }

  return normalizedProjectId;
}

function normalizeScopeMode(scopeMode) {
  const normalizedScopeMode = String(scopeMode ?? '').trim();
  if (!['project', 'pr'].includes(normalizedScopeMode)) {
    throw new Error(`Unsupported scope mode: ${scopeMode}`);
  }

  return normalizedScopeMode;
}

function normalizeAuthority(authority) {
  const normalizedAuthority = String(authority ?? '').trim();
  if (!DECISION_CHAIN_AUTHORITIES.includes(normalizedAuthority)) {
    throw new Error(`Unsupported decision chain authority: ${authority}`);
  }

  return normalizedAuthority;
}

function normalizeStage(stage) {
  const normalizedStage = String(stage ?? '').trim();
  if (!DECISION_CHAIN_STAGES.includes(normalizedStage)) {
    throw new Error(`Unsupported decision chain stage: ${stage}`);
  }

  return normalizedStage;
}

function normalizePrNumber(prNumber) {
  if (prNumber == null) return null;

  const normalizedPrNumber = Number(prNumber);
  if (!Number.isInteger(normalizedPrNumber) || normalizedPrNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }

  return normalizedPrNumber;
}

export function createDecisionChainScope({
  projectId,
  prNumber = null,
  trigger = 'manual',
} = {}) {
  const normalizedPrNumber = normalizePrNumber(prNumber);

  return {
    mode: normalizedPrNumber == null ? 'project' : 'pr',
    project_id: normalizeProjectId(projectId),
    pr_number: normalizedPrNumber,
    trigger: normalizeLifecycleTrigger(trigger),
  };
}

export function createDecisionChainStage({
  stage,
  role,
  required = false,
  executed = false,
  authority = 'advisory',
  scopeMode,
  rationale,
} = {}) {
  return {
    stage: normalizeStage(stage),
    role: String(role ?? ''),
    required: required === true,
    executed: executed === true,
    authority: normalizeAuthority(authority),
    scope_mode: normalizeScopeMode(scopeMode),
    rationale: String(rationale ?? ''),
  };
}
