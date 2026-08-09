import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const COMPLETION_RECORD_FIELD_COVERAGE_SCHEMA_VERSION =
  'ao.completion-record-field-coverage.v1';
export const COMPLETION_RECORD_FIELD_COVERAGE_REPORT_SCHEMA_VERSION =
  'ao.completion-record-field-coverage-report.v1';

const CLASSIFICATIONS = new Set(['required', 'conditional', 'unsupported']);
const COVERAGE_STATES = new Set(['established', 'not_established', 'unsupported']);
const OMISSION_SEMANTICS = new Set(['fail_closed', 'explicit_not_established', 'omit']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, label) {
  assert(typeof value === 'string' && value.trim() !== '', `Missing ${label}`);
  return value.trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function fileDigest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function resolveJsonPointer(document, pointer, label) {
  assert(pointer === '' || pointer.startsWith('/'), `Invalid JSON pointer for ${label}: ${pointer}`);
  const tokens = pointer === ''
    ? []
    : pointer.slice(1).split('/').map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let cursors = [document];
  for (const token of tokens) {
    const next = [];
    for (const cursor of cursors) {
      if (token === '*') {
        if (Array.isArray(cursor)) next.push(...cursor);
        else if (cursor != null && typeof cursor === 'object') next.push(...Object.values(cursor));
        continue;
      }
      if (cursor != null && typeof cursor === 'object'
        && Object.prototype.hasOwnProperty.call(cursor, token)) {
        next.push(cursor[token]);
      }
    }
    cursors = next;
    if (cursors.length === 0) break;
  }
  assert(cursors.length > 0, `Missing JSON pointer for ${label}: ${pointer}`);
  return cursors;
}

function validateSource(source, index, repositoryRoot) {
  const label = `sources[${index}]`;
  const id = nonEmptyString(source?.id, `${label}.id`);
  const relativePath = nonEmptyString(source?.path, `${label}.path`);
  assert(!path.isAbsolute(relativePath) && !relativePath.split('/').includes('..'), `Unbounded ${label}.path`);
  assert(['json', 'markdown'].includes(source.format), `Invalid ${label}.format`);
  assert(/^[0-9a-f]{64}$/.test(source.sha256), `Invalid ${label}.sha256`);
  const absolutePath = path.join(repositoryRoot, relativePath);
  assert(fs.existsSync(absolutePath), `Missing oracle source: ${relativePath}`);
  const bytes = fs.readFileSync(absolutePath);
  const actualDigest = fileDigest(bytes);
  assert(actualDigest === source.sha256, `Oracle digest mismatch for ${relativePath}: expected ${source.sha256}, got ${actualDigest}`);

  let document;
  if (source.format === 'json') {
    try {
      document = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error(`Invalid oracle JSON: ${relativePath}`);
    }
    if (source.schema_version != null) {
      assert(document.schema_version === source.schema_version, `Oracle schema mismatch for ${relativePath}`);
    }
  } else {
    document = bytes.toString('utf8');
    for (const marker of source.required_markers ?? []) {
      assert(document.includes(marker), `Missing Markdown oracle marker in ${relativePath}: ${marker}`);
    }
  }
  return { ...source, id, document };
}

function validateMapping(mapping, label, sourceMap) {
  const sourceId = nonEmptyString(mapping?.source_id, `${label}.source_id`);
  const source = sourceMap.get(sourceId);
  assert(source, `Unknown oracle source for ${label}: ${sourceId}`);
  const selector = nonEmptyString(mapping.selector, `${label}.selector`);
  const extraction = nonEmptyString(mapping.extraction, `${label}.extraction`);
  if (source.format === 'json') {
    assert(mapping.kind === 'json_pointer', `JSON source requires json_pointer for ${label}`);
    resolveJsonPointer(source.document, selector, label);
  } else {
    assert(mapping.kind === 'markdown_marker', `Markdown source requires markdown_marker for ${label}`);
    assert(source.document.includes(selector), `Missing Markdown mapping marker for ${label}: ${selector}`);
  }
  return { source_id: sourceId, kind: mapping.kind, selector, extraction };
}

export function validateCompletionRecordFieldCoverage(ledger, {
  repositoryRoot = process.cwd(),
} = {}) {
  assert(ledger?.schema_version === COMPLETION_RECORD_FIELD_COVERAGE_SCHEMA_VERSION,
    'Unsupported Completion Record field coverage schema');
  nonEmptyString(ledger.ledger_version, 'ledger_version');
  assert(Array.isArray(ledger.sources) && ledger.sources.length > 0, 'Missing oracle sources');
  assert(Array.isArray(ledger.candidates) && ledger.candidates.length > 0, 'Missing candidate fields');

  const sources = ledger.sources.map((source, index) => validateSource(source, index, repositoryRoot));
  const sourceIds = sources.map((source) => source.id);
  assert(sourceIds.length === new Set(sourceIds).size, 'Duplicate oracle source id');
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  assert(sources.some((source) => source.format === 'json'), 'Structured oracle coverage is required');
  assert(sources.some((source) => source.format === 'markdown'), 'Markdown oracle coverage is required');

  const fieldIds = [];
  const rows = [];
  for (const [index, candidate] of ledger.candidates.entries()) {
    const label = `candidates[${index}]`;
    const field = nonEmptyString(candidate?.field, `${label}.field`);
    fieldIds.push(field);
    assert(CLASSIFICATIONS.has(candidate.classification), `Invalid classification for ${field}`);
    assert(COVERAGE_STATES.has(candidate.oracle_coverage), `Invalid oracle coverage for ${field}`);
    assert(OMISSION_SEMANTICS.has(candidate.when_missing), `Invalid missing-evidence semantics for ${field}`);
    nonEmptyString(candidate.rationale, `${label}.rationale`);
    const mappings = (candidate.mappings ?? []).map((mapping, mappingIndex) => (
      validateMapping(mapping, `${label}.mappings[${mappingIndex}]`, sourceMap)
    ));

    if (candidate.classification === 'unsupported') {
      assert(candidate.oracle_coverage === 'unsupported', `Unsupported field must have unsupported coverage: ${field}`);
      assert(candidate.when_missing === 'omit', `Unsupported field must be omitted: ${field}`);
      assert(mappings.length === 0, `Unsupported field cannot have source mappings: ${field}`);
      assert(candidate.source_contract == null, `Unsupported field cannot have a source contract: ${field}`);
    } else {
      const sourceContract = candidate.source_contract;
      assert(sourceContract != null && typeof sourceContract === 'object', `Missing deterministic source contract for ${field}`);
      nonEmptyString(sourceContract.authority, `${label}.source_contract.authority`);
      nonEmptyString(sourceContract.selector, `${label}.source_contract.selector`);
      nonEmptyString(sourceContract.transformation, `${label}.source_contract.transformation`);
      if (candidate.oracle_coverage === 'established') {
        assert(mappings.length > 0, `Established field lacks oracle mapping: ${field}`);
      } else {
        assert(candidate.oracle_coverage === 'not_established', `Invalid supported coverage for ${field}`);
        assert(candidate.coverage_gap != null, `Missing explicit coverage gap for ${field}`);
        nonEmptyString(candidate.coverage_gap.code, `${label}.coverage_gap.code`);
        nonEmptyString(candidate.coverage_gap.reason, `${label}.coverage_gap.reason`);
      }
      const expectedMissing = candidate.classification === 'required' ? 'fail_closed' : 'explicit_not_established';
      assert(candidate.when_missing === expectedMissing, `Incorrect missing-evidence semantics for ${field}`);
    }

    rows.push({
      field,
      classification: candidate.classification,
      oracle_coverage: candidate.oracle_coverage,
      when_missing: candidate.when_missing,
      source_contract: candidate.source_contract ?? null,
      mappings,
      coverage_gap: candidate.coverage_gap ?? null,
      rationale: candidate.rationale,
    });
  }
  assert(fieldIds.length === new Set(fieldIds).size, 'Duplicate candidate field');
  assert([...fieldIds].sort().join('\n') === fieldIds.join('\n'),
    'Candidate fields must be sorted');

  for (const classification of CLASSIFICATIONS) {
    assert(rows.some((row) => row.classification === classification), `Missing ${classification} classification`);
  }
  for (const state of COVERAGE_STATES) {
    assert(rows.some((row) => row.oracle_coverage === state), `Missing ${state} oracle coverage`);
  }

  const deliveryStatus = rows.find((row) => row.field === 'delivery_status');
  const deliverySelectors = new Set(deliveryStatus?.mappings.map((mapping) => (
    `${mapping.source_id}:${mapping.selector}`
  )));
  assert(deliverySelectors.has('harvest_review_baseline:/per_pr_rounds/*/rounds/*/verdict'),
    'delivery_status must map exact-head review verdict evidence');
  assert(deliverySelectors.has('harvest_review_baseline:/per_pr_rounds/*/merge_commit_sha'),
    'delivery_status must map provider merge evidence');

  return { sources, rows };
}

export function buildCompletionRecordFieldCoverageReport(ledger, options = {}) {
  const { sources, rows } = validateCompletionRecordFieldCoverage(ledger, options);
  const coverageGaps = rows.filter((row) => row.oracle_coverage === 'not_established').map((row) => ({
    field: row.field,
    classification: row.classification,
    when_missing: row.when_missing,
    code: row.coverage_gap.code,
    reason: row.coverage_gap.reason,
  }));
  const explicitOmissions = rows.filter((row) => row.classification === 'unsupported').map((row) => ({
    field: row.field,
    semantics: 'omit',
    reason: row.rationale,
  }));
  const reportCore = {
    schema_version: COMPLETION_RECORD_FIELD_COVERAGE_REPORT_SCHEMA_VERSION,
    ledger_version: ledger.ledger_version,
    ledger_digest: stableDigest(ledger),
    source_digests: sources.map(({ id, path: sourcePath, sha256, format }) => ({
      id, path: sourcePath, sha256, format,
    })),
    summary: {
      candidate_count: rows.length,
      required_count: rows.filter((row) => row.classification === 'required').length,
      conditional_count: rows.filter((row) => row.classification === 'conditional').length,
      unsupported_count: rows.filter((row) => row.classification === 'unsupported').length,
      established_count: rows.filter((row) => row.oracle_coverage === 'established').length,
      not_established_count: coverageGaps.length,
      omission_count: explicitOmissions.length,
    },
    fields: rows,
    coverage_gaps: coverageGaps,
    explicit_omissions: explicitOmissions,
    inference_policy: 'No missing, ambiguous, narrative, or cross-artifact value is inferred.',
  };
  return { ...reportCore, report_fingerprint: stableDigest(reportCore) };
}

export function loadCompletionRecordFieldCoverage(ledgerPath) {
  return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
}
