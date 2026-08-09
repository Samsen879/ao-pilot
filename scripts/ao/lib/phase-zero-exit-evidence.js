import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildCompletionRecordFieldCoverageReport,
  loadCompletionRecordFieldCoverage,
} from './completion-record-field-coverage.js';
import {
  buildFalseSuccessAuditReport,
  loadFalseSuccessFixturePack,
} from './false-success-trajectory-audit.js';
import {
  loadTrajectoryVocabulary,
  validateTrajectoryVocabulary,
} from './trajectory-vocabulary.js';

export const PHASE_ZERO_MANIFEST_VERSION = 'ao.phase-zero-exit-manifest.v1';
export const PHASE_ZERO_REPLAY_VERSION = 'ao.phase-zero-exit-replay-receipt.v1';

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_FOUNDATIONS = Array.from({ length: 11 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`);
const REQUIRED_SCENARIOS = ['success', 'failure', 'missing_evidence', 'replay'];
const EXCLUDED_SCOPE = ['episode_record_storage', 'multi_workstream_implementation', 'knowledge_track_promotion'];
const FROZEN_FOUNDATION_DIGEST = '7b231ce2290e11dcfa1533b87cdbf34fd6dfd712eed636657856d3f51e986e8f';
const FROZEN_BOUNDARY_DIGEST = '984352da186d751f00e9ece2c3e93aa1d6e9d32462bbb9fbb989341372c1e3d7';
const FROZEN_RISK_DIGEST = 'd44fdf243e3c2c71a3974f11511ca0e323565fd8c2f349d260574d687f816cf2';
const FROZEN_ADMISSION = Object.freeze({
  lane_issue: 8,
  foundation_issue: 23,
  corrected_lane_transition_ref: 'https://github.com/Samsen879/ao-pilot/issues/8#issuecomment-5232956289',
  readmission_ref: 'https://github.com/Samsen879/ao-pilot/issues/23#issuecomment-5232956646',
  revoked_admission_ref: 'https://github.com/Samsen879/ao-pilot/issues/23#issuecomment-5232637735',
  revocation_ref: 'https://github.com/Samsen879/ao-pilot/issues/23#issuecomment-5232683454',
});
const ARTIFACT_BINDINGS = Object.freeze({
  trajectory_report: 'docs/foundation/trajectory-truthfulness-report.v1.json',
  lease_report: 'docs/foundation/controller-lease-single-authority-report.v1.json',
  boundary_freeze: 'docs/foundation/judgment-or-effect-contract-freeze.v1.json',
  risk_register: 'docs/foundation/phase-zero-remaining-risk-register.v1.json',
  fixture_pack: 'tests/ao/fixtures/phase-zero-exit/pack.v1.json',
});
const BUNDLE_KEYS_BY_ARTIFACT = Object.freeze({
  trajectory_report: 'trajectory',
  lease_report: 'lease',
  boundary_freeze: 'boundary',
  risk_register: 'risks',
  fixture_pack: 'fixtures',
});
const EXPECTED_SCENARIOS = Object.freeze([
  { id: 'integrated-exact-evidence', class: 'success', mutation: 'none', expected: 'accepted' },
  { id: 'authority-contract-failure-blocks-exit', class: 'failure', mutation: 'ao_merge_claim', expected: 'blocked' },
  { id: 'missing-artifact-evidence-blocks-exit', class: 'missing_evidence', mutation: 'artifact_digest_missing', expected: 'blocked' },
  { id: 'canonical-evidence-replay-is-stable', class: 'replay', mutation: 'none', expected: 'accepted' },
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function stableDigest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function exactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields are not frozen`);
}

function nonEmpty(value, label) {
  assert(typeof value === 'string' && value.trim() === value && value.length > 0, `${label} must be a trimmed non-empty string`);
}

