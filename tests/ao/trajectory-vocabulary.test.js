import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTrajectoryVocabulary,
  trajectoryVocabularyDigest,
  validateTrajectoryFixture,
  validateTrajectoryVocabulary,
} from '../../scripts/ao/lib/trajectory-vocabulary.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inventoryPath = path.join(repositoryRoot, 'docs/foundation/trajectory-vocabulary.v1.json');
const fixtureDirectory = path.join(repositoryRoot, 'tests/ao/fixtures/trajectory-vocabulary');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDirectory, `${name}.json`), 'utf8'));
}

describe('trajectory vocabulary inventory', () => {
  const inventory = loadTrajectoryVocabulary(inventoryPath);

  it('covers every required family with source symbols, callers, owners, and authorities', () => {
    const report = validateTrajectoryVocabulary(inventory, { repositoryRoot });

    expect(report.item_count).toBeGreaterThanOrEqual(30);
    expect(report.family_counts).toEqual(expect.objectContaining({
      action: expect.any(Number),
      execution_receipt: expect.any(Number),
      lifecycle_disposition: expect.any(Number),
      review_verdict: expect.any(Number),
      ci_state: expect.any(Number),
      merge_observation: expect.any(Number),
      checkpoint: expect.any(Number),
    }));
    expect(report.ambiguity_count).toBeGreaterThanOrEqual(5);
  });

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['missing-evidence', 'missing_evidence'],
  ])('validates the %s fixture against declared vocabulary', (fixtureName, scenario) => {
    expect(validateTrajectoryFixture(loadFixture(fixtureName), inventory)).toEqual(expect.objectContaining({
      scenario,
      family_count: 7,
    }));
  });

  it('replays deterministically without changing the semantic projection', () => {
    const firstInventoryDigest = trajectoryVocabularyDigest(inventory);
    const secondInventoryDigest = trajectoryVocabularyDigest(JSON.parse(JSON.stringify(inventory)));
    const success = validateTrajectoryFixture(loadFixture('success'), inventory);
    const replay = validateTrajectoryFixture(loadFixture('replay'), inventory);

    expect(secondInventoryDigest).toBe(firstInventoryDigest);
    expect(replay.projection_digest).toBe(success.projection_digest);
  });

  it('fails closed when semantic ownership or source evidence is missing', () => {
    const missingOwner = structuredClone(inventory);
    missingOwner.items[0].semantic_owner = '';
    expect(() => validateTrajectoryVocabulary(missingOwner, { repositoryRoot }))
      .toThrow('Missing items[0].semantic_owner');

    const missingSymbol = structuredClone(inventory);
    missingSymbol.references.action_templates.symbol = 'symbol_that_does_not_exist';
    expect(() => validateTrajectoryVocabulary(missingSymbol, { repositoryRoot }))
      .toThrow('Missing items[0].source symbol');
  });
});
