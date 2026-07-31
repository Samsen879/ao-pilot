#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  loadAoMetricsReport,
  renderAoMetricsHumanSummary,
} from './ao/lib/run-metrics.js';

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
    traceLimit: 5,
    since: null,
    until: null,
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
    } else if (arg === '--limit') {
      const value = argv[index + 1] ?? null;
      options.traceLimit = value == null ? null : Number(value);
      index += 1;
    } else if (arg === '--since') {
      try {
        options.since = readOptionValue(argv, index, '--since');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--until') {
      try {
        options.until = readOptionValue(argv, index, '--until');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
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

  if (!Number.isInteger(options.traceLimit) || options.traceLimit <= 0) {
    return {
      ok: false,
      error: 'Invalid value for --limit',
    };
  }
  const sinceTimestamp = options.since == null ? null : Date.parse(options.since);
  const untilTimestamp = options.until == null ? null : Date.parse(options.until);
  if (options.since != null && Number.isNaN(sinceTimestamp)) {
    return { ok: false, error: 'Invalid value for --since' };
  }
  if (options.until != null && Number.isNaN(untilTimestamp)) {
    return { ok: false, error: 'Invalid value for --until' };
  }
  if (sinceTimestamp != null && untilTimestamp != null && sinceTimestamp > untilTimestamp) {
    return { ok: false, error: 'Invalid metrics window: --since is after --until' };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-metrics.js [options]',
    '',
    'Options:',
    '  --project <project_id>   AO project id. Default: my-project',
    '  --limit <number>         Number of recent traces to include. Default: 5',
    '  --since <timestamp>      Include measurements at or after this timestamp',
    '  --until <timestamp>      Include measurements at or before this timestamp',
    '  --json                   Print machine-readable JSON output',
    '  -h, --help               Show help',
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
    const report = await loadAoMetricsReport({
      cwd,
      projectId: options.projectId,
      traceLimit: options.traceLimit,
      since: options.since,
      until: options.until,
    });

    if (options.json) {
      io.writeStdout(JSON.stringify(report, null, 2));
    } else {
      io.writeStdout(`${renderAoMetricsHumanSummary(report)}\n`);
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