function validateDelivery(delivery, label) {
  exactKeys(delivery, ['pr', 'base_sha', 'governed_head_sha', 'merge_sha', 'tree_sha', 'ci', 'reviews', 'closeout_ref', 'closeout_status'], label);
  assert(Number.isInteger(delivery.pr) && delivery.pr > 0, `${label}.pr invalid`);
  for (const field of ['base_sha', 'governed_head_sha', 'merge_sha', 'tree_sha']) assert(SHA.test(delivery[field]), `${label}.${field} invalid`);
  exactKeys(delivery.ci, ['run_id', 'head_sha', 'status', 'required_jobs'], `${label}.ci`);
  assert(Number.isInteger(delivery.ci.run_id) && delivery.ci.run_id > 0, `${label}.ci.run_id invalid`);
  assert(delivery.ci.head_sha === delivery.merge_sha, `${label}.ci is not bound to merge SHA`);
  assert(delivery.ci.status === 'success', `${label}.ci is not successful`);
  assert(canonicalJson(delivery.ci.required_jobs) === canonicalJson(['fresh-clone-runtime', 'test (20)', 'test (22)']), `${label}.ci required jobs drifted`);
  assert(Array.isArray(delivery.reviews) && delivery.reviews.length === 2, `${label} must bind exactly two review rounds`);
  for (const [index, review] of delivery.reviews.entries()) {
    exactKeys(review, ['round', 'kind', 'ref', 'reviewed_head_sha', 'result'], `${label}.reviews[${index}]`);
    assert(review.round === index + 1, `${label} review order invalid`);
    assert(['submitted_review', 'connector_result_comment'].includes(review.kind), `${label} review kind invalid`);
    nonEmpty(review.ref, `${label}.reviews[${index}].ref`);
    assert(SHA.test(review.reviewed_head_sha), `${label} review head invalid`);
    assert(['findings_repaired', 'pass'].includes(review.result), `${label} review result invalid`);
  }
  nonEmpty(delivery.closeout_ref, `${label}.closeout_ref`);
  assert(['accepted', 'superseded'].includes(delivery.closeout_status), `${label}.closeout_status invalid`);
}

function validateReport(report, schemaVersion, requiredKeys, label) {
  exactKeys(report, ['schema_version', ...requiredKeys], label);
  assert(report.schema_version === schemaVersion, `${label} schema version invalid`);
}

