#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  resolveRuntimeControl,
  runResolvedRuntime,
} from './ao/lib/runtime-control.js';
import { deploymentBinding, resolveInstalledRuntimeServiceBinding } from './ao/lib/runtime-deployment.js';

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

export function inspectWorkerLauncher(runtime, env = process.env, execute = childProcess.spawnSync) {
  const home = env.HOME || os.homedir();
  const launcherPath = path.join(home, '.ao', 'bin', 'ao');
  const expectedNamespace = deploymentBinding(home);
  let available = false;
  try {
    const info = fs.lstatSync(launcherPath);
    fs.accessSync(launcherPath, fs.constants.X_OK);
    available = info.isFile() && !info.isSymbolicLink();
  } catch {
    available = false;
  }
  const validProbe = available ? execute(launcherPath, ['--version'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  }) : null;
  const mismatchedDigest = `${runtime.binary_sha256[0] === '0' ? '1' : '0'}${runtime.binary_sha256.slice(1)}`;
  const rejectionProbe = available ? execute(launcherPath, ['--version'], {
    env: {...env,AO_MANAGED_RUNTIME_BINARY_SHA256:mismatchedDigest},
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  }) : null;
  const namespaceArgs = ['status', '--json'];
  const namespaceDirectProbe = available ? execute(runtime.binary_path, namespaceArgs, {
    env: {
      ...env,
      AO_DATA_DIR: expectedNamespace.data_dir,
      AO_RUN_FILE: expectedNamespace.run_file,
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  }) : null;
  const namespaceLauncherProbe = available ? execute(launcherPath, namespaceArgs, {
    env: {
      ...env,
      AO_DATA_DIR: '/ao-invalid-ambient-data',
      AO_RUN_FILE: '/ao-invalid-ambient-run.json',
    },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000,
  }) : null;
  const namespaceForwarded = Number.isInteger(namespaceDirectProbe?.status)
    && namespaceLauncherProbe?.status === namespaceDirectProbe.status
    && String(namespaceDirectProbe.stdout ?? '') !== ''
    && String(namespaceLauncherProbe.stdout ?? '') === String(namespaceDirectProbe.stdout)
    && String(namespaceLauncherProbe.stderr ?? '') === String(namespaceDirectProbe.stderr ?? '');
  return {
    path: launcherPath,
    available,
    authenticated: validProbe?.status === 0
      && rejectionProbe?.status === 126
      && String(rejectionProbe.stderr).includes('managed AO launcher digest mismatch')
      && namespaceForwarded,
    version_probe: {
      exit_code: Number.isInteger(validProbe?.status) ? validProbe.status : null,
      stdout: String(validProbe?.stdout ?? ''),
    },
    binary_binding_matches: env.AO_MANAGED_RUNTIME_BINARY === runtime.binary_path,
    binary_digest_binding_matches: env.AO_MANAGED_RUNTIME_BINARY_SHA256 === runtime.binary_sha256,
    data_binding_matches: env.AO_MANAGED_RUNTIME_DATA_DIR === expectedNamespace.data_dir,
    run_file_binding_matches: env.AO_MANAGED_RUNTIME_RUN_FILE === expectedNamespace.run_file,
    namespace_forwarded: namespaceForwarded,
    namespace_probe: {
      exit_code: Number.isInteger(namespaceLauncherProbe?.status) ? namespaceLauncherProbe.status : null,
      stdout: String(namespaceLauncherProbe?.stdout ?? ''),
    },
  };
}

export function buildRuntimeContract(runtime, probes, launcher) {
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
    worker_launcher_available: launcher.available,
    worker_launcher_authenticated: launcher.authenticated,
    worker_launcher_version_matches: launcher.version_probe.exit_code === probes.version.exit_code
      && launcher.version_probe.stdout === probes.version.stdout,
    worker_binary_binding_matches: launcher.binary_binding_matches,
    worker_binary_digest_binding_matches: launcher.binary_digest_binding_matches,
    worker_data_binding_matches: launcher.data_binding_matches,
    worker_run_file_binding_matches: launcher.run_file_binding_matches,
    worker_namespace_forwarding_authenticated: launcher.namespace_forwarded,
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
      digest_environment_binding: 'AO_MANAGED_RUNTIME_BINARY_SHA256',
      data_environment_binding: 'AO_MANAGED_RUNTIME_DATA_DIR',
      run_file_environment_binding: 'AO_MANAGED_RUNTIME_RUN_FILE',
      resolved_binary_path: runtime.binary_path,
      launcher_path: launcher.path,
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
  inspectLauncher = inspectWorkerLauncher,
  resolveInstalledBinding = resolveInstalledRuntimeServiceBinding,
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
  let contractEnv = env;
  try {
    const bindingNames = [
      'AO_MANAGED_RUNTIME_BINARY',
      'AO_MANAGED_RUNTIME_BINARY_SHA256',
      'AO_MANAGED_RUNTIME_DATA_DIR',
      'AO_MANAGED_RUNTIME_RUN_FILE',
    ];
    if (bindingNames.every(name => !env[name])) {
      const installed = resolveInstalledBinding({home:env.HOME || os.homedir(),env});
      contractEnv = {
        ...env,
        AO_PILOT_RUNTIME_STORE: installed.store_root,
        AO_MANAGED_RUNTIME_BINARY: installed.binary_path,
        AO_MANAGED_RUNTIME_BINARY_SHA256: installed.binary_sha256,
        AO_MANAGED_RUNTIME_DATA_DIR: installed.data_dir,
        AO_MANAGED_RUNTIME_RUN_FILE: installed.run_file,
      };
      runtime = resolveRuntime({
        cwd,
        env: contractEnv,
        storeRoot: options.storeRoot ?? installed.store_root,
      });
    } else {
      runtime = resolveRuntime({ cwd, env, storeRoot: options.storeRoot });
    }
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

  let probes;
  let launcher;
  try {
    probes = {
      version: probe(runtime, ['--version'], { cwd, env:contractEnv, executeRuntime }),
      status_help: probe(runtime, ['status', '--help'], { cwd, env:contractEnv, executeRuntime }),
      project_get_help: probe(runtime, ['project', 'get', '--help'], { cwd, env:contractEnv, executeRuntime }),
      spawn_help: probe(runtime, ['spawn', '--help'], { cwd, env:contractEnv, executeRuntime }),
    };
    launcher = inspectLauncher(runtime, contractEnv);
  } catch (error) {
    const report = {
      schema_version: 'ao.installed-runtime-cli-contract.v1',
      status: 'hold',
      code: error.code ?? 'runtime_contract_probe_failed',
      message: error.message,
      runtime: {
        runtime_ref: runtime.runtime_ref,
        binary_path: runtime.binary_path,
        binary_sha256: runtime.binary_sha256,
      },
    };
    io.writeStderr(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
    return { exitCode: 2, report };
  }
  const report = buildRuntimeContract(runtime, probes, launcher);
  io.writeStdout(`${JSON.stringify(report, null, options.json ? 2 : 0)}\n`);
  return { exitCode: report.status === 'passed' ? 0 : 3, report };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
