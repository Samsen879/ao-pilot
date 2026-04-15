#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  runReconciliation,
} from './ao/lib/reconciliation-runner.js';
import { buildDecisionChainReport } from './ao/lib/decision-chain.js';
import { createDecisionChainScope } from './ao/lib/decision-chain-contracts.js';
import { renderHumanSummary } from './ao/lib/reconciliation-report.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    prNumber: null,
    json: false,
    strict: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.projectId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--pr') {
      const value = argv[index + 1] ?? null;
      options.prNumber = value == null ? null : Number(value);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}`,
      };
    }
  }

  if (options.projectId == null || options.projectId === '') {
    return {
      ok: false,
      error: 'Missing value for --project',
    };
  }

  if (options.prNumber != null && (!Number.isInteger(options.prNumber) || options.prNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --pr',
    };
  }

  if (options.strict && options.prNumber == null) {
    return {
      ok: false,
      error: 'Strict mode requires --pr <number>',
    };
  }

  return {
    ok: true,
    options,
  };
}

function exitCodeForReport(report, strict) {
  if (strict) {
    if (report.top_status === 'healthy') return 0;
    if (report.top_status === 'warning') return 10;
    if (report.top_status === 'blocked') return 11;
    if (report.top_status === 'ambiguous') return 12;
    if (report.top_status === 'source_failure') return 13;
    return 14;
  }

  if (report.top_status === 'source_failure') return 3;
  return 0;
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-reconcile.js [options]',
    '',
    'Options:',
    '  --project <project_id>   AO project id. Default: my-project',
    '  --pr <number>            Reconcile one PR in authoritative automation mode',
    '  --json                   Print machine-readable JSON output',
    '  --strict                 Use fixed automation exit-code mapping; requires --pr <number>',
    '  -h, --help               Show help',
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo()) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: 4,
      report: null,
    };
  }

  const { options } = parsed;
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return {
      exitCode: 0,
      report: null,
    };
  }

  const { report: reconciliationReport } = await runReconciliation({
    projectId: options.projectId,
    prNumber: options.prNumber,
    cwd: process.cwd(),
  });
  const report = {
    ...reconciliationReport,
    decision_chain: buildDecisionChainReport({
      scope: createDecisionChainScope({
        projectId: options.projectId,
        prNumber: options.prNumber,
      }),
      reconciliationReport,
    }),
  };

  if (options.json) {
    io.writeStdout(JSON.stringify(report, null, 2));
  } else {
    io.writeStdout(`${renderHumanSummary(report)}\n`);
  }

  return {
    exitCode: exitCodeForReport(report, options.strict),
    report,
  };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