function validateTrajectoryReport(trajectory, repositoryRoot) {
  validateReport(trajectory, 'ao.trajectory-truthfulness-report.v1', ['status', 'source_contracts', 'vocabulary_digest', 'false_success', 'completion_record', 'behavior_coverage'], 'trajectory report');
  assert(canonicalJson(trajectory.source_contracts) === canonicalJson([
    'ao.trajectory-vocabulary.v1@1.3.0',
    'ao.false-success-trajectory-audit-report.v1',
    'ao.child-completion.v1alpha1',
    'ao.completion-record-field-coverage.v1',
  ]), 'Trajectory source contracts drifted');
  const inventory = loadTrajectoryVocabulary(path.join(repositoryRoot, 'docs/foundation/trajectory-vocabulary.v1.json'));
  const vocabulary = validateTrajectoryVocabulary(inventory, { repositoryRoot });
  const falseSuccess = buildFalseSuccessAuditReport(
    loadFalseSuccessFixturePack(path.join(repositoryRoot, 'tests/ao/fixtures/false-success-trajectories/pack.v1.json')),
    inventory,
  );
  const coverage = buildCompletionRecordFieldCoverageReport(
    loadCompletionRecordFieldCoverage(path.join(repositoryRoot, 'docs/foundation/completion-record-field-coverage.v1.json')),
    { repositoryRoot },
  );
  const completionSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'schemas/ao.child-completion.v1alpha1.schema.json'), 'utf8'));
  const inputSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'schemas/ao.child-completion-input-manifest.v1alpha1.schema.json'), 'utf8'));
  assert(trajectory.status === 'accepted', 'Trajectory truthfulness not accepted');
  assert(trajectory.vocabulary_digest === vocabulary.digest, 'Trajectory vocabulary digest drifted from source');
  assert(trajectory.false_success.report_fingerprint === falseSuccess.report_fingerprint, 'False-success fingerprint drifted from source');
  assert(trajectory.false_success.blocking_fixture_count === falseSuccess.summary.blocking_finding_count, 'False-success fixture coverage drifted');
  assert(trajectory.false_success.unresolved_producer_count === falseSuccess.summary.unresolved_producer_count, 'False-success producer count drifted');
  assert(trajectory.false_success.unresolved_promotion_path_count === 0, 'Trajectory truthfulness has an unresolved promotion path');
  exactKeys(trajectory.completion_record, ['schema_version', 'schema_path', 'input_manifest_schema_path', 'candidate_field_count', 'required_count', 'conditional_count', 'unsupported_count', 'coverage_fingerprint', 'missing_required_policy', 'unsupported_narrative_policy'], 'trajectory.completion_record');
  assert(completionSchema.properties.schema_version.const === trajectory.completion_record.schema_version, 'Completion Record schema version drifted');
  assert(inputSchema.properties.schema_version.const === 'ao.child-completion-input-manifest.v1alpha1', 'Completion input schema drifted');
  assert(trajectory.completion_record.coverage_fingerprint === coverage.report_fingerprint, 'Completion field coverage fingerprint drifted from source');
  assert(trajectory.completion_record.candidate_field_count === coverage.summary.candidate_count, 'Completion field count drifted from source');
  assert(trajectory.completion_record.required_count === coverage.summary.required_count, 'Completion required count drifted');
  assert(trajectory.completion_record.conditional_count === coverage.summary.conditional_count, 'Completion conditional count drifted');
  assert(trajectory.completion_record.unsupported_count === coverage.summary.unsupported_count, 'Completion unsupported count drifted');
  assert(trajectory.completion_record.missing_required_policy === 'fail_closed', 'Completion missing-evidence policy drifted');
  assert(trajectory.completion_record.unsupported_narrative_policy === 'omit_without_inference', 'Completion narrative policy drifted');
  assert(canonicalJson(trajectory.behavior_coverage) === canonicalJson(REQUIRED_SCENARIOS), 'Trajectory behavior coverage drifted');
}

function validateLeaseReport(lease, repositoryRoot) {
  validateReport(lease, 'ao.controller-lease-single-authority-report.v1', ['status', 'authority', 'projection', 'failure_policy', 'replay'], 'lease report');
  exactKeys(lease.authority, ['persistent_source', 'schema_version', 'single_writer_lock', 'accepted_repair_pr', 'accepted_safety_pr'], 'lease.authority');
  assert(canonicalJson(lease.authority) === canonicalJson({ persistent_source: 'controller-leases.json', schema_version: 'ao.controller-lease-authority.v1', single_writer_lock: 'controller-leases.lock', accepted_repair_pr: 81, accepted_safety_pr: 82 }), 'Lease authority contract drifted');
  assert(canonicalJson(lease.projection) === canonicalJson({ path: 'snapshot.state.controller_leases', persistent: false, source: 'validated_canonical_authority_only' }), 'Lease projection contract drifted');
  assert(canonicalJson(lease.failure_policy) === canonicalJson({ missing_or_invalid_canonical: 'fail_closed', shadow_fallback: 'prohibited', automatic_destructive_recovery: 'prohibited', explicit_recovery: 'stop_the_world_with_separate_authority' }), 'Lease failure policy drifted');
  const receipt = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/foundation/controller-lease-safety-verification.v1.json'), 'utf8'));
  assert(canonicalJson(lease.replay) === canonicalJson({
    fixture_count: receipt.fixture_count,
    replay_count: receipt.replay_count,
    case_execution_count: receipt.case_execution_count,
    fixture_digest: receipt.fixture_pack_digest,
    stable_run_digest: receipt.stable_run_digest,
    receipt_digest: receipt.receipt_digest,
  }), 'Lease replay evidence drifted from canonical safety receipt');
  assert(lease.status === 'accepted', 'Lease authority report not accepted');
}

