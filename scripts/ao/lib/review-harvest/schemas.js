const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const CLASSIFICATIONS = new Set(['blocking', 'non_blocking', 'unknown']);
const STATUSES = new Set(['unresolved', 'resolved', 'superseded', 'rejected']);
export const FIRST_DETECTABLE_STAGES = Object.freeze([
  'task_intake',
  'worker_implementation',
  'worker_preflight',
  'ci',
  'independent_review',
  'integration',
  'post_merge',
  'not_established',
]);
const STAGES = new Set(FIRST_DETECTABLE_STAGES);

function assert(condition, message) {
  if (!condition) throw new Error(`Schema validation failed: ${message}`);
}
function assertString(value, name, { nullable = false } = {}) {
  if (nullable && value == null) return;
  assert(typeof value === 'string' && value.length > 0, `${name} must be a non-empty string`);
}

function assertArray(value, name) {
  assert(Array.isArray(value), `${name} must be an array`);
}

export function validateSnapshotManifest(value) {
  assert(value?.schema_version === 'ao.github-review-snapshot-manifest.v1alpha1', 'snapshot schema_version');
  assertString(value?.target_repository_identity?.full_name, 'target_repository_identity.full_name');
  assert(Number.isInteger(value?.target_repository_identity?.repository_id)
    && value.target_repository_identity.repository_id > 0, 'target repository id');
  assertString(value?.selector?.merged_at_gte, 'selector.merged_at_gte');
  assertString(value?.selector?.merged_at_lt, 'selector.merged_at_lt');
  assertArray(value?.exact_pr_numbers, 'exact_pr_numbers');
  assert(value.exact_pr_numbers.every((number, index) => Number.isInteger(number)
    && number > 0
    && (index === 0 || value.exact_pr_numbers[index - 1] < number)), 'exact_pr_numbers are unique and sorted');
  assert(value.enumerated_pr_count === value.exact_pr_numbers.length, 'enumerated count matches PR list');
  assertArray(value?.endpoint_pages, 'endpoint_pages');
  assertArray(value?.pull_requests, 'pull_requests');
  assert(value.pull_requests.length === value.enumerated_pr_count, 'pull request refs match enumerated count');
  assert(value.pull_requests.every((pr, index) => pr?.pr_number === value.exact_pr_numbers[index]), 'pull request refs match exact PR list');
  assertString(value?.harvester_version, 'harvester_version');
  for (const page of value.endpoint_pages) {
    assertString(page.request_id, 'endpoint page request_id');
    assertString(page.endpoint, 'endpoint page endpoint');
    assert(SHA256_PATTERN.test(page.body_sha256 ?? ''), 'endpoint page body_sha256');
    assertString(page.raw_path, 'endpoint page raw_path');
    assert(!pathIsUnsafe(page.raw_path), 'endpoint page raw_path must stay within the manifest directory');
  }
  for (const pr of value.pull_requests) {
    assert(Number.isInteger(pr.pr_number), 'pull request number');
    assert(SHA_PATTERN.test(pr.head_sha ?? ''), 'pull request head_sha');
    assert(pr.merge_commit_sha == null || SHA_PATTERN.test(pr.merge_commit_sha), 'pull request merge_commit_sha');
  }
  return value;
}

export function validateBlockRecord(value) {
  assert(value?.schema_version === 'ao.independent-review-block.v1alpha1', 'block schema_version');
  for (const field of ['block_id', 'repository', 'reviewer_actor_ref', 'review_role_basis', 'review_ref', 'review_round_id', 'reviewed_head_sha', 'blocking_basis', 'severity', 'category', 'summary', 'observed_stage', 'first_detectable_stage', 'finding_fingerprint', 'status']) {
    assertString(value?.[field], `block.${field}`);
  }
  assert(Number.isInteger(value?.pr_number), 'block.pr_number');
  assertArray(value?.comment_refs, 'block.comment_refs');
  assertArray(value?.evidence_refs, 'block.evidence_refs');
  assert(CLASSIFICATIONS.has(value.classification), 'block.classification');
  assert(STATUSES.has(value.status), 'block.status');
  assert(STAGES.has(value.observed_stage), 'block.observed_stage');
  assert(STAGES.has(value.first_detectable_stage), 'block.first_detectable_stage');
  assert(SHA_PATTERN.test(value.reviewed_head_sha), 'block.reviewed_head_sha');
  assert(SHA256_PATTERN.test(value.finding_fingerprint), 'block.finding_fingerprint');
  if (value.status === 'resolved') {
    assert(SHA_PATTERN.test(value.correction_head_sha ?? ''), 'resolved block correction_head_sha');
    assertString(value.resolution_review_ref, 'resolved block resolution_review_ref');
    assert(value.resolution_verdict === 'PASS', 'resolved block resolution_verdict');
  }
  return value;
}

