#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { releasePrerequisites } from './ao/lib/current-source-evidence.js';

try {
  const identity = releasePrerequisites(fileURLToPath(new URL('../', import.meta.url)), process.env.AO_PHASE_ZERO_EXPECTED_HEAD, process.env.AO_PHASE_ZERO_EXPECTED_TREE);
  console.log(JSON.stringify({ status: 'PASS', ...identity, scope: 'release prerequisites only' }));
} catch (error) {
  console.error(`release_prerequisites_failed: ${error.message}`);
  process.exitCode = 1;
}