function validateRisks(risks, excludedScope) {
  validateReport(risks, 'ao.phase-zero-remaining-risk-register.v1', ['status', 'accepted_residual_risks', 'audit_history', 'scope_statement'], 'risk register');
  assert(risks.status === 'accepted_with_residual_risk', 'Risk register status is not truthful');
  assert(risks.accepted_residual_risks.length === 4, 'Accepted residual-risk set drifted');
  for (const [index, risk] of risks.accepted_residual_risks.entries()) {
    exactKeys(risk, ['id', 'severity', 'status', 'risk', 'control'], `accepted residual risk ${index}`);
    assert(['low', 'medium', 'high'].includes(risk.severity) && risk.status === 'accepted', `accepted residual risk ${index} invalid`);
    nonEmpty(risk.risk, `accepted residual risk ${index}.risk`);
    nonEmpty(risk.control, `accepted residual risk ${index}.control`);
  }
  for (const [index, event] of risks.audit_history.entries()) {
    exactKeys(event, ['id', 'status', 'event_ref', 'risk', 'correction', 'repository_contamination'], `audit history ${index}`);
    assert(event.repository_contamination === false, 'Discarded work was misclassified as repository contamination');
  }
  assert(risks.scope_statement.discarded_uncommitted_files === 'aborted_worker_local_only_and_not_repository_evidence', 'Discarded-work classification drifted');
  assert(canonicalJson(risks.scope_statement.excluded) === canonicalJson(excludedScope), 'Risk excluded scope contradicts manifest');
  assert(stableDigest(risks) === FROZEN_RISK_DIGEST, 'Complete remaining-risk register drifted');
}

