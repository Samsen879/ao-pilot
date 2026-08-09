import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const FALSE_SUCCESS_FIXTURE_PACK_SCHEMA_VERSION = 'ao.false-success-trajectory-fixture-pack.v1';
export const FALSE_SUCCESS_AUDIT_REPORT_SCHEMA_VERSION = 'ao.false-success-trajectory-audit-report.v1';

const POLICIES = Object.freeze({
  provider_merge_outcome: {
    allowed(observation) {
      return observation.provider_readback_complete === true
        && observation.provider_pr_state === 'MERGED';
    },
    falseCode: 'provider_merge_not_observed',
    unknownCode: 'provider_merge_outcome_unknown',
  },
  provider_dispatch_outcome: {
    allowed(observation) {
      return observation.provider_readback_complete === true
        && observation.provider_outcome === 'delivered';
    },
    falseCode: 'dispatch_is_not_provider_outcome',
    unknownCode: 'provider_dispatch_outcome_unknown',
  },
  ci_execution: {
    allowed(observation) {
      return ['completed_success', 'completed_failure'].includes(observation.raw_check_state);
    },
    falseCode: 'ci_was_not_executed',
    unknownCode: 'ci_execution_unknown',
  },
  ci_code_failure: {
    allowed(observation) {
      return observation.raw_check_state === 'completed_failure';
    },
    falseCode: 'runner_outcome_is_not_code_failure',
    unknownCode: 'ci_failure_cause_unknown',
  },
  ci_success: {
    allowed(observation) {
      return observation.raw_check_state === 'completed_success'
        && observation.required_checks_complete === true
        && observation.exact_head === true;
    },
    falseCode: 'aggregate_ci_does_not_prove_required_success',
    unknownCode: 'required_ci_outcome_unknown',
  },
  exact_head_review: {
    allowed(observation) {
      return ['COMMENTED', 'APPROVED'].includes(observation.review_state)
        && observation.review_actor === 'chatgpt-codex-connector[bot]'
        && observation.protocol_verdict === 'PASS'
        && observation.protocol_independent_role === true
        && typeof observation.target_head === 'string'
        && observation.target_head !== ''
        && observation.review_commit_oid === observation.target_head
        && observation.submitted_review_evidence === true;
    },
    falseCode: 'review_does_not_bind_exact_head',
    unknownCode: 'exact_head_review_outcome_unknown',
  },
  lifecycle_judgment_outcome: {
    allowed() { return false; },
    falseCode: 'ao_judgment_is_not_external_outcome',
    unknownCode: 'external_outcome_unknown',
  },
  receipt_terminality: {
    allowed() { return false; },
    falseCode: 'specialized_receipt_is_not_terminal_delivery',
    unknownCode: 'terminal_delivery_outcome_unknown',
  },
  checkpoint_terminality: {
    allowed() { return false; },
    falseCode: 'checkpoint_validity_is_not_terminal_delivery',
    unknownCode: 'terminal_delivery_outcome_unknown',
  },
  independent_evidence: {
    allowed(observation) {
      return observation.evidence_complete === true
        && observation.independent_authority === true
        && observation.outcome_known === true;
    },
    falseCode: 'assertion_lacks_independent_evidence',
    unknownCode: 'external_outcome_unknown',
  },
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, label) {
  assert(typeof value === 'string' && value.trim() !== '', `Missing ${label}`);
  return value.trim();
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function validateEvidenceValue(evidence, itemMap, label) {
  const item = itemMap.get(nonEmptyString(evidence?.item_id, `${label}.item_id`));
  assert(item, `Unknown evidence item for ${label}: ${evidence?.item_id}`);
  assert(item.values.includes(evidence.value), `Unsupported evidence value for ${label}: ${evidence.value}`);
  return item.id;
}

function validateObservationValue(fixture, itemMap) {
  const producer = fixture.producer;
  const item = itemMap.get(nonEmptyString(producer?.item_id, `${fixture.id}.producer.item_id`));
  assert(item, `Unknown producer item for ${fixture.id}: ${producer?.item_id}`);
  assert(item.values.includes(producer.value), `Unsupported producer value for ${fixture.id}: ${producer.value}`);
}

function evidenceValue(fixture, itemId) {
  return fixture.evidence.find((evidence) => evidence.item_id === itemId)?.value;
}

function validateCoherentTrajectory(fixture) {
  const checkpointState = evidenceValue(fixture, 'checkpoint.inspection_state');
  const checkpointReason = evidenceValue(fixture, 'checkpoint.inspection_reason_codes');
  if (checkpointState === 'valid') {
    assert(checkpointReason == null, `Valid checkpoint cannot contain an invalidity reason: ${fixture.id}`);
  }
  if (checkpointReason != null) {
    assert(['invalid', 'stale'].includes(checkpointState), `Checkpoint reason requires invalid or stale state: ${fixture.id}`);
  }

  const releaseDisposition = evidenceValue(fixture, 'lifecycle.release_disposition');
  if (releaseDisposition === 'release_ready') {
    assert(evidenceValue(fixture, 'action.lifecycle_action_id') === 'release_ready', `release_ready action id mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'action.lifecycle_action_class') === 'release_judgment', `release_ready action class mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'lifecycle.release_basis') === 'release_preflight_authorized', `release_ready basis mismatch: ${fixture.id}`);
  }
  if (releaseDisposition === 'notify_human_ready') {
    assert(evidenceValue(fixture, 'action.lifecycle_action_id') === 'notify_human_ready', `notify_human_ready action id mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'action.lifecycle_action_class') === 'notify_human', `notify_human_ready action class mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'lifecycle.release_basis') === 'ready_for_human_notification', `notify_human_ready basis mismatch: ${fixture.id}`);
  }
  if (evidenceValue(fixture, 'lifecycle.human_gate_mapping') != null) {
    assert(releaseDisposition === 'human_gate', `Human-gate mapping requires human_gate release disposition: ${fixture.id}`);
    assert(evidenceValue(fixture, 'action.lifecycle_action_id') === 'human_gate', `Human-gate action id mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'action.lifecycle_action_class') === 'human_gate', `Human-gate action class mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'lifecycle.top_status') === 'human_gate', `Human-gate top status mismatch: ${fixture.id}`);
    assert(evidenceValue(fixture, 'lifecycle.automation_disposition') === 'human_gate', `Human-gate automation disposition mismatch: ${fixture.id}`);
  }
}

