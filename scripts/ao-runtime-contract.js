#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveRuntimeControl,
  runResolvedRuntime,
} from './ao/lib/runtime-control.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

export function parseRuntimeContractArgs(argv) {
  const options = { json: false, storeRoot: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--runtime-store') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('-')) throw new Error('Missing value for --runtime-store');
      options.storeRoot = path.resolve(value);
      index += 1;
    } else throw new Error(`Unknown argument for runtime-contract: ${argument}`);
  }
  return options;
}

function probe(runtime, args, { cwd, env, executeRuntime }) {
  const execution = executeRuntime(runtime, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    exit_code: execution.result.status,
    stdout: execution.result.stdout,
    stderr: execution.result.stderr,
    error_code: execution.result.error_code ?? null,
  };
}

export function buildRuntimeContract(runtime, probes) {
  const statusHelp = probes.status_help.stdout;
  const projectGetHelp = probes.project_get_help.stdout;
  const spawnHelp = probes.spawn_help.stdout;
  const checks = {
    version_probe_passed: probes.version.exit_code === 0 && probes.version.stdout.trim() !== '',
    global_status_json_supported: probes.status_help.exit_code === 0 && statusHelp.includes('--json'),
    status_project_flag_absent: probes.status_help.exit_code === 0
      && !/(^|\s)(--project|-p)(?:\s|,|$)/m.test(statusHelp),
    project_get_json_supported: probes.project_get_help.exit_code === 0
      && projectGetHelp.includes('project get <id>')
      && projectGetHelp.includes('--json'),
    spawn_attempt_custody_supported: probes.spawn_help.exit_code === 0
      && spawnHelp.includes('--attempt-id'),
  };
  const passed = Object.values(checks).every(Boolean);
  return {
    schema_version: 'ao.installed-runtime-cli-contract.v1',
    status: passed ? 'passed' : 'hold',
    runtime: {
      runtime_ref: runtime.runtime_ref,
      lock_digest: runtime.lock_digest,
      binary_path: runtime.binary_path,
      binary_sha256: runtime.binary_sha256,
      source: runtime.source,
    },
    launcher: {
      worker_command: 'ao',
      environment_binding: 'AO_MANAGED_RUNTIME_BINARY',
      resolved_binary_path: runtime.binary_path,
    },
    commands: {
      capability_probe: ['ao', '--version'],
      global_status: ['ao', 'status', '--json'],
      project_readback: ['ao', 'project', 'get', '<project-id>', '--json'],
      spawn_help: ['ao', 'spawn', '--help'],
    },
    checks,
    observed_version: probes.version.stdout.trim(),
    probe_exit_codes: Object.fromEntries(
      Object.entries(probes).map(([name, value]) => [name, value.exit_code]),
    ),
  };
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
  env = process.env,
  resolveRuntime = resolveRuntimeControl,
  executeRuntime = runResolvedRuntime,
} = {}) {
  let options;
  try {
    options = parseRuntimeContractArgs(argv);
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return { exitCode: 4, report: null };
  }
  if (options.help) {
    io.writeStdout('Usage: ao-pilot runtime-contract [--runtime-store <path>] [--json]\n');
    return { exitCode: 0, report: null };
  }

  let runtime;
  try {
    runtime = resolveRuntime({ cwd, env, storeRoot: options.storeRoot });
  } catch (error) {
    const report = {
      schema_version: 'ao.installed-runtime-cli-contract.v1',
      status: 'hold',
      code: error.code ?? 'runtime_verification_failed',
      message: error.message,
    };
    io.writeStderr(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
    return { exitCode: 2, report };
  }

  const probes = {
    version: probe(runtime, ['--version'], { cwd, env, executeRuntime }),
    status_help: probe(runtime, ['status', '--help'], { cwd, env, executeRuntime }),
    project_get_help: probe(runtime, ['project', 'get', '--help'], { cwd, env, executeRuntime }),
    spawn_help: probe(runtime, ['spawn', '--help'], { cwd, env, executeRuntime }),
  };
  const report = buildRuntimeContract(runtime, probes);
  io.writeStdout(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
  return { exitCode: report.status === 'passed' ? 0 : 3, report };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
