#!/usr/bin/env node

import {
  captureOrchestratorBoundWorktreeEvidence,
  publishOrchestratorBoundWorktreeEvidence,
} from './ao/lib/orchestrator-worktree-publication.js';

function usage() {
  return 'Usage: npm run publish:self-hosting-worktree -- --source-root <path> --worker-root <path> --worker-session-id <id> --orchestrator-session-id <id> --runtime-binary <path> --out <path> --publication-receipt-out <path>';
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const options = {
    sourceRoot: option(argv, '--source-root'),
    workerRoot: option(argv, '--worker-root'),
    workerSessionId: option(argv, '--worker-session-id'),
    orchestratorSessionId: option(argv, '--orchestrator-session-id'),
    runtimeBinary: option(argv, '--runtime-binary'),
  };
  const payloadPath = option(argv, '--out');
  const publicationReceiptPath = option(argv, '--publication-receipt-out');
  if ([...Object.values(options), payloadPath, publicationReceiptPath].some((value) => value == null || value.startsWith('-')) || argv.length !== 14) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const payload = captureOrchestratorBoundWorktreeEvidence(options);
      const publication = publishOrchestratorBoundWorktreeEvidence({
        payload,
        payloadPath,
        publicationReceiptPath,
      });
      process.stdout.write(`${JSON.stringify({ payload, publication }, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'orchestrator_worktree_publication_failed', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
