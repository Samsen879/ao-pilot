#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadTrajectoryVocabulary,
  validateTrajectoryFixture,
  validateTrajectoryVocabulary,
} from './ao/lib/trajectory-vocabulary.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(repositoryRoot, 'docs/foundation/trajectory-vocabulary.v1.json');
const fixtureDirectory = path.join(repositoryRoot, 'tests/ao/fixtures/trajectory-vocabulary');

try {
  const inventory = loadTrajectoryVocabulary(inventoryPath);
  const inventoryReport = validateTrajectoryVocabulary(inventory, { repositoryRoot });
  const fixtureReports = fs.readdirSync(fixtureDirectory)
    .filter((entry) => entry.endsWith('.json'))
    .sort()
    .map((entry) => validateTrajectoryFixture(
      JSON.parse(fs.readFileSync(path.join(fixtureDirectory, entry), 'utf8')),
      inventory,
    ));
  const scenarios = fixtureReports.map((report) => report.scenario).sort();
  const requiredScenarios = ['failure', 'missing_evidence', 'replay', 'success'];
  if (JSON.stringify(scenarios) !== JSON.stringify(requiredScenarios)) {
    throw new Error(`Fixture scenarios must be exactly: ${requiredScenarios.join(', ')}`);
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    inventory: inventoryReport,
    fixtures: fixtureReports,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`trajectory_vocabulary_invalid: ${error.message}\n`);
  process.exitCode = 1;
}