export function validatePhaseZeroEvidence(bundle, { repositoryRoot }) {
  const { manifest, trajectory, lease, boundary, risks, fixtures } = bundle;
  exactKeys(manifest, ['schema_version', 'status', 'repository', 'admission', 'foundations', 'integrated_assertions', 'artifacts', 'handoff_binding'], 'manifest');
  assert(manifest.schema_version === PHASE_ZERO_MANIFEST_VERSION, 'Unsupported Phase 0 manifest schema');
  assert(manifest.status === 'accepted_for_no_merge_handoff', 'Manifest status must remain no-merge');
  assert(canonicalJson(manifest.repository) === canonicalJson({ slug: 'Samsen879/ao-pilot', base_sha: 'b2bd4a68ad84758eb5c7c7bb19932d897f6605a8', base_tree: 'ea50c914949c44a8832c538eae412e0caba01121' }), 'Repository admission identity drifted');
  assert(canonicalJson(manifest.admission) === canonicalJson(FROZEN_ADMISSION), 'Authoritative admission identity drifted');
  assert(canonicalJson(manifest.handoff_binding) === canonicalJson({ strategy: 'runtime_git_identity_plus_provider_exact_head', repository_self_commit_field: 'prohibited_as_self_referential', merge_claim: false }), 'Handoff binding strategy drifted');

  assert(Array.isArray(manifest.foundations), 'Foundations must be an array');
  assert(manifest.foundations.map((entry) => entry.id).join(',') === REQUIRED_FOUNDATIONS.join(','), 'F01-F11 coverage/order drifted');
  let previousMerge = null;
  for (const foundation of manifest.foundations) {
    exactKeys(foundation, ['id', 'issue', 'title', 'deliveries', 'terminal_closeout_ref'], `foundation ${foundation.id}`);
    assert(Array.isArray(foundation.deliveries) && foundation.deliveries.length === (foundation.id === 'F11' ? 2 : 1), `${foundation.id} delivery chain invalid`);
    foundation.deliveries.forEach((delivery, index) => validateDelivery(delivery, `${foundation.id}.deliveries[${index}]`));
    for (const delivery of foundation.deliveries) {
      if (previousMerge !== null) assert(delivery.base_sha === previousMerge, `${foundation.id} chain base does not equal prior merge`);
      previousMerge = delivery.merge_sha;
    }
    assert(foundation.terminal_closeout_ref === foundation.deliveries.at(-1).closeout_ref, `${foundation.id} terminal closeout mismatch`);
    assert(foundation.deliveries.at(-1).closeout_status === 'accepted', `${foundation.id} terminal closeout is not accepted`);
  }
  assert(stableDigest(manifest.foundations) === FROZEN_FOUNDATION_DIGEST, 'Immutable F01-F11 delivery identities drifted');
  assert(manifest.foundations.at(-1).deliveries[0].closeout_status === 'superseded', 'F11 original closeout must remain superseded');
  assert(previousMerge === manifest.repository.base_sha, 'Foundation chain does not terminate at admitted base');

  exactKeys(manifest.integrated_assertions, ['false_success_paths', 'completion_record', 'p0_c_authority', 'judgment_effect_boundary', 'behavior_coverage', 'excluded_scope'], 'manifest.integrated_assertions');
  assert(manifest.integrated_assertions.false_success_paths === 'no_unresolved_promotion_path', 'False-success assertion missing');
  assert(manifest.integrated_assertions.completion_record === 'v1alpha1_schema_and_40_field_coverage_frozen', 'Completion Record freeze missing');
  assert(manifest.integrated_assertions.p0_c_authority === 'accepted_single_canonical_lease_authority', 'P0-C authority acceptance missing');
  assert(manifest.integrated_assertions.judgment_effect_boundary === 'ao.release-judgment.v1_to_or_effect_to_github_outcome', 'Judgment/effect acceptance missing');
  assert(canonicalJson(manifest.integrated_assertions.behavior_coverage) === canonicalJson(REQUIRED_SCENARIOS), 'Behavior coverage drifted');
  assert(canonicalJson(manifest.integrated_assertions.excluded_scope) === canonicalJson(EXCLUDED_SCOPE), 'Excluded scope drifted');

  validateTrajectoryReport(trajectory, repositoryRoot);
  validateLeaseReport(lease, repositoryRoot);
  validateReport(boundary, 'ao.judgment-or-effect-contract-freeze.v1', ['status', 'version', 'stages', 'claims', 'failure_policy', 'corrective_live_replay_fingerprints'], 'boundary report');
  assert(stableDigest(boundary) === FROZEN_BOUNDARY_DIGEST, 'Complete AO/OR authority contract drifted');
  assert(boundary.status === 'accepted' && boundary.version === '1.0.0', 'Judgment/effect boundary not accepted');
  assert(boundary.claims.ao_merges === false && boundary.claims.or_effect_proves_outcome === false && boundary.claims.github_merged_is_outcome_authority === true && boundary.claims.legacy_auto_merge_executor_removed === true && boundary.claims.routine_human_approval_required === false, 'Boundary claims drifted');
  assert(boundary.failure_policy.unknown_effect_replay === 'prohibited', 'Unknown effect replay is not prohibited');
  assert(Object.values(boundary.corrective_live_replay_fingerprints).every((digest) => SHA256.test(digest)), 'Corrective live replay fingerprint invalid');
  validateRisks(risks, manifest.integrated_assertions.excluded_scope);

  exactKeys(fixtures, ['schema_version', 'required_replays', 'scenarios'], 'fixture pack');
  assert(fixtures.schema_version === 'ao.phase-zero-exit-fixture-pack.v1' && fixtures.required_replays === 2, 'Fixture replay contract invalid');
  assert(canonicalJson(fixtures.scenarios) === canonicalJson(EXPECTED_SCENARIOS), 'Fixture scenario semantics drifted');

  exactKeys(manifest.artifacts, Object.keys(ARTIFACT_BINDINGS), 'manifest.artifacts');
  for (const [id, expectedPath] of Object.entries(ARTIFACT_BINDINGS)) {
    const artifact = manifest.artifacts[id];
    exactKeys(artifact, ['path', 'sha256'], `manifest.artifacts.${id}`);
    assert(artifact.path === expectedPath, `Artifact ${id} is not bound to its canonical path`);
    assert(SHA256.test(artifact.sha256), `Invalid artifact digest: ${id}`);
    const bytes = fs.readFileSync(path.join(repositoryRoot, artifact.path));
    assert(crypto.createHash('sha256').update(bytes).digest('hex') === artifact.sha256, `Artifact digest mismatch: ${id}`);
    assert(stableDigest(JSON.parse(bytes)) === stableDigest(bundle[BUNDLE_KEYS_BY_ARTIFACT[id]]), `Artifact ${id} does not match validated bundle object`);
  }
  return true;
}

