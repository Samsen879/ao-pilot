#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { findRepoRoot } from './ao/lib/repo-root.js';
import {
  prepareWorkerWorktree,
  WORKER_PREPARATION_EXIT_CODES,
} from './ao/lib/worker-worktree-preparation.js';

export function runCli(argv, io = {
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
}, { cwd = process.cwd() } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    io.writeStdout('Usage: node scripts/prepare-worker-worktree.js [--json]\n');
    return { exitCode: 0, result: null };
  }
  if (argv.some((arg) => arg !== '--json')) {
    const result = {
      schema_version: 'ao.worker-worktree-preparation-receipt.v1',
      status: 'setup_failed',
      ready: false,
      failure_class: 'setup',
      reason_code: 'unsupported_argument',
    };
    io.writeStdout(`${JSON.stringify(result)}\n`);
    return { exitCode: WORKER_PREPARATION_EXIT_CODES.setupFailure, result };
  }

  const repoRoot = findRepoRoot(cwd);
  const result = prepareWorkerWorktree({ repoRoot });
  io.writeStdout(`${JSON.stringify(result)}\n`);
  return {
    exitCode: result.ready
      ? WORKER_PREPARATION_EXIT_CODES.ready
      : WORKER_PREPARATION_EXIT_CODES.setupFailure,
    result,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outcome = runCli(process.argv.slice(2));
  process.exitCode = outcome.exitCode;
}
