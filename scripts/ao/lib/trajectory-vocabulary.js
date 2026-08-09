import { createHash } from 'node:crypto';
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
  assert(!path.isAbsolute(relativePath) && !relativePath.split('/').includes('..'), `Unbounded ${label}.path`);

  if (verifySource) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    assert(fs.existsSync(absolutePath), `Missing ${label} file: ${relativePath}`);
    const source = fs.readFileSync(absolutePath, 'utf8');
    assert(source.includes(symbol), `Missing ${label} symbol ${symbol} in ${relativePath}`);
  }

  return { path: relativePath, symbol };
}

export function validateTrajectoryVocabulary(inventory, {
  repositoryRoot = process.cwd(),
  verifySource = true,
} = {}) {
  assert(inventory?.schema_version === TRAJECTORY_VOCABULARY_SCHEMA_VERSION, 'Unsupported trajectory vocabulary schema');
  nonEmptyString(inventory.inventory_version, 'inventory_version');
  nonEmptyString(inventory.baseline?.issue_body_sha, 'baseline.issue_body_sha');
  nonEmptyString(inventory.baseline?.admitted_sha, 'baseline.admitted_sha');
  nonEmptyString(inventory.baseline?.admitted_tree, 'baseline.admitted_tree');
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
    validateReference(item.source, `${prefix}.source`, repositoryRoot, {
      verifySource,
      references: inventory.references,
    });
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
  const separationItems = ['ao_judgment', 'or_effect', 'provider_outcome'].map((key) => {
    const id = nonEmptyString(separations[key], `required_separations.${key}`);
    assert(itemIds.has(id), `Unknown required separation item: ${id}`);
    return inventory.items.find((item) => item.id === id);
  });
  assert(new Set(separationItems.map((item) => item.semantic_owner)).size === 3, 'AO judgment, OR effect, and provider outcome must have distinct semantic owners');
  assert(new Set(separationItems.map((item) => item.evidence_authority)).size === 3, 'AO judgment, OR effect, and provider outcome must have distinct evidence authorities');

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
  }
  if (scenario === 'replay') {
    nonEmptyString(fixture.replay_of, 'fixture.replay_of');
  }

  return {
    scenario,
    expectation_count: fixture.expectations.length,
    family_count: coveredFamilies.size,
    projection_digest: createHash('sha256')
      .update(JSON.stringify(canonicalJson(fixture.expectations)))
      .digest('hex'),
  };
}

export function loadTrajectoryVocabulary(inventoryPath) {
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
}
