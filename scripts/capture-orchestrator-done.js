#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import { captureOrchestratorDoneEvidence } from './ao/lib/orchestrator-done-evidence.js';

function usage() {
  return 'Usage: npm run capture:orchestrator-done -- --runtime-binary <absolute-path> --orchestrator-session-id <id> --out <path>';
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? null : argv[index + 1];
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const runtimeBinary = option(argv, '--runtime-binary');
  const orchestratorSessionId = option(argv, '--orchestrator-session-id');
  const outputPath = option(argv, '--out');
  if ([runtimeBinary, orchestratorSessionId, outputPath].some((value) => value == null || value.startsWith('-')) || argv.length !== 6) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const evidence = captureOrchestratorDoneEvidence({ runtimeBinary, orchestratorSessionId });
      fs.writeFileSync(path.resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'orchestrator_done_capture_failed', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
