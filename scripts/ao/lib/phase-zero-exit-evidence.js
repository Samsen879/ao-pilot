import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PHASE_ZERO_MANIFEST_VERSION = 'ao.phase-zero-exit-manifest.v1';
export const PHASE_ZERO_REPLAY_VERSION = 'ao.phase-zero-exit-replay-receipt.v1';

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_FOUNDATIONS = Array.from({ length: 11 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`);
const REQUIRED_SCENARIOS = ['success', 'failure', 'missing_evidence', 'replay'];

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
  for (const field of ['base_sha', 'governed_head_sha', 'merge_sha', 'tree_sha']) {
    assert(SHA.test(delivery[field]), `${label}.${field} invalid`);
  }
  exactKeys(delivery.ci, ['run_id', 'head_sha', 'status', 'required_jobs'], `${label}.ci`);
  assert(Number.isInteger(delivery.ci.run_id) && delivery.ci.run_id > 0, `${label}.ci.run_id invalid`);
  assert(delivery.ci.head_sha === delivery.merge_sha, `${label}.ci is not bound to merge SHA`);
  assert(delivery.ci.status === 'success', `${label}.ci is not successful`);
  assert(JSON.stringify(delivery.ci.required_jobs) === JSON.stringify(['fresh-clone-runtime', 'test (20)', 'test (22)']), `${label}.ci required jobs drifted`);
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

export function validatePhaseZeroEvidence(bundle, { repositoryRoot }) {
  const { manifest, trajectory, lease, boundary, risks, fixtures } = bundle;
  exactKeys(manifest, ['schema_version', 'status', 'repository', 'admission', 'foundations', 'integrated_assertions', 'artifacts'], 'manifest');
  assert(manifest.schema_version === PHASE_ZERO_MANIFEST_VERSION, 'Unsupported Phase 0 manifest schema');
  assert(manifest.status === 'accepted_for_no_merge_handoff', 'Manifest status must remain no-merge');
  exactKeys(manifest.repository, ['slug', 'base_sha', 'base_tree'], 'manifest.repository');
  assert(manifest.repository.slug === 'Samsen879/ao-pilot', 'Repository slug drifted');
  assert(manifest.repository.base_sha === 'b2bd4a68ad84758eb5c7c7bb19932d897f6605a8', 'Admitted base SHA drifted');
  assert(manifest.repository.base_tree === 'ea50c914949c44a8832c538eae412e0caba01121', 'Admitted base tree drifted');
  exactKeys(manifest.admission, ['lane_issue', 'foundation_issue', 'corrected_lane_transition_ref', 'readmission_ref', 'revoked_admission_ref', 'revocation_ref'], 'manifest.admission');
  assert(manifest.admission.corrected_lane_transition_ref.endsWith('5232956289'), 'Corrected lane transition missing');
  assert(manifest.admission.readmission_ref.endsWith('5232956646'), 'Corrected admission missing');
  assert(manifest.admission.revoked_admission_ref.endsWith('5232637735'), 'Revoked admission audit ref missing');
  assert(manifest.admission.revocation_ref.endsWith('5232683454'), 'Revocation audit ref missing');

  assert(Array.isArray(manifest.foundations), 'Foundations must be an array');
  assert(JSON.stringify(manifest.foundations.map((entry) => entry.id)) === JSON.stringify(REQUIRED_FOUNDATIONS), 'F01-F11 coverage/order drifted');
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
  assert(manifest.foundations.at(-1).deliveries[0].closeout_status === 'superseded', 'F11 original closeout must remain superseded');
  assert(previousMerge === manifest.repository.base_sha, 'Foundation chain does not terminate at admitted base');

  exactKeys(manifest.integrated_assertions, ['false_success_paths', 'completion_record', 'p0_c_authority', 'judgment_effect_boundary', 'behavior_coverage', 'excluded_scope'], 'manifest.integrated_assertions');
  assert(manifest.integrated_assertions.false_success_paths === 'no_unresolved_promotion_path', 'False-success assertion missing');
  assert(manifest.integrated_assertions.completion_record === 'v1alpha1_schema_and_40_field_coverage_frozen', 'Completion Record freeze missing');
  assert(manifest.integrated_assertions.p0_c_authority === 'accepted_single_canonical_lease_authority', 'P0-C authority acceptance missing');
  assert(manifest.integrated_assertions.judgment_effect_boundary === 'ao.release-judgment.v1_to_or_effect_to_github_outcome', 'Judgment/effect acceptance missing');
  assert(JSON.stringify(manifest.integrated_assertions.behavior_coverage) === JSON.stringify(REQUIRED_SCENARIOS), 'Behavior coverage drifted');
  assert(JSON.stringify(manifest.integrated_assertions.excluded_scope) === JSON.stringify(['episode_record_storage', 'multi_workstream_implementation', 'knowledge_track_promotion']), 'Excluded scope drifted');

  validateReport(trajectory, 'ao.trajectory-truthfulness-report.v1', ['status', 'source_contracts', 'vocabulary_digest', 'false_success', 'completion_record', 'behavior_coverage'], 'trajectory report');
  assert(trajectory.status === 'accepted' && trajectory.false_success.unresolved_promotion_path_count === 0, 'Trajectory truthfulness not accepted');
  assert(trajectory.false_success.blocking_fixture_count > 0, 'False-success negative coverage missing');
  assert(trajectory.completion_record.schema_version === 'ao.child-completion.v1alpha1', 'Completion Record schema not frozen');
  assert(trajectory.completion_record.candidate_field_count === 40, 'Completion Record field coverage drifted');
  assert(JSON.stringify(trajectory.behavior_coverage) === JSON.stringify(REQUIRED_SCENARIOS), 'Trajectory behavior coverage drifted');

  validateReport(lease, 'ao.controller-lease-single-authority-report.v1', ['status', 'authority', 'projection', 'failure_policy', 'replay'], 'lease report');
  assert(lease.status === 'accepted', 'Lease authority report not accepted');
  assert(lease.authority.persistent_source === 'controller-leases.json', 'Canonical lease source drifted');
  assert(lease.projection.path === 'snapshot.state.controller_leases' && lease.projection.persistent === false, 'Lease projection became authoritative');
  assert(lease.failure_policy.shadow_fallback === 'prohibited', 'Lease shadow fallback is not prohibited');
  assert(lease.replay.fixture_count === 18 && lease.replay.replay_count === 2, 'Lease replay coverage drifted');

  validateReport(boundary, 'ao.judgment-or-effect-contract-freeze.v1', ['status', 'version', 'stages', 'claims', 'failure_policy', 'corrective_live_replay_fingerprints'], 'boundary report');
  assert(boundary.status === 'accepted' && boundary.version === '1.0.0', 'Judgment/effect boundary not accepted');
  assert(JSON.stringify(boundary.stages.map((stage) => stage.owner)) === JSON.stringify(['AO', 'OR', 'GitHub']), 'Boundary ownership drifted');
  assert(boundary.claims.ao_merges === false && boundary.claims.or_effect_proves_outcome === false && boundary.claims.github_merged_is_outcome_authority === true, 'Boundary claims drifted');
  assert(boundary.failure_policy.missing_provider_observation === 'blocked_unknown_outcome', 'Missing provider evidence must fail closed');
  assert(Object.keys(boundary.corrective_live_replay_fingerprints).join(',') === 'pr_86,pr_87', 'Corrective live replay coverage drifted');
  assert(Object.values(boundary.corrective_live_replay_fingerprints).every((digest) => SHA256.test(digest)), 'Corrective live replay fingerprint invalid');

  validateReport(risks, 'ao.phase-zero-remaining-risk-register.v1', ['status', 'accepted_residual_risks', 'audit_history', 'scope_statement'], 'risk register');
  assert(risks.status === 'accepted_with_residual_risk', 'Risk register status is not truthful');
  const auditIds = risks.audit_history.map((entry) => entry.id);
  assert(auditIds.includes('foundation-22-aborted-replay-scope-drift'), 'Aborted #22 scope drift missing');
  assert(auditIds.includes('foundation-22-invalid-closeout-revocation-corrective-chain'), 'Invalid closeout/corrective history missing');
  assert(risks.audit_history.every((entry) => entry.repository_contamination === false), 'Discarded work was misclassified as repository contamination');
  assert(risks.accepted_residual_risks.length > 0, 'Accepted residual risks missing');

  exactKeys(fixtures, ['schema_version', 'required_replays', 'scenarios'], 'fixture pack');
  assert(fixtures.schema_version === 'ao.phase-zero-exit-fixture-pack.v1', 'Fixture schema invalid');
  assert(fixtures.required_replays === 2, 'Fixture replay count must be two');
  assert(JSON.stringify(fixtures.scenarios.map((entry) => entry.class)) === JSON.stringify(REQUIRED_SCENARIOS), 'Fixture scenario classes drifted');

  exactKeys(manifest.artifacts, ['trajectory_report', 'lease_report', 'boundary_freeze', 'risk_register', 'fixture_pack'], 'manifest.artifacts');
  for (const [id, artifact] of Object.entries(manifest.artifacts)) {
    exactKeys(artifact, ['path', 'sha256'], `manifest.artifacts.${id}`);
    assert(!path.isAbsolute(artifact.path) && !artifact.path.split(/[\\/]/).includes('..'), `Unbounded artifact path: ${artifact.path}`);
    assert(SHA256.test(artifact.sha256), `Invalid artifact digest: ${id}`);
    const bytes = fs.readFileSync(path.join(repositoryRoot, artifact.path));
    assert(crypto.createHash('sha256').update(bytes).digest('hex') === artifact.sha256, `Artifact digest mismatch: ${id}`);
  }
  return true;
}

function scenarioResult(scenario, bundleDigest) {
  exactKeys(scenario, ['id', 'class', 'input', 'expected'], `scenario ${scenario.id}`);
  const hasEvidence = scenario.input.manifest_present === true
    && scenario.input.artifacts_verified === true
    && scenario.input.contracts_accepted === true;
  const actual = hasEvidence ? 'accepted' : 'blocked';
  assert(actual === scenario.expected, `Scenario ${scenario.id} did not fail closed`);
  return { id: scenario.id, class: scenario.class, disposition: actual, evidence_bundle_digest: bundleDigest };
}

export function replayPhaseZeroEvidence(bundle, { repositoryRoot, replayCount } = {}) {
  const required = replayCount ?? bundle.fixtures.required_replays;
  assert(required >= 2, 'Phase 0 evidence requires at least two replays');
  validatePhaseZeroEvidence(bundle, { repositoryRoot });
  const bundleDigest = stableDigest(bundle);
  const runs = Array.from({ length: required }, () => {
    const results = bundle.fixtures.scenarios.map((scenario) => scenarioResult(structuredClone(scenario), bundleDigest));
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