export function validateFalseSuccessFixturePack(pack, inventory) {
  assert(pack?.schema_version === FALSE_SUCCESS_FIXTURE_PACK_SCHEMA_VERSION, 'Unsupported false-success fixture pack schema');
  assert(pack.inventory_schema_version === inventory.schema_version, 'Fixture pack inventory schema mismatch');
  nonEmptyString(pack.fixture_pack_version, 'fixture_pack_version');
  assert(Array.isArray(pack.fixtures) && pack.fixtures.length > 0, 'Missing false-success fixtures');

  const itemMap = new Map(inventory.items.map((item) => [item.id, item]));
  const ids = new Set();
  const covered = new Set();
  const types = new Set();
  for (const [index, fixture] of pack.fixtures.entries()) {
    const id = nonEmptyString(fixture?.id, `fixtures[${index}].id`);
    assert(!ids.has(id), `Duplicate false-success fixture: ${id}`);
    ids.add(id);
    assert(['false_success', 'unknown_outcome'].includes(fixture.type), `Unsupported fixture type for ${id}`);
    types.add(fixture.type);
    nonEmptyString(fixture.description, `${id}.description`);
    nonEmptyString(fixture.claim, `${id}.claim`);
    assert(POLICIES[fixture.policy], `Unknown audit policy for ${id}: ${fixture.policy}`);
    assert(fixture.observation != null && typeof fixture.observation === 'object' && !Array.isArray(fixture.observation), `Missing observation for ${id}`);
    validateObservationValue(fixture, itemMap);
    assert(Array.isArray(fixture.covers) && fixture.covers.length > 0, `Missing vocabulary coverage for ${id}`);
    assert(new Set(fixture.covers).size === fixture.covers.length, `Duplicate vocabulary coverage for ${id}`);
    assert(Array.isArray(fixture.evidence) && fixture.evidence.length > 0, `Missing concrete vocabulary evidence for ${id}`);
    const evidenceIds = fixture.evidence.map((evidence, evidenceIndex) => (
      validateEvidenceValue(evidence, itemMap, `${id}.evidence[${evidenceIndex}]`)
    ));
    assert(new Set(evidenceIds).size === evidenceIds.length, `Duplicate vocabulary evidence for ${id}`);
    for (const itemId of fixture.covers) {
      assert(itemMap.has(itemId), `Unknown coverage item for ${id}: ${itemId}`);
      assert(evidenceIds.includes(itemId), `Coverage item lacks concrete evidence for ${id}: ${itemId}`);
      covered.add(itemId);
    }
    for (const itemId of evidenceIds) {
      assert(fixture.covers.includes(itemId), `Concrete evidence is not declared as coverage for ${id}: ${itemId}`);
    }
    validateCoherentTrajectory(fixture);
    assert(fixture.covers.includes(fixture.producer.item_id), `Producer is not covered by fixture ${id}`);
    assert(fixture.evidence.some((evidence) => (
      evidence.item_id === fixture.producer.item_id && evidence.value === fixture.producer.value
    )), `Producer value lacks concrete evidence for ${id}`);
    assert(fixture.expected?.disposition === 'block', `Negative fixture ${id} must expect block`);
    nonEmptyString(fixture.expected.finding_code, `${id}.expected.finding_code`);
  }
  assert(types.has('false_success'), 'Fixture pack has no false-success fixture');
  assert(types.has('unknown_outcome'), 'Fixture pack has no unknown-outcome fixture');

  const fixtureMap = new Map(pack.fixtures.map((fixture) => [fixture.id, fixture]));
  for (const fixture of pack.fixtures.filter((entry) => entry.replay_of != null)) {
    const replayTarget = fixtureMap.get(nonEmptyString(fixture.replay_of, `${fixture.id}.replay_of`));
    assert(replayTarget && replayTarget.id !== fixture.id, `Unknown replay target for ${fixture.id}: ${fixture.replay_of}`);
    const semanticProjection = (entry) => ({
      type: entry.type,
      policy: entry.policy,
      claim: entry.claim,
      producer: entry.producer,
      observation: entry.observation,
      evidence: entry.evidence,
      expected: entry.expected,
    });
    assert(
      stableDigest(semanticProjection(fixture)) === stableDigest(semanticProjection(replayTarget)),
      `Replay semantics differ from ${fixture.replay_of}: ${fixture.id}`,
    );
  }

  const missing = inventory.items.map((item) => item.id).filter((id) => !covered.has(id));
  assert(missing.length === 0, `F01 vocabulary paths lack negative fixture coverage: ${missing.join(', ')}`);
  return { fixture_count: ids.size, covered_item_count: covered.size };
}

