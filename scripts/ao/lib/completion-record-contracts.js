import { createHash } from 'node:crypto';
import path from 'node:path';

export const COMPLETION_RECORD_SCHEMA_VERSION = 'ao.child-completion.v1alpha1';
export const COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION =
  'ao.child-completion-input-manifest.v1alpha1';
export const COMPLETION_DELIVERY_STATUSES = ['review_passed', 'integrated', 'abandoned'];

const COMPLETION_RECORD_REQUIRED_KEYS = [
  'schema_version',
  'record_id',
  'child_task_id',
  'delivery_status',
  'generator_ref',
  'generation_inputs',
  'generation_inputs_digest',
  'artifact',
  'unresolved_items',
];
const COMPLETION_RECORD_OPTIONAL_KEYS = [
  'parent_task_refs',
  'issue_number',
  'pr_number',
  'base_sha',
  'head_sha',
  'merge_sha',
  'generated_at',
  'task_spec_ref',
  'autonomy_policy_ref',
  'or_authorization_grant_ref',
  'release_judgment_ref',
  'evidence_refs',
  'verification_refs',
  'review_refs',
  'escalation_refs',
  'merge_observation_ref',
  'important_decisions',
  'review_round_summary',
];
const SHA256 = /^[0-9a-f]{64}$/;
const SHA256_REF = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, field) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value),
    `${field} must be an object`);
  return value;
}

function exactKeys(value, field, required, optional = []) {
  const item = object(value, field);
  const actual = Object.keys(item);
  const allowed = new Set([...required, ...optional]);
  for (const key of actual) assert(allowed.has(key), `Unsupported ${field}.${key}`);
  for (const key of required) assert(Object.hasOwn(item, key), `Missing ${field}.${key}`);
  return item;
}

function requiredString(value, field) {
  assert(typeof value === 'string' && value.trim() !== '', `${field} is required`);
  return value.trim();
}

function immutableRef(value, field) {
  const normalized = requiredString(value, field);
  assert(!/\s/.test(normalized), `${field} must be an immutable reference without whitespace`);
  return normalized;
}

function repositoryUri(value, field) {
  const normalized = immutableRef(value, field).replaceAll('\\', '/');
  assert(!normalized.startsWith('/'), `${field} must be repository-relative`);
  const canonical = path.posix.normalize(normalized);
  assert(canonical !== '..' && !canonical.startsWith('../'), `${field} escapes the repository`);
  assert(canonical === normalized, `${field} must be normalized`);
  return canonical;
}

function digest(value, field) {
  const normalized = requiredString(value, field);
  assert(SHA256.test(normalized), `${field} must be a lowercase SHA-256 digest`);
  return normalized;
}

function gitSha(value, field) {
  const normalized = requiredString(value, field);
  assert(GIT_SHA.test(normalized), `${field} must be a 40-character lowercase git SHA`);
  return normalized;
}

