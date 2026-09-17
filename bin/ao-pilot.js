#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAoConfig,
} from '../scripts/ao/lib/config.js';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

const COMMAND_MODULES = {
  controller: '../scripts/ao-controller.js',
  dashboard: '../scripts/ao-dashboard.js',
  doctor: '../scripts/ao-doctor.js',
  eval: '../scripts/ao-eval.js',
  execution: '../scripts/ao-execution.js',
  handoff: '../scripts/ao-handoff.js',
  init: '../scripts/ao-init.js',
  knowledge: '../scripts/ao-knowledge.js',
  lifecycle: '../scripts/ao-lifecycle.js',
  manage: '../scripts/ao-manage.js',
  metrics: '../scripts/ao-metrics.js',
  override: '../scripts/ao-override.js',
  'publication-preflight': '../scripts/ao-publication-preflight.js',
  reconcile: '../scripts/ao-reconcile.js',
  review: '../scripts/ao-review.js',
  session: '../scripts/ao-session.js',
  'runtime-path': '../scripts/ao-runtime.js',
  'runtime-project-get': '../scripts/ao-runtime.js',
  'runtime-contract': '../scripts/ao-runtime-contract.js',
  start: '../scripts/ao-runtime.js',
  state: '../scripts/ao-state.js',
  status: '../scripts/ao-runtime.js',
  stop: '../scripts/ao-runtime.js',
};

const RUNTIME_COMMANDS = new Set(['runtime-path', 'runtime-project-get', 'start', 'status', 'stop']);

const PROJECT_SCOPED_COMMANDS = new Set(Object.keys(COMMAND_MODULES).filter(
  (command) => ![
    'init',
    'publication-preflight',
    'dashboard',
    'execution',
    'runtime-path',
    'runtime-project-get',
    'runtime-contract',
    'start',
    'status',
    'stop',
  ].includes(command),
));
const PR_EXCLUSIVE_COMMANDS = new Set(['doctor', 'lifecycle', 'reconcile']);

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function renderHelp() {
  return [
    'Usage: ao-pilot <command> [options]',
    '',
    'Commands:',
    '  init        Create ao.config.json',
    '  controller  Run the control loop',
    '  doctor      Diagnose control-plane, runtime, and auth state',
    '  start       Start the verified managed runtime daemon',
    '  dashboard   Serve the localhost-only browser Dashboard',
    '  stop        Stop the verified managed runtime daemon',
    '  status      Inspect verified managed runtime daemon status',
    '  runtime-path Inspect exact runtime provenance and binary path',
    '  runtime-project-get Read one project through the exact managed runtime',
    '  runtime-contract Probe the installed AO CLI and emit its supported command contract',
    '  reconcile   Reconcile AO and source-control observations',
    '  lifecycle   Evaluate lifecycle readiness',
    '              serve/recover/status: pinned original-session recovery',
    '  session     List, bind, restore, or message migrated sessions',
    '  manage      Manage durable tasks',
    '  handoff     Manage successor handoffs',
    '  review      Manage independent review records',
    '  state       Inspect durable state',
    '  override    Manage explicit operator overrides',
    '  publication-preflight Diagnose Git publication identity and credentials',
    '  knowledge   Inspect repository knowledge',
    '  metrics     Inspect run metrics',
    '  eval        Run evaluation packs',
    '  execution   Inspect enrolled durable command evidence',
    '',
    'Global options:',
    '  --config <path>  Use an explicit AO config file',
    '  -h, --help       Show help',
    '  -v, --version    Show version',
  ].join('\n');
}

function extractConfigOption(argv) {
  const remaining = [];
  let configPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--config') {
      remaining.push(argv[index]);
      continue;
    }
    const value = argv[index + 1] ?? null;
    if (value == null || value.startsWith('-')) {
      throw new Error('Missing value for --config');
    }
    configPath = value;
    index += 1;
  }

  return { configPath, argv: remaining };
}

