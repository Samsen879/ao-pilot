#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  runOverrideCommand,
} from './ao/lib/override-runner.js';
import { findRepoRoot } from './ao/lib/repo-root.js';

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

function parseJsonValue(rawValue) {
  try {
    return JSON.parse(rawValue);
  } catch {
    throw new Error('Invalid JSON for --value');
  }
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectId: DEFAULT_PROJECT_ID,
    overrideId: null,
    scopeKind: null,
    scopeId: null,
    overrideKind: null,
    value: {},
    status: null,
    expiresAt: null,
    createdBy: process.env.AO_SESSION_NAME ?? 'operator',
    reason: null,
    json: false,
    help: false,
  };

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (options.command == null && !arg.startsWith('-')) {
        options.command = arg;
        continue;
      }

      if (arg === '--project') {
        options.projectId = readOptionValue(argv, index, '--project');
        index += 1;
      } else if (arg === '--override') {
        options.overrideId = readOptionValue(argv, index, '--override');
        index += 1;
      } else if (arg === '--scope-kind') {
        options.scopeKind = readOptionValue(argv, index, '--scope-kind');
        index += 1;
      } else if (arg === '--scope-id') {
        options.scopeId = readOptionValue(argv, index, '--scope-id');
        index += 1;
      } else if (arg === '--kind') {
        options.overrideKind = readOptionValue(argv, index, '--kind');
        index += 1;
      } else if (arg === '--value') {
        options.value = parseJsonValue(readOptionValue(argv, index, '--value'));
        index += 1;
      } else if (arg === '--status') {
        options.status = readOptionValue(argv, index, '--status');
        index += 1;
      } else if (arg === '--expires-at') {
        options.expiresAt = readOptionValue(argv, index, '--expires-at');
        index += 1;
      } else if (arg === '--created-by') {
        options.createdBy = readOptionValue(argv, index, '--created-by');
        index += 1;
      } else if (arg === '--reason') {
        options.reason = readOptionValue(argv, index, '--reason');
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
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }

  if (options.help) {
    return {
      ok: true,
      options,
    };
  }

  if (!['create', 'list', 'clear'].includes(options.command)) {
    return {
      ok: false,
      error: `Unsupported command: ${options.command ?? 'none'}`,
    };
  }

  if (options.command === 'create' && (!options.scopeKind || !options.scopeId || !options.overrideKind)) {
    return {
      ok: false,
      error: 'create requires --scope-kind, --scope-id, and --kind',
    };
  }

  if (options.command === 'clear' && !options.overrideId) {
    return {
      ok: false,
      error: 'clear requires --override',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-override.js <command> [options]',
    '',
    'Commands:',
    '  create      Create a durable AO override',
    '  list        List durable AO overrides',
    '  clear       Clear one durable AO override',
    '',
    'Options:',
    '  --project <project_id>      AO project id. Default: my-project',
    '  --override <override_id>    Override id for clear operations',
    '  --scope-kind <kind>         Override scope kind: global|task|pr|controller',
    '  --scope-id <id>             Override scope identifier',
    '  --kind <override_kind>      Override kind, for example hold_autonomy',
    '  --value <json>              JSON payload for override value',
    '  --status <status>           Filter list results by status',
    '  --expires-at <iso>          Optional override expiry timestamp',
    '  --created-by <actor>        Actor recorded for create/clear audit entries',
    '  --reason <text>             Clear reason',
    '  --json                      Print machine-readable JSON output',
    '  -h, --help                  Show help',
  ].join('\n');
}

function renderHumanSummary(result) {
  const overrides = result.overrides ?? [];
  if (result.command === 'list') {
    return [
      `command: ${result.command}`,
      `override_count: ${overrides.length}`,
      `overrides: ${overrides.length ? overrides.map((override) => `${override.override_id}:${override.status}`).join(', ') : 'none'}`,
    ].join('\n');
  }

  return [
    `command: ${result.command}`,
    `override: ${result.override ? `${result.override.override_id}:${result.override.status}` : 'none'}`,
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo()) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: 4,
      result: null,
    };
  }

  const { options } = parsed;
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return {
      exitCode: 0,
      result: null,
    };
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    io.writeStderr(`Could not locate repo root from ${process.cwd()}\n`);
    return {
      exitCode: 3,
      result: null,
    };
  }

  try {
    const result = await runOverrideCommand({
      repoRoot,
      cwd: process.cwd(),
      projectId: options.projectId,
      command: options.command,
      overrideId: options.overrideId,
      scopeKind: options.scopeKind,
      scopeId: options.scopeId,
      overrideKind: options.overrideKind,
      value: options.value,
      status: options.status,
      expiresAt: options.expiresAt,
      createdBy: options.createdBy,
      reason: options.reason,
    });

    if (options.json) {
      io.writeStdout(JSON.stringify(result, null, 2));
    } else {
      io.writeStdout(`${renderHumanSummary(result)}\n`);
    }

    return {
      exitCode: 0,
      result,
    };
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return {
      exitCode: 3,
      result: null,
    };
  }
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
