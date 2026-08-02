#!/usr/bin/env node

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  bootstrapManagedRuntime,
  getDefaultRuntimeCache,
  getDefaultRuntimeStore,
  RuntimeBootstrapError,
} from './ao/lib/runtime-bootstrap.js';

function help() {
  return [
    'Usage: ./scripts/bootstrap.sh [options]',
    '',
    'Options:',
    '  --store <path>    Managed runtime store (or AO_PILOT_RUNTIME_STORE)',
    '  --cache <path>    Verified bootstrap cache (or AO_PILOT_RUNTIME_CACHE)',
    '  --offline         Forbid downloads and public Git fetches',
    '  --reinstall       Atomically rebuild and replace the exact runtime',
    '  --json            Emit a machine-readable receipt',
    '  -h, --help        Show this help',
  ].join('\n');
}

export function parseBootstrapArgs(argv, env = process.env) {
  const options = {
    storeRoot: env.AO_PILOT_RUNTIME_STORE?.trim() || getDefaultRuntimeStore({ env }),
    cacheRoot: env.AO_PILOT_RUNTIME_CACHE?.trim() || getDefaultRuntimeCache({ env }),
    offline: false,
    reinstall: false,
    json: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--offline') options.offline = true;
    else if (argument === '--reinstall') options.reinstall = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--store' || argument === '--cache') {
      const value = argv[index + 1];
      if (value == null || value.startsWith('-')) {
        throw new RuntimeBootstrapError('bootstrap_usage', `Missing value for ${argument}`);
      }
      options[argument === '--store' ? 'storeRoot' : 'cacheRoot'] = path.resolve(value);
      index += 1;
    } else {
      throw new RuntimeBootstrapError('bootstrap_usage', `Unknown bootstrap option: ${argument}`);
    }
  }
  return options;
}

function renderHuman(report) {
  return [
    `bootstrap_status: ${report.status}`,
    `runtime_ref: ${report.runtime.runtime_ref}`,
    `runtime_store: ${report.store_root}`,
    `runtime_directory: ${report.runtime.runtime_directory}`,
    `binary_path: ${report.runtime.binary_path}`,
    `binary_sha256: ${report.runtime.binary_sha256}`,
    `source_repository: ${report.runtime.source.repository}`,
    `source_tag: ${report.runtime.source.tag}`,
    `source_tag_object_sha: ${report.runtime.source.tag_object_sha}`,
    `source_commit_sha: ${report.runtime.source.commit_sha}`,
    `source_tree_sha: ${report.runtime.source.tree_sha}`,
    `lock_digest: ${report.runtime.lock_digest}`,
    `cache_root: ${report.cache_root}`,
    `offline: ${report.offline}`,
    `reinstall: ${report.reinstall}`,
    `recovered_interrupted_bootstrap: ${report.recovered_interrupted_bootstrap}`,
  ].join('\n');
}

function renderError(error) {
  return {
    status: 'failed',
    code: error.code ?? 'bootstrap_failed',
    message: error.message,
    details: error.details ?? {},
  };
}

export async function runCli(argv, io = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
}, dependencies = {}) {
  let options;
  try {
    options = parseBootstrapArgs(argv, dependencies.env ?? process.env);
    if (options.help) {
      io.stdout(`${help()}\n`);
      return { exitCode: 0, report: null };
    }
    const report = await (dependencies.bootstrap ?? bootstrapManagedRuntime)({
      storeRoot: options.storeRoot,
      cacheRoot: options.cacheRoot,
      offline: options.offline,
      reinstall: options.reinstall,
      env: dependencies.env ?? process.env,
      cwd: dependencies.cwd ?? process.cwd(),
    });
    io.stdout(`${options.json ? JSON.stringify(report, null, 2) : renderHuman(report)}\n`);
    return { exitCode: 0, report };
  } catch (error) {
    const failure = renderError(error);
    const wantsJson = options?.json ?? argv.includes('--json');
    io.stderr(`${wantsJson ? JSON.stringify(failure, null, 2) : [
      `bootstrap_status: failed`,
      `code: ${failure.code}`,
      `message: ${failure.message}`,
    ].join('\n')}\n`);
    return { exitCode: error.code === 'bootstrap_usage' ? 4 : 2, report: failure };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
