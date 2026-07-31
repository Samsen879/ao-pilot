#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  loadAoStateReport,
} from './ao/lib/state-runner.js';
import { renderAoStateHumanSummary } from './ao/lib/state-report.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1] ?? null;
  if (value == null || value.startsWith('-')) {
    throw new Error(`Missing value for ${optionName}`);
  }

  return value;
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    auditLimit: 5,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      try {
        options.projectId = readOptionValue(argv, index, '--project');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--audit-limit') {
      const value = argv[index + 1] ?? null;
      options.auditLimit = value == null ? null : Number(value);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}`,
      };
    }
  }

  if (options.projectId == null || String(options.projectId).trim() === '') {
    return {
      ok: false,
      error: 'Missing value for --project',
    };
  }

  if (!Number.isInteger(options.auditLimit) || options.auditLimit <= 0) {
    return {
      ok: false,
      error: 'Invalid value for --audit-limit',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-state.js [options]',
    '',
    'Options:',
    '  --project <project_id>   AO project id. Default: my-project',
    '  --audit-limit <number>  Number of recent audit entries to include. Default: 5',
    '  --json                  Print machine-readable JSON output',
    '  -h, --help              Show help',
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
} = {}) {
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

  try {
    const report = await loadAoStateReport({
      cwd,
      projectId: options.projectId,
      auditLimit: options.auditLimit,
    });

    if (options.json) {
      io.writeStdout(JSON.stringify(report, null, 2));
    } else {
      io.writeStdout(`${renderAoStateHumanSummary(report)}\n`);
    }

    return {
      exitCode: 0,
      report,
    };
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return {
      exitCode: 3,
      report: null,
    };
  }
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
