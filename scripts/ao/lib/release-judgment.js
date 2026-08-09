import {
  LEGACY_RELEASE_JUDGMENT_LIFECYCLE_SCHEMA_VERSION,
  LIFECYCLE_SCHEMA_VERSION,
} from './lifecycle-contracts.js';
import { mapLegacyInterventionDecision } from './intervention-judgment.js';

export const RELEASE_JUDGMENT_SCHEMA_VERSION = 'ao.release-judgment.v1';
export const RELEASE_JUDGMENT_KIND = 'release_ready';
export const RELEASE_READY_AUTHORITY_SCOPE = 'or_preflight_only';

export const RELEASE_READY_NON_CLAIMS = Object.freeze({
  merge: false,
  external_effect: false,
  human_approval: false,
});

export const LEGACY_RELEASE_DISPOSITIONS = Object.freeze({
  NOTIFY_HUMAN_READY: 'notify_human_ready',
  AUTO_MERGE_READY_PR: 'auto_merge_ready_pr',
});

const LEGACY_RELEASE_BASIS = 'ready_for_human_notification';
const RELEASE_READY_BASIS = 'release_preflight_authorized';

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function uniqueStrings(values) {
  return [...new Set((values ?? [])
    .filter((value) => value != null)
    .map((value) => String(value))
    .filter((value) => value !== ''))];
}

export function validateReleaseReadyDecision(releaseDecision) {
  const reasonCodes = [];
  if (releaseDecision == null || typeof releaseDecision !== 'object' || Array.isArray(releaseDecision)) {
    reasonCodes.push('release_decision_missing');
  } else {
    if (releaseDecision.disposition !== RELEASE_JUDGMENT_KIND) {
      reasonCodes.push('release_disposition_invalid');
    }
    if (releaseDecision.judgment_contract !== RELEASE_JUDGMENT_SCHEMA_VERSION) {
      reasonCodes.push('release_judgment_contract_invalid');
    }
    if (releaseDecision.authority_scope !== RELEASE_READY_AUTHORITY_SCOPE) {
      reasonCodes.push('release_authority_scope_invalid');
    }
    if (releaseDecision.authoritative !== true) {
      reasonCodes.push('release_authority_invalid');
    }
    if (
      !Array.isArray(releaseDecision.basis)
      || releaseDecision.basis.length !== 1
      || releaseDecision.basis[0] !== RELEASE_READY_BASIS
    ) {
      reasonCodes.push('release_basis_invalid');
    }
    for (const claim of Object.keys(RELEASE_READY_NON_CLAIMS)) {
      if (releaseDecision.claims?.[claim] !== false) {
        reasonCodes.push(`release_claim_${claim}_invalid`);
      }
    }
  }

  return {
    ok: reasonCodes.length === 0,
    reason_codes: reasonCodes,
  };
}

export function createReleaseReadyDecision() {
  return {
    disposition: RELEASE_JUDGMENT_KIND,
    basis: [RELEASE_READY_BASIS],
    authoritative: true,
    judgment_contract: RELEASE_JUDGMENT_SCHEMA_VERSION,
    authority_scope: RELEASE_READY_AUTHORITY_SCOPE,
    claims: { ...RELEASE_READY_NON_CLAIMS },
  };
}

export function createReleaseVocabularyDeprecationFinding(disposition, {
  subjectId = null,
} = {}) {
  if (disposition === LEGACY_RELEASE_DISPOSITIONS.NOTIFY_HUMAN_READY) {
    return {
      code: 'legacy_notify_human_ready_deprecated',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'release_judgment',
      subject_type: 'release_disposition',
      subject_id: subjectId,
      summary: 'Legacy notify_human_ready vocabulary is deprecated.',
      details: ['Observed with its immutable legacy notification meaning; use release_ready for new AO judgments.'],
      evidence_refs: [],
      action_ids: [],
    };
  }

  if (disposition === LEGACY_RELEASE_DISPOSITIONS.AUTO_MERGE_READY_PR) {
    return {
      code: 'legacy_auto_merge_ready_pr_deprecated',
      severity: 'info',
      origin: 'lifecycle',
      source_area: 'release_judgment',
      subject_type: 'release_disposition',
      subject_id: subjectId,
      summary: 'Legacy auto_merge_ready_pr vocabulary is deprecated for the AO-to-OR topology.',
      details: ['Observed with its immutable legacy effect-request meaning; it is not a release_ready judgment.'],
      evidence_refs: [],
      action_ids: [],
    };
  }

  return null;
}

