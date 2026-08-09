#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPhaseZeroEvidence,
  replayPhaseZeroEvidence,
} from './ao/lib/phase-zero-exit-evidence.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const bundle = loadPhaseZeroEvidence(repositoryRoot);
  const first = replayPhaseZeroEvidence(bundle, { repositoryRoot });
  const second = replayPhaseZeroEvidence(structuredClone(bundle), { repositoryRoot });
  if (JSON.stringify(first.receipt) !== JSON.stringify(second.receipt)) throw new Error('Phase 0 receipt replay drifted');
  const expected = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/foundation/phase-zero-exit-replay-receipt.v1.json'), 'utf8'));
  if (JSON.stringify(first.receipt) !== JSON.stringify(expected)) throw new Error('Phase 0 receipt drifted from committed evidence');
  process.stdout.write(`${JSON.stringify(first.receipt, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`phase_zero_exit_verification_failed: ${error.message}\n`);
  process.exitCode = 1;
}