function positiveInteger(value, field) {
  assert(Number.isInteger(value) && value > 0, `${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, field) {
  assert(Number.isInteger(value) && value >= 0, `${field} must be a non-negative integer`);
  return value;
}

function sortedUniqueStrings(values, field, normalizer = immutableRef, { allowEmpty = false } = {}) {
  assert(Array.isArray(values), `${field} must be an array`);
  assert(allowEmpty || values.length > 0, `${field} requires evidence`);
  const normalized = values.map((value, index) => normalizer(value, `${field}[${index}]`));
  assert(new Set(normalized).size === normalized.length, `${field} contains duplicate values`);
  return normalized.sort((left, right) => left.localeCompare(right));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonicalValue(value[key])]));
  }
  assert(value !== undefined && (typeof value !== 'number' || Number.isFinite(value)),
    'Canonical JSON cannot contain undefined or non-finite numbers');
  return value;
}

export function canonicalCompletionJson(value) {
  return `${JSON.stringify(canonicalValue(value), null, 2)}\n`;
}

export function completionSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function completionRecordId(childTaskId) {
  const normalized = requiredString(childTaskId, 'child_task_id');
  return `sha256:${completionSha256(Buffer.from(
    `${COMPLETION_RECORD_SCHEMA_VERSION}\0${normalized}`,
    'utf8',
  ))}`;
}

export function normalizeCompletionInputManifest(manifest) {
  const value = exactKeys(manifest, 'input_manifest',
    ['schema_version', 'child_task_id', 'inputs']);
  assert(value.schema_version === COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION,
    `Unsupported input manifest schema: ${String(value.schema_version)}`);
  const childTaskId = requiredString(value.child_task_id, 'input_manifest.child_task_id');
  assert(Array.isArray(value.inputs) && value.inputs.length > 0,
    'input_manifest.inputs requires at least one input');
  const inputs = value.inputs.map((entry, index) => {
    const field = `input_manifest.inputs[${index}]`;
    const input = exactKeys(entry, field,
      ['input_id', 'schema_version', 'uri', 'content_sha256']);
    return {
      input_id: immutableRef(input.input_id, `${field}.input_id`),
      schema_version: immutableRef(input.schema_version, `${field}.schema_version`),
      uri: repositoryUri(input.uri, `${field}.uri`),
      content_sha256: digest(input.content_sha256, `${field}.content_sha256`),
    };
  }).sort((left, right) => (
    left.input_id.localeCompare(right.input_id)
      || left.uri.localeCompare(right.uri)
      || left.schema_version.localeCompare(right.schema_version)
      || left.content_sha256.localeCompare(right.content_sha256)
  ));
  const inputIds = inputs.map((input) => input.input_id);
  assert(new Set(inputIds).size === inputIds.length,
    'input_manifest.inputs contains duplicate input_id values');
  return {
    schema_version: COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION,
    child_task_id: childTaskId,
    inputs,
  };
}

export function canonicalCompletionInputManifest(manifest) {
  return canonicalCompletionJson(normalizeCompletionInputManifest(manifest));
}

export function completionInputManifestDigest(manifest) {
  return completionSha256(Buffer.from(canonicalCompletionInputManifest(manifest), 'utf8'));
}

export function generationInputsDigest(manifest) {
  const normalized = normalizeCompletionInputManifest(manifest);
  return completionSha256(Buffer.from(canonicalCompletionJson({
    child_task_id: normalized.child_task_id,
    inputs: normalized.inputs,
  }), 'utf8'));
}

function normalizeUnresolvedItems(items) {
  assert(Array.isArray(items), 'completion_record.unresolved_items must be an array');
  const normalized = items.map((entry, index) => {
    const field = `completion_record.unresolved_items[${index}]`;
    const item = exactKeys(entry, field, ['id', 'summary', 'evidence_refs']);
    return {
      id: requiredString(item.id, `${field}.id`),
      summary: requiredString(item.summary, `${field}.summary`),
      evidence_refs: sortedUniqueStrings(item.evidence_refs, `${field}.evidence_refs`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assert(new Set(normalized.map((item) => item.id)).size === normalized.length,
    'completion_record.unresolved_items contains duplicate ids');
  return normalized;
}

function normalizeDecisions(decisions) {
  assert(Array.isArray(decisions), 'completion_record.important_decisions must be an array');
  const normalized = decisions.map((entry, index) => {
    const field = `completion_record.important_decisions[${index}]`;
    const decision = exactKeys(entry, field, ['id', 'choice', 'reason', 'evidence_ref']);
    return {
      id: requiredString(decision.id, `${field}.id`),
      choice: requiredString(decision.choice, `${field}.choice`),
      reason: requiredString(decision.reason, `${field}.reason`),
      evidence_ref: immutableRef(decision.evidence_ref, `${field}.evidence_ref`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  assert(new Set(normalized.map((item) => item.id)).size === normalized.length,
    'completion_record.important_decisions contains duplicate ids');
  return normalized;
}

function normalizeReviewRoundSummary(summary) {
  const value = exactKeys(summary, 'completion_record.review_round_summary', [
    'review_round_count',
    'blocking_round_count',
    'correction_round_count',
    'blocker_count',
    'first_pass',
    'head_binding_coverage',
  ]);
  const normalized = {
    review_round_count: nonNegativeInteger(value.review_round_count,
      'completion_record.review_round_summary.review_round_count'),
    blocking_round_count: nonNegativeInteger(value.blocking_round_count,
      'completion_record.review_round_summary.blocking_round_count'),
    correction_round_count: nonNegativeInteger(value.correction_round_count,
      'completion_record.review_round_summary.correction_round_count'),
    blocker_count: nonNegativeInteger(value.blocker_count,
      'completion_record.review_round_summary.blocker_count'),
    first_pass: value.first_pass,
    head_binding_coverage: value.head_binding_coverage,
  };
  assert(typeof normalized.first_pass === 'boolean',
    'completion_record.review_round_summary.first_pass must be boolean');
  assert(['complete', 'partial', 'none'].includes(normalized.head_binding_coverage),
    'Unsupported completion_record.review_round_summary.head_binding_coverage');
  assert(normalized.blocking_round_count <= normalized.review_round_count,
    'blocking_round_count cannot exceed review_round_count');
  assert(normalized.correction_round_count <= normalized.review_round_count,
    'correction_round_count cannot exceed review_round_count');
  return normalized;
}

export function normalizeCompletionRecord(record) {
  const value = exactKeys(record, 'completion_record', COMPLETION_RECORD_REQUIRED_KEYS,
    COMPLETION_RECORD_OPTIONAL_KEYS);
  assert(value.schema_version === COMPLETION_RECORD_SCHEMA_VERSION,
    `Unsupported Completion Record schema: ${String(value.schema_version)}`);
  const childTaskId = requiredString(value.child_task_id, 'completion_record.child_task_id');
  const recordId = requiredString(value.record_id, 'completion_record.record_id');
  assert(SHA256_REF.test(recordId), 'completion_record.record_id must be a SHA-256 reference');
  assert(recordId === completionRecordId(childTaskId),
    'completion_record.record_id does not match child_task_id');
  assert(COMPLETION_DELIVERY_STATUSES.includes(value.delivery_status),
    `Unsupported Completion Record delivery status: ${String(value.delivery_status)}`);

  const generationInputs = exactKeys(value.generation_inputs,
    'completion_record.generation_inputs',
    ['schema_version', 'manifest_uri', 'manifest_sha256']);
  assert(generationInputs.schema_version === COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION,
    `Unsupported Completion Record input manifest schema: ${String(generationInputs.schema_version)}`);
  const artifact = exactKeys(value.artifact, 'completion_record.artifact',
    ['uri', 'media_type', 'byte_length', 'content_sha256']);
  assert(['application/json', 'text/markdown'].includes(artifact.media_type),
    `Unsupported completion_record.artifact.media_type: ${String(artifact.media_type)}`);
  const normalized = {
    schema_version: COMPLETION_RECORD_SCHEMA_VERSION,
    record_id: recordId,
    child_task_id: childTaskId,
    delivery_status: value.delivery_status,
    generator_ref: immutableRef(value.generator_ref, 'completion_record.generator_ref'),
    generation_inputs: {
      schema_version: COMPLETION_INPUT_MANIFEST_SCHEMA_VERSION,
      manifest_uri: repositoryUri(generationInputs.manifest_uri,
        'completion_record.generation_inputs.manifest_uri'),
      manifest_sha256: digest(generationInputs.manifest_sha256,
        'completion_record.generation_inputs.manifest_sha256'),
    },
    generation_inputs_digest: digest(value.generation_inputs_digest,
      'completion_record.generation_inputs_digest'),
    artifact: {
      uri: repositoryUri(artifact.uri, 'completion_record.artifact.uri'),
      media_type: artifact.media_type,
      byte_length: nonNegativeInteger(artifact.byte_length,
        'completion_record.artifact.byte_length'),
      content_sha256: digest(artifact.content_sha256,
        'completion_record.artifact.content_sha256'),
    },
    unresolved_items: normalizeUnresolvedItems(value.unresolved_items),
  };

  if (value.parent_task_refs != null) normalized.parent_task_refs = sortedUniqueStrings(
    value.parent_task_refs,
    'completion_record.parent_task_refs',
    requiredString,
    { allowEmpty: true },
  );
  for (const field of ['issue_number', 'pr_number']) {
    if (value[field] != null) normalized[field] = positiveInteger(value[field], `completion_record.${field}`);
  }
  for (const field of ['base_sha', 'head_sha', 'merge_sha']) {
    if (value[field] != null) normalized[field] = gitSha(value[field], `completion_record.${field}`);
  }
  if (value.generated_at != null) {
    const timestamp = requiredString(value.generated_at, 'completion_record.generated_at');
    assert(!Number.isNaN(Date.parse(timestamp)) && new Date(timestamp).toISOString() === timestamp,
      'completion_record.generated_at must be a canonical ISO-8601 timestamp');
    normalized.generated_at = timestamp;
  }
  for (const field of [
    'task_spec_ref', 'autonomy_policy_ref', 'or_authorization_grant_ref',
    'release_judgment_ref', 'merge_observation_ref',
  ]) {
    if (value[field] != null) normalized[field] = immutableRef(value[field], `completion_record.${field}`);
  }
  for (const field of [
    'evidence_refs', 'verification_refs', 'review_refs', 'escalation_refs',
  ]) {
    if (value[field] != null) normalized[field] = sortedUniqueStrings(
      value[field], `completion_record.${field}`,
    );
  }
  if (value.important_decisions != null) {
    normalized.important_decisions = normalizeDecisions(value.important_decisions);
  }
  if (value.review_round_summary != null) {
    normalized.review_round_summary = normalizeReviewRoundSummary(value.review_round_summary);
  }

  if (normalized.delivery_status === 'review_passed') {
    assert((normalized.review_refs?.length ?? 0) > 0,
      'review_passed requires review_refs evidence');
    assert(normalized.unresolved_items.length === 0,
      'review_passed cannot contain unresolved_items');
    assert(normalized.merge_sha == null && normalized.merge_observation_ref == null,
      'review_passed cannot claim provider integration evidence');
  } else if (normalized.delivery_status === 'integrated') {
    assert((normalized.review_refs?.length ?? 0) > 0,
      'integrated requires review_refs evidence');
    assert(normalized.merge_sha != null && normalized.merge_observation_ref != null,
      'integrated requires merge_sha and merge_observation_ref provider evidence');
    assert(normalized.unresolved_items.length === 0,
      'integrated cannot contain unresolved_items');
  } else {
    assert(normalized.unresolved_items.length > 0,
      'abandoned requires unresolved_items with evidence');
    assert(normalized.merge_sha == null && normalized.merge_observation_ref == null,
      'abandoned cannot claim provider integration evidence');
  }
  return normalized;
}

export function canonicalCompletionRecord(record) {
  return canonicalCompletionJson(normalizeCompletionRecord(record));
}

export function verifyCompletionRecordReplay(record, {
  inputManifest,
  inputManifestBytes,
  artifactBytes,
  replayOf = null,
} = {}) {
  const normalized = normalizeCompletionRecord(record);
  const manifest = normalizeCompletionInputManifest(inputManifest);
  assert(manifest.child_task_id === normalized.child_task_id,
    'Input manifest child_task_id does not match Completion Record identity');
  const canonicalManifestBytes = Buffer.from(canonicalCompletionJson(manifest), 'utf8');
  const suppliedManifestBytes = inputManifestBytes == null
    ? canonicalManifestBytes
    : Buffer.from(inputManifestBytes);
  assert(suppliedManifestBytes.equals(canonicalManifestBytes),
    'Input manifest bytes are not canonical');
  assert(completionSha256(suppliedManifestBytes) === normalized.generation_inputs.manifest_sha256,
    'Input manifest content digest mismatch');
  assert(generationInputsDigest(manifest) === normalized.generation_inputs_digest,
    'Normalized generation inputs digest mismatch');
  assert(artifactBytes != null, 'Artifact bytes are required for Completion Record replay');
  const outputBytes = Buffer.from(artifactBytes);
  assert(outputBytes.length === normalized.artifact.byte_length,
    'Artifact byte length mismatch');
  assert(completionSha256(outputBytes) === normalized.artifact.content_sha256,
    'Artifact content_sha256 mismatch');

  if (replayOf != null) {
    const prior = normalizeCompletionRecord(replayOf);
    assert(prior.child_task_id === normalized.child_task_id,
      'Replay Completion Records have different child identity');
    assert(prior.generator_ref === normalized.generator_ref,
      'Replay generator_ref mismatch');
    assert(prior.generation_inputs_digest === normalized.generation_inputs_digest,
      'Replay generation_inputs_digest mismatch');
    assert(prior.artifact.content_sha256 === normalized.artifact.content_sha256
      && prior.artifact.byte_length === normalized.artifact.byte_length,
    'Replay output bytes are not identical');
  }
  return {
    record: normalized,
    canonical_record_bytes: canonicalCompletionRecord(normalized),
    manifest,
    manifest_sha256: completionSha256(suppliedManifestBytes),
    generation_inputs_digest: generationInputsDigest(manifest),
    artifact_content_sha256: completionSha256(outputBytes),
  };
}
