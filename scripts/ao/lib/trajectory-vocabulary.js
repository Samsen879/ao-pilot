import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const TRAJECTORY_VOCABULARY_SCHEMA_VERSION = 'ao.trajectory-vocabulary.v1';
export const TRAJECTORY_FIXTURE_SCHEMA_VERSION = 'ao.trajectory-vocabulary-fixture.v1';
export const REQUIRED_TRAJECTORY_FAMILIES = Object.freeze([
  'action',
  'execution_receipt',
  'lifecycle_disposition',
  'review_verdict',
  'ci_state',
  'merge_observation',
  'checkpoint',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nonEmptyString(value, label) {
  assert(typeof value === 'string' && value.trim() !== '', `Missing ${label}`);
  return value.trim();
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function symbolSection(source, symbol) {
  const escapedSymbol = escapeRegExp(symbol);
  const declaration = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapedSymbol}\\s*\\(`);
  const match = declaration.exec(source);
  if (!match) return null;

  const remainder = source.slice(match.index + match[0].length);
  const nextDeclaration = /\n(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.exec(remainder);
  return nextDeclaration == null ? remainder : remainder.slice(0, nextDeclaration.index);
}

function constantArrayValues(source, symbol) {
  const declaration = new RegExp(
    `(?:export\\s+)?const\\s+${escapeRegExp(symbol)}\\s*=\\s*(?:Object\\.freeze\\(\\s*)?\\[([\\s\\S]*?)\\]`,
  ).exec(source);
  if (!declaration) return null;
  return [...declaration[1].matchAll(/(['"])(.*?)\1/g)].map((match) => match[2]);
}

function semanticLayer(item) {
  const role = String(item?.episode_role ?? '');
  if (role.startsWith('judgment.') || role.startsWith('mapping.')) return 'ao_judgment';
  if (role === 'execution.or_effect') return 'or_effect';
  if (role.startsWith('outcome.') || role.startsWith('review.provider_') || role.startsWith('ci.provider_')) {
    return 'provider_outcome';
  }
  return null;
}

function validateBaseline(baseline, repositoryRoot, verifyGit) {
  const shaPattern = /^[0-9a-f]{40}$/;
  const issueBodySha = nonEmptyString(baseline?.issue_body_sha, 'baseline.issue_body_sha');
  const issueBodyTree = nonEmptyString(baseline?.issue_body_tree, 'baseline.issue_body_tree');
  const admittedSha = nonEmptyString(baseline?.admitted_sha, 'baseline.admitted_sha');
  const admittedTree = nonEmptyString(baseline?.admitted_tree, 'baseline.admitted_tree');
  assert(shaPattern.test(issueBodySha), 'Invalid baseline.issue_body_sha');
  assert(shaPattern.test(issueBodyTree), 'Invalid baseline.issue_body_tree');
  assert(shaPattern.test(admittedSha), 'Invalid baseline.admitted_sha');
  assert(shaPattern.test(admittedTree), 'Invalid baseline.admitted_tree');
  assert(
    baseline?.relationship === 'issue_body_sha_is_ancestor_of_admitted_sha',
    'Invalid baseline.relationship',
  );

  if (!verifyGit) return;
  const git = (args) => execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  try {
    assert(git(['rev-parse', `${issueBodySha}^{tree}`]) === issueBodyTree, 'Issue-body tree does not match baseline SHA');
    assert(git(['rev-parse', `${admittedSha}^{tree}`]) === admittedTree, 'Admitted tree does not match baseline SHA');
    execFileSync('git', ['merge-base', '--is-ancestor', issueBodySha, admittedSha], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
  } catch (error) {
    if (error?.message?.startsWith('Issue-body tree') || error?.message?.startsWith('Admitted tree')) throw error;
    throw new Error('Issue-body SHA is not an ancestor of admitted SHA');
  }
}

export function trajectoryVocabularyDigest(inventory) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJson(inventory)))
    .digest('hex');
}

function validateReference(reference, label, repositoryRoot, {
  verifySource = true,
  references = {},
} = {}) {
  const resolvedReference = typeof reference === 'string' ? references[reference] : reference;
  if (typeof reference === 'string') {
    assert(resolvedReference != null, `Unknown ${label} alias: ${reference}`);
  }
  assert(resolvedReference != null && typeof resolvedReference === 'object' && !Array.isArray(resolvedReference), `Invalid ${label}`);
  const relativePath = nonEmptyString(resolvedReference.path, `${label}.path`);
  const symbol = nonEmptyString(resolvedReference.symbol, `${label}.symbol`);
  const kind = resolvedReference.kind ?? (relativePath.endsWith('.md') ? 'documentation' : 'function');
  assert(['constant', 'documentation', 'function', 'literal'].includes(kind), `Invalid ${label}.kind`);
  assert(!path.isAbsolute(relativePath) && !relativePath.split('/').includes('..'), `Unbounded ${label}.path`);

  let declaredValues = null;
  if (verifySource) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    assert(fs.existsSync(absolutePath), `Missing ${label} file: ${relativePath}`);
    const source = fs.readFileSync(absolutePath, 'utf8');
    let section = source;
    if (kind === 'function') {
      section = symbolSection(source, symbol);
      assert(section != null, `Missing ${label} function ${symbol} in ${relativePath}`);
    } else if (kind === 'constant') {
      const declaration = new RegExp(`(?:export\\s+)?const\\s+${escapeRegExp(symbol)}\\b`);
      assert(declaration.test(source), `Missing ${label} constant ${symbol} in ${relativePath}`);
      declaredValues = constantArrayValues(source, symbol);
    } else {
      assert(source.includes(symbol), `Missing ${label} ${kind} ${symbol} in ${relativePath}`);
    }

    const relationshipEvidence = resolvedReference.evidence ?? [];
    const isRelationship = label.includes('.producers[') || label.includes('.consumers[');
    assert(!isRelationship || relationshipEvidence.length > 0, `Missing relationship evidence for ${label}`);
    assert(Array.isArray(relationshipEvidence), `Invalid ${label}.evidence`);
    for (const evidence of relationshipEvidence) {
      const normalizedEvidence = nonEmptyString(evidence, `${label}.evidence`);
      assert(section.includes(normalizedEvidence), `Missing ${label} relationship evidence ${normalizedEvidence} in ${symbol}`);
    }
  }

  return { path: relativePath, symbol, kind, declaredValues };
}

export function validateTrajectoryVocabulary(inventory, {
  repositoryRoot = process.cwd(),
  verifySource = true,
} = {}) {
  assert(inventory?.schema_version === TRAJECTORY_VOCABULARY_SCHEMA_VERSION, 'Unsupported trajectory vocabulary schema');
  nonEmptyString(inventory.inventory_version, 'inventory_version');
  validateBaseline(inventory.baseline, repositoryRoot, verifySource);
  assert(Array.isArray(inventory.families), 'Missing families');
  assert(Array.isArray(inventory.items) && inventory.items.length > 0, 'Missing vocabulary items');
  assert(Array.isArray(inventory.ambiguities), 'Missing ambiguity ledger');
  assert(inventory.references != null && typeof inventory.references === 'object', 'Missing source references');

  const familyIds = inventory.families.map((family, index) => nonEmptyString(family?.id, `families[${index}].id`));
  assert(familyIds.length === new Set(familyIds).size, 'Duplicate family id');
  for (const family of REQUIRED_TRAJECTORY_FAMILIES) {
    assert(familyIds.includes(family), `Missing required family: ${family}`);
  }

  const itemIds = new Set();
  const counts = Object.fromEntries(REQUIRED_TRAJECTORY_FAMILIES.map((family) => [family, 0]));
  for (const [index, item] of inventory.items.entries()) {
    const prefix = `items[${index}]`;
    const id = nonEmptyString(item?.id, `${prefix}.id`);
    assert(!itemIds.has(id), `Duplicate vocabulary item: ${id}`);
    itemIds.add(id);
    const family = nonEmptyString(item.family, `${prefix}.family`);
    assert(familyIds.includes(family), `Unknown family for ${id}: ${family}`);
    counts[family] = (counts[family] ?? 0) + 1;
    nonEmptyString(item.field, `${prefix}.field`);
    nonEmptyString(item.meaning, `${prefix}.meaning`);
    nonEmptyString(item.semantic_owner, `${prefix}.semantic_owner`);
    nonEmptyString(item.evidence_authority, `${prefix}.evidence_authority`);
    nonEmptyString(item.episode_role, `${prefix}.episode_role`);
    assert(Array.isArray(item.values) && item.values.length > 0, `Missing values for ${id}`);
    assert(item.values.every((value) => typeof value === 'string' && value !== ''), `Invalid values for ${id}`);
    assert(sortedUnique(item.values).length === item.values.length, `Duplicate values for ${id}`);
    const sourceReference = validateReference(item.source, `${prefix}.source`, repositoryRoot, {
      verifySource,
      references: inventory.references,
    });
    if (sourceReference.declaredValues != null) {
      assert(
        JSON.stringify(sortedUnique(item.values)) === JSON.stringify(sortedUnique(sourceReference.declaredValues)),
        `Declared values for ${id} differ from source constant ${sourceReference.symbol}`,
      );
    }
    assert(Array.isArray(item.producers) && item.producers.length > 0, `Missing producer for ${id}`);
    assert(Array.isArray(item.consumers) && item.consumers.length > 0, `Missing consumer for ${id}`);
    item.producers.forEach((reference, refIndex) => validateReference(
      reference,
      `${prefix}.producers[${refIndex}]`,
      repositoryRoot,
      { verifySource, references: inventory.references },
    ));
    item.consumers.forEach((reference, refIndex) => validateReference(
      reference,
      `${prefix}.consumers[${refIndex}]`,
      repositoryRoot,
      { verifySource, references: inventory.references },
    ));
  }

  for (const family of REQUIRED_TRAJECTORY_FAMILIES) {
    assert(counts[family] > 0, `Required family has no items: ${family}`);
  }

  const separations = inventory.required_separations;
  assert(separations != null && typeof separations === 'object', 'Missing required separations');
  const separationKeys = ['ao_judgment', 'or_effect', 'provider_outcome'];
  const separationItems = separationKeys.map((key) => {
    const id = nonEmptyString(separations[key], `required_separations.${key}`);
    assert(itemIds.has(id), `Unknown required separation item: ${id}`);
    return inventory.items.find((item) => item.id === id);
  });
  separationItems.forEach((item, index) => {
    assert(semanticLayer(item) === separationKeys[index], `Required separation item has wrong semantic layer: ${item.id}`);
  });
  assert(new Set(separationItems.map((item, index) => nonEmptyString(item.semantic_owner, `required separation ${index} semantic_owner`))).size === 3, 'AO judgment, OR effect, and provider outcome must have distinct semantic owners');
  assert(new Set(separationItems.map((item, index) => nonEmptyString(item.evidence_authority, `required separation ${index} evidence_authority`))).size === 3, 'AO judgment, OR effect, and provider outcome must have distinct evidence authorities');
  const layerItems = Object.fromEntries(separationKeys.map((key) => [
    key,
    inventory.items.filter((item) => semanticLayer(item) === key),
  ]));
  for (const key of separationKeys) assert(layerItems[key].length > 0, `Missing semantic layer: ${key}`);
  for (const [leftIndex, leftKey] of separationKeys.entries()) {
    for (const rightKey of separationKeys.slice(leftIndex + 1)) {
      for (const field of ['semantic_owner', 'evidence_authority']) {
        const leftValues = new Set(layerItems[leftKey].map((item) => nonEmptyString(item[field], `${item.id}.${field}`)));
        const overlap = layerItems[rightKey]
          .map((item) => nonEmptyString(item[field], `${item.id}.${field}`))
          .find((value) => leftValues.has(value));
        assert(overlap == null, `${leftKey} and ${rightKey} must have distinct ${field} values across every role row`);
      }
    }
  }

  const ambiguityIds = new Set();
  for (const [index, ambiguity] of inventory.ambiguities.entries()) {
    const id = nonEmptyString(ambiguity?.id, `ambiguities[${index}].id`);
    assert(!ambiguityIds.has(id), `Duplicate ambiguity: ${id}`);
    ambiguityIds.add(id);
    nonEmptyString(ambiguity.term, `ambiguities[${index}].term`);
    nonEmptyString(ambiguity.problem, `ambiguities[${index}].problem`);
    nonEmptyString(ambiguity.fail_closed_interpretation, `ambiguities[${index}].fail_closed_interpretation`);
    assert(Array.isArray(ambiguity.item_ids) && ambiguity.item_ids.length > 0, `Missing item_ids for ambiguity ${id}`);
    ambiguity.item_ids.forEach((itemId) => assert(itemIds.has(itemId), `Unknown ambiguity item: ${itemId}`));
  }

  return {
    schema_version: inventory.schema_version,
    inventory_version: inventory.inventory_version,
    item_count: inventory.items.length,
    family_counts: counts,
    ambiguity_count: inventory.ambiguities.length,
    digest: trajectoryVocabularyDigest(inventory),
  };
}

export function validateTrajectoryFixture(fixture, inventory) {
  assert(fixture?.schema_version === TRAJECTORY_FIXTURE_SCHEMA_VERSION, 'Unsupported trajectory fixture schema');
  const scenario = nonEmptyString(fixture.scenario, 'fixture.scenario');
  assert(['success', 'failure', 'missing_evidence', 'replay'].includes(scenario), `Unsupported fixture scenario: ${scenario}`);
  assert(Array.isArray(fixture.expectations) && fixture.expectations.length > 0, `Missing expectations for ${scenario}`);
  const itemMap = new Map(inventory.items.map((item) => [item.id, item]));
  const coveredFamilies = new Set();

  for (const [index, expectation] of fixture.expectations.entries()) {
    const itemId = nonEmptyString(expectation?.item_id, `fixture.expectations[${index}].item_id`);
    const item = itemMap.get(itemId);
    assert(item, `Unknown fixture item: ${itemId}`);
    assert(item.values.includes(expectation.value), `Unsupported value ${expectation.value} for ${itemId}`);
    coveredFamilies.add(item.family);
  }

  for (const family of REQUIRED_TRAJECTORY_FAMILIES) {
    assert(coveredFamilies.has(family), `Fixture ${scenario} does not cover ${family}`);
  }
  if (scenario === 'missing_evidence') {
    assert(fixture.evidence_complete === false, 'Missing-evidence fixture must be incomplete');
  } else {
    assert(fixture.evidence_complete === true, `${scenario} fixture must have complete evidence`);
  }
  if (scenario === 'replay') {
    nonEmptyString(fixture.replay_of, 'fixture.replay_of');
  }

  const releaseVocabularyVersion = fixture.release_vocabulary_version == null
    ? null
    : nonEmptyString(fixture.release_vocabulary_version, 'fixture.release_vocabulary_version');
  const supportedReleaseVocabularyVersions = [
    'ao.lifecycle.v1alpha1',
    'ao.release-judgment.v1',
  ];
  if (releaseVocabularyVersion != null) {
    assert(
      supportedReleaseVocabularyVersions.includes(releaseVocabularyVersion),
      `Unsupported release vocabulary version: ${releaseVocabularyVersion}`,
    );
  }
  const releaseExpectation = fixture.expectations.find((expectation) => (
    expectation.item_id === 'lifecycle.release_disposition'
  ));
  if (releaseExpectation?.value === 'notify_human_ready') {
    assert(
      releaseVocabularyVersion === 'ao.lifecycle.v1alpha1',
      'notify_human_ready projection requires ao.lifecycle.v1alpha1',
    );
  }
  if (releaseExpectation?.value === 'release_ready') {
    assert(
      releaseVocabularyVersion === 'ao.release-judgment.v1',
      'release_ready projection requires ao.release-judgment.v1',
    );
  }

  const canonicalExpectations = fixture.expectations.map((expectation) => {
    if (
      releaseVocabularyVersion === 'ao.lifecycle.v1alpha1'
      && expectation.item_id === 'lifecycle.release_disposition'
      && expectation.value === 'notify_human_ready'
    ) {
      return { ...expectation, value: 'release_ready' };
    }
    return expectation;
  });

  return {
    scenario,
    release_vocabulary_version: releaseVocabularyVersion,
    expectation_count: fixture.expectations.length,
    family_count: coveredFamilies.size,
    projection_digest: createHash('sha256')
      .update(JSON.stringify(canonicalJson(canonicalExpectations)))
      .digest('hex'),
  };
}

export function validateTrajectoryFixtureSet(fixtures, inventory) {
  assert(Array.isArray(fixtures), 'Fixture set must be an array');
  assert(fixtures.length === 4, 'Fixture set must contain exactly four scenarios');
  const scenarioNames = fixtures.map((fixture) => nonEmptyString(fixture?.scenario, 'fixture.scenario'));
  assert(new Set(scenarioNames).size === scenarioNames.length, 'Duplicate fixture scenario');
  const reports = fixtures.map((fixture) => validateTrajectoryFixture(fixture, inventory));
  const byScenario = new Map(fixtures.map((fixture, index) => [fixture.scenario, {
    fixture,
    report: reports[index],
  }]));
  const requiredScenarios = ['failure', 'missing_evidence', 'replay', 'success'];
  assert(
    JSON.stringify([...byScenario.keys()].sort()) === JSON.stringify(requiredScenarios),
    `Fixture scenarios must be exactly: ${requiredScenarios.join(', ')}`,
  );

  const replay = byScenario.get('replay');
  const replayTarget = byScenario.get(replay.fixture.replay_of);
  assert(replayTarget != null && replay.fixture.replay_of !== 'replay', `Unknown replay target: ${replay.fixture.replay_of}`);
  assert(
    replay.report.projection_digest === replayTarget.report.projection_digest,
    `Replay projection differs from ${replay.fixture.replay_of}`,
  );
  return reports;
}

export function loadTrajectoryVocabulary(inventoryPath) {
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
}