export function evaluateFalseSuccessFixture(fixture) {
  const policy = POLICIES[fixture.policy];
  assert(policy, `Unknown audit policy: ${fixture.policy}`);
  const allowed = policy.allowed(fixture.observation);
  if (allowed) {
    return { fixture_id: fixture.id, disposition: 'allow', findings: [] };
  }
  const code = fixture.type === 'unknown_outcome' ? policy.unknownCode : policy.falseCode;
  const findingCore = {
    code,
    fixture_id: fixture.id,
    fixture_type: fixture.type,
    policy: fixture.policy,
    claim: fixture.claim,
    producer_item_id: fixture.producer.item_id,
    producer_value: fixture.producer.value,
    evidence_digest: stableDigest(fixture.evidence),
    observation_digest: stableDigest(fixture.observation),
    disposition: 'block',
    durable: true,
  };
  return {
    fixture_id: fixture.id,
    disposition: 'block',
    findings: [{ ...findingCore, fingerprint: stableDigest(findingCore) }],
  };
}

export function buildFalseSuccessAuditReport(pack, inventory) {
  const validation = validateFalseSuccessFixturePack(pack, inventory);
  const evaluations = pack.fixtures
    .map(evaluateFalseSuccessFixture)
    .sort((left, right) => left.fixture_id.localeCompare(right.fixture_id));
  for (const evaluation of evaluations) {
    const fixture = pack.fixtures.find((entry) => entry.id === evaluation.fixture_id);
    assert(evaluation.disposition === fixture.expected.disposition, `Unexpected disposition for ${fixture.id}`);
    assert(evaluation.findings[0]?.code === fixture.expected.finding_code, `Unexpected finding code for ${fixture.id}`);
  }
  const evaluationMap = new Map(evaluations.map((evaluation) => [evaluation.fixture_id, evaluation]));
  for (const fixture of pack.fixtures.filter((entry) => entry.replay_of != null)) {
    const replay = evaluationMap.get(fixture.id);
    const source = evaluationMap.get(fixture.replay_of);
    const resultProjection = (evaluation) => ({
      disposition: evaluation.disposition,
      findings: evaluation.findings.map(({ fixture_id: ignoredFixtureId, fingerprint: ignoredFingerprint, ...finding }) => finding),
    });
    assert(
      stableDigest(resultProjection(replay)) === stableDigest(resultProjection(source)),
      `Replay result differs from ${fixture.replay_of}: ${fixture.id}`,
    );
  }

  const findings = evaluations.flatMap((evaluation) => evaluation.findings)
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const coverage = inventory.items.map((item) => {
    const fixtures = pack.fixtures.filter((fixture) => fixture.covers.includes(item.id));
    return {
      item_id: item.id,
      family: item.family,
      field: item.field,
      fixture_ids: fixtures.map((fixture) => fixture.id).sort(),
      policies: [...new Set(fixtures.map((fixture) => fixture.policy))].sort(),
      observed_values: fixtures.flatMap((fixture) => fixture.evidence
        .filter((evidence) => evidence.item_id === item.id)
        .map((evidence) => ({ fixture_id: fixture.id, value: evidence.value })))
        .sort((left, right) => `${left.fixture_id}:${left.value}`.localeCompare(`${right.fixture_id}:${right.value}`)),
      finding_fingerprints: findings
        .filter((finding) => fixtures.some((fixture) => fixture.id === finding.fixture_id))
        .map((finding) => finding.fingerprint)
        .sort(),
    };
  }).sort((left, right) => left.item_id.localeCompare(right.item_id));

  const reportCore = {
    schema_version: FALSE_SUCCESS_AUDIT_REPORT_SCHEMA_VERSION,
    fixture_pack_version: pack.fixture_pack_version,
    fixture_pack_digest: stableDigest(pack),
    inventory_schema_version: inventory.schema_version,
    inventory_version: inventory.inventory_version,
    status: findings.length === pack.fixtures.length ? 'blocked_as_expected' : 'invalid',
    summary: {
      fixture_count: validation.fixture_count,
      false_success_fixture_count: pack.fixtures.filter((fixture) => fixture.type === 'false_success').length,
      unknown_outcome_fixture_count: pack.fixtures.filter((fixture) => fixture.type === 'unknown_outcome').length,
      covered_item_count: validation.covered_item_count,
      inventory_item_count: inventory.items.length,
      blocking_finding_count: findings.length,
      unresolved_producer_count: new Set(findings.map((finding) => finding.producer_item_id)).size,
    },
    coverage,
    blocking_findings: findings,
  };
  return { ...reportCore, report_fingerprint: stableDigest(reportCore) };
}

export function loadFalseSuccessFixturePack(packPath) {
  return JSON.parse(fs.readFileSync(packPath, 'utf8'));
}
