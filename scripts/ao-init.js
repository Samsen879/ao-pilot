#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AO_CONFIG_FILENAME,
  DEFAULT_AO_CONFIG,
  serializeAoConfig,
} from './ao/lib/config.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_AO_CONFIG.project_id,
    configPath: AO_CONFIG_FILENAME,
    force: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.projectId = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--config') {
      options.configPath = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (options.help) return { ok: true, options };
  if (typeof options.projectId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(options.projectId)) {
    return { ok: false, error: 'Invalid value for --project' };
  }
  if (typeof options.configPath !== 'string' || options.configPath.trim() === '') {
    return { ok: false, error: 'Missing value for --config' };
  }

  return { ok: true, options };
}

function renderHelp() {
  return [
    'Usage: ao-pilot init [options]',
    '',
    'Options:',
    '  --project <project_id>  Project id. Default: my-project',
    '  --config <path>         Config path. Default: ao.config.json',
    '  --force                 Replace an existing config file',
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
    return { exitCode: 4, result: null };
  }

  const { options } = parsed;
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return { exitCode: 0, result: null };
  }

  const configPath = path.resolve(cwd, options.configPath);
  if (fs.existsSync(configPath) && !options.force) {
    io.writeStderr(`AO configuration already exists: ${configPath}\n`);
    return { exitCode: 4, result: null };
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, serializeAoConfig({
    ...DEFAULT_AO_CONFIG,
    project_id: options.projectId,
  }), 'utf8');

  const result = {
    config_path: configPath,
    project_id: options.projectId,
    created: true,
  };
  io.writeStdout(options.json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `Created AO configuration: ${configPath}\n`);
  return { exitCode: 0, result };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