export function validateBlockInventory(value) {
  assert(value?.schema_version === 'ao.independent-review-block-inventory.v1alpha1', 'inventory schema_version');
  assertString(value?.source_snapshot_manifest_ref?.path, 'inventory source manifest path');
  assert(SHA256_PATTERN.test(value?.source_snapshot_manifest_ref?.sha256 ?? ''), 'inventory source manifest sha256');
  assertArray(value?.blockers, 'inventory blockers');
  assert(value.blocker_count === value.blockers.length, 'inventory blocker_count');
  assert(Number.isInteger(value.unknown_classification_count), 'inventory unknown count');
  assert(Number.isInteger(value.episode_count), 'inventory episode count');
  assert(Number.isInteger(value.recurring_pattern_count), 'inventory recurring pattern count');
  assert(value.first_detectable_stage_counts && typeof value.first_detectable_stage_counts === 'object', 'inventory stage counts');
  assert(value.source_coverage && typeof value.source_coverage === 'object', 'inventory source coverage');
  assert(value.protocol_marker_coverage && typeof value.protocol_marker_coverage === 'object', 'inventory protocol coverage');
  assert(value.head_binding_coverage && typeof value.head_binding_coverage === 'object', 'inventory head coverage');
  assert(Number.isInteger(value.unbound_conversation_review_evidence_count), 'inventory unbound conversation evidence count');
  assertArray(value.unbound_conversation_review_evidence, 'inventory unbound conversation evidence');
  assert(value.unbound_conversation_review_evidence_count === value.unbound_conversation_review_evidence.length, 'inventory unbound conversation evidence count matches records');
  for (const evidence of value.unbound_conversation_review_evidence) {
    assert(evidence?.record_type === 'unbound_conversation_review_evidence', 'unbound conversation evidence record_type');
    for (const field of ['evidence_protocol_version', 'repository', 'comment_ref', 'preservation_basis']) {
      assertString(evidence?.[field], `unbound conversation evidence ${field}`);
    }
    assert(Number.isInteger(evidence?.pr_number), 'unbound conversation evidence pr_number');
    assert(['BLOCKED', 'PASS'].includes(evidence?.verdict), 'unbound conversation evidence verdict');
    assert(evidence?.classification === 'unknown', 'unbound conversation evidence classification');
    assert(evidence?.head_binding === 'not_established', 'unbound conversation evidence head binding');
    assert(SHA_PATTERN.test(evidence?.declared_head_sha ?? ''), 'unbound conversation evidence declared head');
    assert(evidence?.github_commit_id == null, 'unbound conversation evidence github commit id');
    assert(SHA256_PATTERN.test(evidence?.body_sha256 ?? ''), 'unbound conversation evidence body_sha256');
  }
  value.blockers.forEach(validateBlockRecord);
  return value;
}

function pathIsUnsafe(value) {
  const normalized = String(value).replace(/\\/g, '/');
  return normalized.startsWith('/') || normalized.split('/').includes('..');
}

export function validateReviewRoundBaseline(value) {
  assert(value?.schema_version === 'ao.review-round-baseline.v1alpha1', 'baseline schema_version');
  assertString(value?.source_snapshot_manifest_ref?.path, 'baseline source manifest path');
  assert(SHA256_PATTERN.test(value?.source_snapshot_manifest_ref?.sha256 ?? ''), 'baseline source manifest sha256');
  assertArray(value?.per_pr_rounds, 'baseline per_pr_rounds');
  for (const name of ['review_round_distribution', 'blocking_round_distribution', 'correction_round_distribution', 'blockers_per_blocking_round']) {
    assert(value?.[name] && typeof value[name] === 'object', `baseline ${name}`);
  }
  assert(value?.first_pass_independent_review_rate && typeof value.first_pass_independent_review_rate === 'object', 'baseline first pass rate');
  assert(value?.head_binding_coverage && typeof value.head_binding_coverage === 'object', 'baseline head coverage');
  return value;
}

export function validateArtifacts({ manifest, inventory, baseline }) {
  validateSnapshotManifest(manifest);
  validateBlockInventory(inventory);
  validateReviewRoundBaseline(baseline);
  return true;
}