export function applyConfiguredProject(command, argv, projectId) {
  if (!PROJECT_SCOPED_COMMANDS.has(command) || argv.includes('--project')) return argv;
  if (PR_EXCLUSIVE_COMMANDS.has(command) && argv.includes('--pr')) return argv;
  return [...argv, '--project', projectId];
}

function hasOption(argv, optionName) {
  return argv.includes(optionName);
}

export function applyConfiguredEvaluation(argv, evaluation, configPath = null) {
  const effectiveArgs = [...argv];
  if (
    evaluation?.fixture_root != null
      && !hasOption(effectiveArgs, '--fixture-root')
  ) {
    const configDirectory = configPath == null
      ? process.cwd()
      : path.dirname(configPath);
    effectiveArgs.push(
      '--fixture-root',
      path.resolve(configDirectory, evaluation.fixture_root),
    );
  }
  if (!hasOption(effectiveArgs, '--pack')) {
    for (const packName of evaluation?.packs ?? ['all']) {
      effectiveArgs.push('--pack', packName);
    }
  }
  if (!hasOption(effectiveArgs, '--replay-count')) {
    effectiveArgs.push(
      '--replay-count',
      String(evaluation?.replay_count ?? 2),
    );
  }
  return effectiveArgs;
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
} = {}) {
  const [command, ...commandArgs] = argv;
  if (command == null || command === '--help' || command === '-h') {
    io.writeStdout(`${renderHelp()}\n`);
    return { exitCode: 0, result: null };
  }
  if (command === '--version' || command === '-v') {
    io.writeStdout(`${PACKAGE_VERSION}\n`);
    return { exitCode: 0, result: null };
  }
  if (!(command in COMMAND_MODULES)) {
    io.writeStderr(`Unknown command: ${command}\n`);
    return { exitCode: 4, result: null };
  }

  let extracted;
  try {
    extracted = extractConfigOption(commandArgs);
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return { exitCode: 4, result: null };
  }

  const commandModule = await import(COMMAND_MODULES[command]);
  if (command === 'session' || (command === 'lifecycle' && ['serve', 'recover', 'status'].includes(extracted.argv[0]))) {
    const recoveryModule = command === 'session' ? commandModule : await import('../scripts/ao-session.js');
    return recoveryModule.runCli([...extracted.argv, ...(extracted.configPath ? ['--config', extracted.configPath] : [])], io, { cwd });
  }
  if (command === 'init') {
    const initArgs = extracted.configPath == null
      ? extracted.argv
      : [...extracted.argv, '--config', extracted.configPath];
    return commandModule.runCli(initArgs, io, { cwd });
  }
  if (command === 'publication-preflight' || command === 'dashboard' || command === 'execution' || command === 'runtime-contract' || RUNTIME_COMMANDS.has(command)) {
    const delegatedArgs = RUNTIME_COMMANDS.has(command)
      ? [command, ...extracted.argv]
      : extracted.argv;
    return commandModule.runCli(delegatedArgs, io, { cwd });
  }

  let loadedConfig;
  try {
    loadedConfig = loadAoConfig({
      cwd,
      configPath: extracted.configPath,
    });
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return { exitCode: 4, result: null };
  }

  let effectiveArgs = applyConfiguredProject(
    command,
    extracted.argv,
    loadedConfig.config.project_id,
  );
  if (command === 'eval') {
    effectiveArgs = applyConfiguredEvaluation(
      effectiveArgs,
      loadedConfig.config.evaluation,
      loadedConfig.path,
    );
  }
  return commandModule.runCli(effectiveArgs, io, {
    cwd,
    defaultProjectId: loadedConfig.config.project_id,
  });
}

export function isDirectExecution(executedFile, currentFile) {
  if (!executedFile) return false;
  const absoluteExecutedFile = path.resolve(executedFile);
  const resolvedExecutedFile = fs.existsSync(absoluteExecutedFile)
    ? fs.realpathSync(absoluteExecutedFile)
    : absoluteExecutedFile;
  return resolvedExecutedFile === currentFile;
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (isDirectExecution(executedFile, currentFile)) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