function createInvalidReleaseJudgmentFinding(validation) {
  return {
    code: 'release_ready_contract_invalid',
    severity: 'blocker',
    origin: 'lifecycle_observation',
    source_area: 'release_judgment',
    subject_type: 'release_disposition',
    subject_id: null,
    summary: 'Observed release_ready data does not satisfy its declared contract.',
    details: validation.reason_codes,
    evidence_refs: [],
    action_ids: [],
  };
}

export function observeReleaseDecision({
  schemaVersion = null,
  releaseDecision = null,
} = {}) {
  if (releaseDecision == null) {
    return {
      decision: null,
      canonical_projection: null,
      deprecation_findings: [],
    };
  }

  const sourceDecision = cloneJsonValue(releaseDecision);
  const sourceDisposition = String(sourceDecision.disposition ?? 'no_release_action');
  const deprecationFinding = createReleaseVocabularyDeprecationFinding(sourceDisposition);

  if (sourceDisposition !== LEGACY_RELEASE_DISPOSITIONS.NOTIFY_HUMAN_READY) {
    let validation = sourceDisposition === RELEASE_JUDGMENT_KIND
      ? validateReleaseReadyDecision(sourceDecision)
      : null;
    if (
      validation != null
      && ![
        LIFECYCLE_SCHEMA_VERSION,
        LEGACY_RELEASE_JUDGMENT_LIFECYCLE_SCHEMA_VERSION,
      ].includes(schemaVersion)
    ) {
      validation = {
        ok: false,
        reason_codes: [
          ...validation.reason_codes,
          'release_lifecycle_schema_unsupported',
        ],
      };
    }
    const invalidFinding = validation != null && !validation.ok
      ? createInvalidReleaseJudgmentFinding(validation)
      : null;
    return {
      decision: sourceDecision,
      canonical_projection: sourceDecision,
      deprecation_findings: [deprecationFinding, invalidFinding].filter(Boolean),
    };
  }

  return {
    decision: sourceDecision,
    canonical_projection: {
      ...sourceDecision,
      disposition: RELEASE_JUDGMENT_KIND,
      basis: uniqueStrings((sourceDecision.basis ?? []).map((basis) => (
        basis === LEGACY_RELEASE_BASIS ? RELEASE_READY_BASIS : basis
      ))),
      judgment_contract: RELEASE_JUDGMENT_SCHEMA_VERSION,
      authority_scope: 'observation_only',
      authoritative: false,
      claims: { ...RELEASE_READY_NON_CLAIMS },
      source_interpretation: {
        schema_version: schemaVersion,
        disposition: sourceDisposition,
        basis: cloneJsonValue(sourceDecision.basis ?? []),
        authoritative: sourceDecision.authoritative === true,
        immutable: true,
        deprecated_vocabulary: true,
      },
    },
    deprecation_findings: [deprecationFinding],
  };
}

export function adaptLifecycleReportForObservation(report) {
  if (report == null) return report;

  const adapted = cloneJsonValue(report);
  const observation = observeReleaseDecision({
    schemaVersion: report.schema_version ?? null,
    releaseDecision: report.release_decision ?? null,
  });
  adapted.release_decision = observation.decision;
  adapted.release_decision_observation = observation.canonical_projection ?? observation.decision;
  const legacyInterventionProjection = report.schema_version === LIFECYCLE_SCHEMA_VERSION
    ? null
    : mapLegacyInterventionDecision(observation.decision, { scope: report.scope });
  if (legacyInterventionProjection != null) {
    adapted.release_decision_observation = legacyInterventionProjection;
  }

  const existingFindingCodes = new Set((adapted.findings ?? []).map((finding) => finding?.code));
  adapted.findings = [
    ...(adapted.findings ?? []),
    ...observation.deprecation_findings.filter((finding) => !existingFindingCodes.has(finding.code)),
  ];

  adapted.observation_adapter = {
    schema_version: 'ao.lifecycle-observation-adapter.v1',
    source_schema_version: report.schema_version ?? null,
    source_preserved: true,
  };
  return adapted;
}
