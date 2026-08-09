export const INTERVENTION_JUDGMENT_SCHEMA_VERSION = 'ao.intervention-judgment.v1';

export const INTERVENTION_JUDGMENTS = Object.freeze({
  RETRY_REQUIRED: 'retry_required',
  REFRESH_REQUIRED: 'refresh_required',
  ESCALATION_REQUIRED: 'escalation_required',
});

export const BOUNDED_SOURCE_RECOVERY = Object.freeze({
  strategy: 'exponential_backoff',
  max_attempts: 3,
  backoff_ms: Object.freeze([1000, 2000, 4000]),
  requires_fresh_observation_after_exhaustion: true,
});

const LEGACY_RETRY_BASES = new Set(['source_failure']);
const LEGACY_REFRESH_BASES = new Set(['missing_pr_assessment']);
const LEGACY_ESCALATION_BASES = new Set([
  'doctor_ambiguous',
  'ownership_ambiguous',
  'release_readiness_ambiguous',
  'review_escalated',
  'trigger_requires_pr_scope',
]);

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizeBasis(basis) {
  return [...new Set((basis ?? []).map(String).filter(Boolean))];
}

function buildAffectedScope(scope) {
  return {
    mode: scope?.mode === 'pr' ? 'pr' : 'project',
    project_id: scope?.project_id ?? null,
    pr_number: scope?.mode === 'pr' ? (scope?.pr_number ?? null) : null,
  };
}

export function createRetryRequiredDecision({ scope, basis = ['source_failure'] } = {}) {
  return {
    disposition: INTERVENTION_JUDGMENTS.RETRY_REQUIRED,
    basis: normalizeBasis(basis),
    authoritative: true,
    judgment_contract: INTERVENTION_JUDGMENT_SCHEMA_VERSION,
    affected_scope: buildAffectedScope(scope),
    recovery: {
      strategy: BOUNDED_SOURCE_RECOVERY.strategy,
      max_attempts: BOUNDED_SOURCE_RECOVERY.max_attempts,
      backoff_ms: [...BOUNDED_SOURCE_RECOVERY.backoff_ms],
      requires_fresh_observation_after_exhaustion:
        BOUNDED_SOURCE_RECOVERY.requires_fresh_observation_after_exhaustion,
      auditable: true,
    },
  };
}

export function createRefreshRequiredDecision({ scope, basis = ['missing_pr_assessment'] } = {}) {
  return {
    disposition: INTERVENTION_JUDGMENTS.REFRESH_REQUIRED,
    basis: normalizeBasis(basis),
    authoritative: true,
    judgment_contract: INTERVENTION_JUDGMENT_SCHEMA_VERSION,
    affected_scope: buildAffectedScope(scope),
    refresh: {
      requires_new_observation: true,
      accepts_cached_observation: false,
      auditable: true,
    },
  };
}

export function createEscalationRequiredDecision({ scope, basis } = {}) {
  return {
    disposition: INTERVENTION_JUDGMENTS.ESCALATION_REQUIRED,
    basis: normalizeBasis(basis),
    authoritative: false,
    judgment_contract: INTERVENTION_JUDGMENT_SCHEMA_VERSION,
    affected_scope: buildAffectedScope(scope),
    escalation: {
      reason_kind: 'unresolved_authority_ambiguity',
      pause_scope: 'affected_scope_only',
      human_authority_required: true,
    },
  };
}

export function mapLegacyInterventionDecision(releaseDecision, { scope } = {}) {
  const source = cloneJsonValue(releaseDecision);
  if (source == null || typeof source !== 'object') return null;
  const basis = normalizeBasis(source.basis);

  let projection = null;
  if (basis.some((code) => LEGACY_RETRY_BASES.has(code))) {
    projection = createRetryRequiredDecision({ scope, basis });
  } else if (basis.some((code) => LEGACY_REFRESH_BASES.has(code))) {
    projection = createRefreshRequiredDecision({ scope, basis });
  } else if (basis.some((code) => LEGACY_ESCALATION_BASES.has(code))) {
    projection = createEscalationRequiredDecision({ scope, basis });
  }
  if (projection == null) return null;

  return {
    ...projection,
    authoritative: false,
    source_interpretation: {
      disposition: source.disposition ?? null,
      basis,
      authoritative: source.authoritative === true,
      immutable: true,
      deprecated_vocabulary: true,
    },
  };
}
