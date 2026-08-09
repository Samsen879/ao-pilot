#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadPhaseZeroEvidence,
  readGitIdentity,
  replayPhaseZeroEvidence,
} from './ao/lib/phase-zero-exit-evidence.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

try {
  const bundle = loadPhaseZeroEvidence(repositoryRoot);
  const first = replayPhaseZeroEvidence(bundle, { repositoryRoot });
  const second = replayPhaseZeroEvidence(structuredClone(bundle), { repositoryRoot });
  if (JSON.stringify(first.receipt) !== JSON.stringify(second.receipt)) throw new Error('Phase 0 receipt replay drifted');
  const expected = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'docs/foundation/phase-zero-exit-replay-receipt.v1.json'), 'utf8'));
  if (JSON.stringify(first.receipt) !== JSON.stringify(expected)) throw new Error('Phase 0 receipt drifted from committed evidence');
  const expectedHead = option('--expected-head');
  const expectedTree = option('--expected-tree');
  if (!/^[0-9a-f]{40}$/.test(expectedHead ?? '')) throw new Error('--expected-head is required and must be an exact Git SHA');
  if (!/^[0-9a-f]{40}$/.test(expectedTree ?? '')) throw new Error('--expected-tree is required and must be an exact Git tree SHA');
  const gitIdentity = readGitIdentity(repositoryRoot);
  if (gitIdentity.head_sha !== expectedHead) throw new Error('Live Git HEAD does not match --expected-head');
  if (gitIdentity.tree_sha !== expectedTree) throw new Error('Live Git tree does not match --expected-tree');
  process.stdout.write(`${JSON.stringify({
    ...first.receipt,
    execution_binding: {
      ...gitIdentity,
      expected_head_sha: expectedHead,
      expected_tree_sha: expectedTree,
      merge_claim: false,
    },
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`phase_zero_exit_verification_failed: ${error.message}\n`);
  process.exitCode = 1;
}
