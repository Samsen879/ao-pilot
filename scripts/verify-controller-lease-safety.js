#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  digestControllerLeaseSafetyEvidence,
  loadControllerLeaseSafetyFixturePack,
  replayControllerLeaseSafetyFixturePack,
} from './ao/controller-lease-safety-evaluation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(
  repositoryRoot,
  'tests/ao/fixtures/controller-lease-safety/pack.v1.json',
);
const expectedReceiptPath = path.join(
  repositoryRoot,
  'docs/foundation/controller-lease-safety-verification.v1.json',
);

try {
  const pack = loadControllerLeaseSafetyFixturePack(fixturePath);
  const { receipt } = await replayControllerLeaseSafetyFixturePack(pack);
  const expectedReceipt = JSON.parse(fs.readFileSync(expectedReceiptPath, 'utf8'));
  if (digestControllerLeaseSafetyEvidence(receipt) !== digestControllerLeaseSafetyEvidence(expectedReceipt)) {
    throw new Error('Controller lease safety receipt drifted from the audited verification report');
  }
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`controller_lease_safety_verification_failed: ${error.message}\n`);
  process.exitCode = 1;
}