function scenarioResult(scenario, bundle, repositoryRoot, bundleDigest) {
  const candidate = structuredClone(bundle);
  if (scenario.mutation === 'ao_merge_claim') candidate.boundary.claims.ao_merges = true;
  if (scenario.mutation === 'artifact_digest_missing') candidate.manifest.artifacts.trajectory_report.sha256 = '0'.repeat(64);
  let disposition = 'accepted';
  try {
    validatePhaseZeroEvidence(candidate, { repositoryRoot });
  } catch {
    disposition = 'blocked';
  }
  assert(disposition === scenario.expected, `Scenario ${scenario.id} did not enforce ${scenario.expected}`);
  return { id: scenario.id, class: scenario.class, disposition, evidence_bundle_digest: bundleDigest };
}

export function replayPhaseZeroEvidence(bundle, { repositoryRoot, replayCount } = {}) {
  const required = replayCount ?? bundle.fixtures.required_replays;
  assert(required >= 2, 'Phase 0 evidence requires at least two replays');
  validatePhaseZeroEvidence(bundle, { repositoryRoot });
  const bundleDigest = stableDigest(bundle);
  const runs = Array.from({ length: required }, () => {
    const results = bundle.fixtures.scenarios.map((scenario) => scenarioResult(scenario, bundle, repositoryRoot, bundleDigest));
    return { results, digest: stableDigest(results) };
  });
  assert(runs.every((run) => run.digest === runs[0].digest), 'Phase 0 fixture replay drifted');
  const core = {
    schema_version: PHASE_ZERO_REPLAY_VERSION,
    status: 'passed',
    manifest_digest: stableDigest(bundle.manifest),
    evidence_bundle_digest: bundleDigest,
    scenario_count: bundle.fixtures.scenarios.length,
    replay_count: required,
    stable_run_digest: runs[0].digest,
    run_digests: runs.map((run) => run.digest),
    behavior_coverage: bundle.fixtures.scenarios.map((scenario) => scenario.class),
  };
  return { runs, receipt: { ...core, receipt_digest: stableDigest(core) } };
}

export function readGitIdentity(repositoryRoot) {
  const read = (args) => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const identity = { head_sha: read(['rev-parse', 'HEAD']), tree_sha: read(['rev-parse', 'HEAD^{tree}']) };
  assert(SHA.test(identity.head_sha) && SHA.test(identity.tree_sha), 'Live Git identity invalid');
  return identity;
}

export function loadPhaseZeroEvidence(repositoryRoot) {
  const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
  return {
    manifest: read('docs/foundation/phase-zero-exit-manifest.v1.json'),
    trajectory: read('docs/foundation/trajectory-truthfulness-report.v1.json'),
    lease: read('docs/foundation/controller-lease-single-authority-report.v1.json'),
    boundary: read('docs/foundation/judgment-or-effect-contract-freeze.v1.json'),
    risks: read('docs/foundation/phase-zero-remaining-risk-register.v1.json'),
    fixtures: read('tests/ao/fixtures/phase-zero-exit/pack.v1.json'),
  };
}
