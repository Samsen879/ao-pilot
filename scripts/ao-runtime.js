#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRuntimeControl,
  runResolvedRuntime,
  startVerifiedRuntimeDaemon,
} from './ao/lib/runtime-control.js';

const OPERATIONS = new Set(['start', 'stop', 'status', 'runtime-path']);

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function usage(operation = null) {
  if (operation === 'start') return 'Usage: ao-pilot start [--runtime-store <path>] [--dry-run] [--json]';
  if (operation === 'stop') return 'Usage: ao-pilot stop [--runtime-store <path>] [--dry-run] [--json]';
  if (operation === 'status') return 'Usage: ao-pilot status [--runtime-store <path>] [--dry-run] [--json]';
  if (operation === 'runtime-path') return 'Usage: ao-pilot runtime-path [--json]';
  return 'Usage: ao-pilot <start|stop|status|runtime-path> [options]';
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('-')) throw new Error(`Missing value for ${option}`);
  return value;
}

export function parseRuntimeArgs(argv) {
  const [operation, ...args] = argv;
  if (!OPERATIONS.has(operation)) throw new Error(`Unknown runtime operation: ${operation ?? ''}`);
  const options = {
    operation,
    projectId: 'my-project',
    storeRoot: null,
    dryRun: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--project') {
      options.projectId = requiredValue(args, index, argument);
      index += 1;
    } else if (argument === '--runtime-store') {
      options.storeRoot = path.resolve(requiredValue(args, index, argument));
      index += 1;
    } else if (argument === '--dry-run' && operation !== 'runtime-path') {
      options.dryRun = true;
    } else if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument for ${operation}: ${argument}`);
    }
  }
  return options;
}

export function buildRuntimeArguments(options) {
  if (options.operation === 'start') {
    return ['daemon'];
  }
  if (options.operation === 'stop') {
    return ['stop', '--json'];
  }
  if (options.operation === 'status') {
    return ['status', '--json'];
  }
  return [];
}

function runtimeSummary(runtime) {
  return {
    runtime_ref: runtime.runtime_ref,
    lock_digest: runtime.lock_digest,
    source: runtime.source,
    binary_path: runtime.binary_path,
    binary_sha256: runtime.binary_sha256,
    bootstrap_receipt_path: runtime.bootstrap_receipt_path,
  };
}

function humanRuntimePath(runtime) {
  return [
    `runtime_status: ${runtime.status}`,
    `runtime_ref: ${runtime.runtime_ref}`,
    `runtime_repository: ${runtime.source.repository}`,
    `runtime_version: ${runtime.source.version}`,
    `runtime_commit_sha: ${runtime.source.commit_sha}`,
    `runtime_tree_sha: ${runtime.source.tree_sha}`,
    `runtime_integrity: ${runtime.source.integrity.algorithm}:${runtime.source.integrity.digest}`,
    `runtime_binary_path: ${runtime.binary_path}`,
    `runtime_binary_sha256: ${runtime.binary_sha256}`,
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
  env = process.env,
  resolveRuntime = resolveRuntimeControl,
  executeRuntime = runResolvedRuntime,
  startDaemon = startVerifiedRuntimeDaemon,
} = {}) {
  let options;
  try {
    options = parseRuntimeArgs(argv);
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return { exitCode: 4, report: null };
  }
  if (options.help) {
    io.writeStdout(`${usage(options.operation)}\n`);
    return { exitCode: 0, report: null };
  }
  let runtime;
  try {
    runtime = resolveRuntime({
      cwd,
      env,
      storeRoot: options.storeRoot,
    });
  } catch (error) {
    const failure = {
      status: 'blocked',
      operation: options.operation,
      code: error.code ?? 'runtime_verification_failed',
      message: error.message,
      details: error.details ?? {},
    };
    io.writeStderr(`${options.json ? JSON.stringify(failure, null, 2) : [
      'runtime_status: blocked',
      `code: ${failure.code}`,
      `message: ${failure.message}`,
    ].join('\n')}\n`);
    return { exitCode: 2, report: failure };
  }
  if (options.operation === 'runtime-path') {
    const report = { status: 'verified', ...runtimeSummary(runtime) };
    io.writeStdout(`${options.json ? JSON.stringify(report, null, 2) : humanRuntimePath(runtime)}\n`);
    return { exitCode: 0, report };
  }
  const runtimeArgs = buildRuntimeArguments(options);
  if (options.dryRun) {
    const report = {
      status: 'verified_dry_run',
      operation: options.operation,
      runtime: runtimeSummary(runtime),
      command: [runtime.binary_path, ...runtimeArgs],
    };
    io.writeStdout(`${options.json ? JSON.stringify(report, null, 2) : `+ ${report.command.join(' ')}`}\n`);
    return { exitCode: 0, report };
  }
  if (options.operation === 'start') {
    const result = await startDaemon(runtime, { cwd, env });
    const report = {
      status: result.status,
      operation: options.operation,
      runtime: runtimeSummary(runtime),
      command: [runtime.binary_path, ...runtimeArgs],
      exit_code: result.exit_code,
      daemon_status: result.daemon_status ?? null,
      error: result.error ?? null,
    };
    if (options.json) io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    else if (result.error) io.writeStderr(`${result.error}\n`);
    else io.writeStdout(`runtime_status: ${result.status}\n`);
    return { exitCode: result.exit_code, report };
  }
  let execution;
  try {
    execution = executeRuntime(runtime, runtimeArgs, {
      cwd,
      env,
      stdio: options.json ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
  } catch (error) {
    const failure = {
      status: 'blocked',
      operation: options.operation,
      code: error.code ?? 'runtime_execution_failed',
      message: error.message,
      details: error.details ?? {},
    };
    io.writeStderr(`${options.json ? JSON.stringify(failure, null, 2) : [
      'runtime_status: blocked',
      `code: ${failure.code}`,
      `message: ${failure.message}`,
    ].join('\n')}\n`);
    return { exitCode: 2, report: failure };
  }
  const report = {
    status: execution.result.status === 0 ? 'completed' : 'failed',
    operation: options.operation,
    runtime: runtimeSummary(execution.runtime),
    command: [execution.runtime.binary_path, ...runtimeArgs],
    exit_code: execution.result.status,
    signal: execution.result.signal,
    error: execution.result.error,
    error_code: execution.result.error_code ?? null,
    ...(options.json ? {
      output: (() => {
        try { return JSON.parse(execution.result.stdout || 'null'); } catch { return execution.result.stdout; }
      })(),
      stderr: execution.result.stderr,
    } : {}),
  };
  if (options.json) io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
  return { exitCode: execution.result.status ?? 2, report };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
