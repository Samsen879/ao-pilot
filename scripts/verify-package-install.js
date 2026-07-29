#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.error?.message ?? '',
      result.stdout ?? '',
      result.stderr ?? '',
    ].filter(Boolean).join('\n'));
  }
  return result;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const verificationRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-package-'));
const packageRoot = process.cwd();

try {
  const packResult = run(npmCommand, [
    'pack',
    '--json',
    '--pack-destination',
    verificationRoot,
  ], {
    cwd: packageRoot,
  });
  const packReport = JSON.parse(packResult.stdout);
  const filename = packReport?.[0]?.filename;
  if (typeof filename !== 'string' || filename === '') {
    throw new Error('npm pack did not return a package filename');
  }

  const installRoot = path.join(verificationRoot, 'install');
  fs.mkdirSync(installRoot, { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'ao-pilot-package-verification',
    version: '1.0.0',
    private: true,
  }, null, 2)}\n`);
  run('git', ['init', '--quiet'], { cwd: installRoot });
  run(npmCommand, [
    'install',
    '--ignore-scripts',
    path.join(verificationRoot, filename),
  ], {
    cwd: installRoot,
  });

  const binPath = path.join(
    installRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'ao-pilot.cmd' : 'ao-pilot',
  );
  run(binPath, ['--help'], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });
  const initResult = run(binPath, [
    'init',
    '--project',
    'package-verification',
    '--json',
  ], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });
  const stateResult = run(binPath, ['state', '--json'], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });
  const evalResult = run(binPath, [
    'eval',
    '--pack',
    'policy-fail-closed',
    '--json',
  ], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });

  const initReport = JSON.parse(initResult.stdout);
  const stateReport = JSON.parse(stateResult.stdout);
  const evalReport = JSON.parse(evalResult.stdout);
  if (
    initReport.project_id !== 'package-verification'
    || stateReport.project_id !== 'package-verification'
  ) {
    throw new Error('Installed CLI did not apply its generated project configuration');
  }
  if (
    evalReport?.scorecard?.project_id !== 'package-verification'
      || evalReport?.scorecard?.quality_gate?.status !== 'passed'
      || !String(evalReport?.scorecard?.scenarios?.[0]?.replay?.fingerprint ?? '')
        .match(/^[a-f0-9]{64}$/)
  ) {
    throw new Error('Installed CLI did not execute its bundled evaluation pack');
  }

  process.stdout.write(`${JSON.stringify({
    status: 'pass',
    package: filename,
    entry_count: packReport[0].entryCount,
    unpacked_size: packReport[0].unpackedSize,
    project_id: stateReport.project_id,
    eval_quality_gate: evalReport.scorecard.quality_gate.status,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(verificationRoot, { recursive: true, force: true });
}
