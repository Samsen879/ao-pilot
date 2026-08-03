#!/usr/bin/env node

import { executeAndPublishTerminalMergeEvidence } from './ao/lib/terminal-merge-publication.js';

function usage() {
  return 'Usage: npm run publish:self-hosting-merge -- --premerge-comment-id <id> --premerge-payload-sha256 <sha256> --source-root <path> --worker-root <path> --worker-session-id <id> --orchestrator-session-id <id> --runtime-binary <path> --out <path> --publication-receipt-out <path>';
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const authorityOptions = {
    sourceRoot: option(argv, '--source-root'),
    workerRoot: option(argv, '--worker-root'),
    workerSessionId: option(argv, '--worker-session-id'),
    orchestratorSessionId: option(argv, '--orchestrator-session-id'),
    runtimeBinary: option(argv, '--runtime-binary'),
  };
  const options = {
    premergeCommentId: Number(option(argv, '--premerge-comment-id')),
    premergePayloadSha256: option(argv, '--premerge-payload-sha256'),
    payloadPath: option(argv, '--out'),
    publicationReceiptPath: option(argv, '--publication-receipt-out'),
    authorityOptions,
  };
  if (argv.length !== 18 || !Number.isSafeInteger(options.premergeCommentId) || options.premergeCommentId <= 0
    || [options.premergePayloadSha256, options.payloadPath, options.publicationReceiptPath, ...Object.values(authorityOptions)].some((value) => value == null || value.startsWith('-'))) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const result = executeAndPublishTerminalMergeEvidence(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'terminal_merge_publication_failed', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
