#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { captureWorktreeEvidence } from './ao/lib/worktree-evidence.js';

function usage() {
  return 'Usage: npm run capture:self-hosting-worktree -- --source-root <path> --worker-root <path> --worker-session-id <id> --out <path>';
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const sourceRoot = option(argv, '--source-root');
  const workerRoot = option(argv, '--worker-root');
  const workerSessionId = option(argv, '--worker-session-id');
  const outputPath = option(argv, '--out');
  if ([sourceRoot, workerRoot, workerSessionId, outputPath].some((value) => value == null || value.startsWith('-')) || argv.length !== 8) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const evidence = captureWorktreeEvidence({ sourceRoot, workerRoot, workerSessionId });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'worktree_evidence_capture_failed', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
