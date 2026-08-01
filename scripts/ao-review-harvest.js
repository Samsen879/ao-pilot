#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  harvestGitHubReviewSnapshots,
  SNAPSHOT_MANIFEST_FILENAME,
} from './ao/lib/review-harvest/harvester.js';
import { replayReviewHarvest } from './ao/lib/review-harvest/normalize.js';

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
  return value;
}

export function parseArgs(argv) {
  const command = argv[0];
  if (!['network', 'replay'].includes(command)) throw new Error('First argument must be network or replay');
  const options = { command, concurrency: 2 };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--repository') options.repository = valueAfter(argv, index++, arg);
    else if (arg === '--merged-at-start') options.mergedAtStart = valueAfter(argv, index++, arg);
    else if (arg === '--merged-at-end-exclusive') options.mergedAtEndExclusive = valueAfter(argv, index++, arg);
    else if (arg === '--expected-pr-count') options.expectedPrCount = Number(valueAfter(argv, index++, arg));
    else if (arg === '--output') options.outputDir = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--manifest') options.manifestPath = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--concurrency') options.concurrency = Number(valueAfter(argv, index++, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!options.outputDir) throw new Error('--output is required');
  if (command === 'network') {
    for (const name of ['repository', 'mergedAtStart', 'mergedAtEndExclusive']) {
      if (!options[name]) throw new Error(`--${name.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`);
    }
    if (!Number.isInteger(options.expectedPrCount)) throw new Error('--expected-pr-count must be an integer');
  } else if (!options.manifestPath) {
    throw new Error('--manifest is required');
  }
  return options;
}

export async function runCli(argv, io = process) {
  try {
    const options = parseArgs(argv);
    if (options.command === 'network') {
      const manifest = await harvestGitHubReviewSnapshots(options);
      const replay = replayReviewHarvest({
        manifestPath: path.join(options.outputDir, SNAPSHOT_MANIFEST_FILENAME),
        outputDir: options.outputDir,
      });
      io.stdout.write(`${JSON.stringify({
        status: 'complete',
        enumerated_pr_count: manifest.enumerated_pr_count,
        network_request_count: manifest.run_receipt.network_request_count,
        raw_snapshot: manifest.raw_snapshot,
        replay_digests: replay.digests,
      }, null, 2)}\n`);
      return 0;
    }
    const replay = replayReviewHarvest(options);
    io.stdout.write(`${JSON.stringify({ status: 'complete', replay_digests: replay.digests }, null, 2)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${error.stack ?? error.message}\n`);
    return 1;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) process.exitCode = await runCli(process.argv.slice(2));
