#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTrajectoryVocabulary } from './ao/lib/trajectory-vocabulary.js';
import {
  buildFalseSuccessAuditReport,
  loadFalseSuccessFixturePack,
  stableDigest,
} from './ao/lib/false-success-trajectory-audit.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(repositoryRoot, 'docs/foundation/trajectory-vocabulary.v1.json');
const packPath = path.join(repositoryRoot, 'tests/ao/fixtures/false-success-trajectories/pack.v1.json');
const reportPath = path.join(repositoryRoot, 'docs/foundation/false-success-trajectory-audit.v1.json');
const check = process.argv.includes('--check');

try {
  const inventory = loadTrajectoryVocabulary(inventoryPath);
  const pack = loadFalseSuccessFixturePack(packPath);
  const first = buildFalseSuccessAuditReport(pack, inventory);
  const second = buildFalseSuccessAuditReport(
    JSON.parse(JSON.stringify(pack)),
    JSON.parse(JSON.stringify(inventory)),
  );
  if (stableDigest(first) !== stableDigest(second)) {
    throw new Error('Double replay produced unstable audit fingerprints');
  }
  const serialized = `${JSON.stringify(first, null, 2)}\n`;
  if (check) {
    if (!fs.existsSync(reportPath) || fs.readFileSync(reportPath, 'utf8') !== serialized) {
      throw new Error('Committed false-success audit report is stale; run npm run audit:false-success');
    }
  } else {
    fs.writeFileSync(reportPath, serialized);
  }
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    mode: check ? 'check' : 'write',
    report_fingerprint: first.report_fingerprint,
    ...first.summary,
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`false_success_trajectory_audit_failed: ${error.message}\n`);
  process.exitCode = 1;
}
