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

  const publicApiResult = run(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const root = await import('ao-pilot');",
      "const cli = await import('ao-pilot/cli');",
      "const contracts = await import('ao-pilot/contracts');",
      "const repository = await import('ao-pilot/repository');",
      "const engines = await import('ao-pilot/engines');",
      "const protocols = await import('ao-pilot/protocols');",
      "const providers = await import('ao-pilot/providers');",
      'const cieCliExports = [',
      "  'runControllerCli', 'runDoctorCli', 'runEvalCli', 'runHandoffCli',",
      "  'runKnowledgeCli', 'runLifecycleCli', 'runManageCli', 'runMetricsCli',",
      "  'runOverrideCli', 'runReconcileCli', 'runReviewCli', 'runStateCli',",
      '];',
      'for (const name of cieCliExports) {',
      "  if (typeof cli[name] !== 'function' || root[name] !== cli[name]) {",
      "    throw new Error(`Missing public CLI export: ${name}`);",
      '  }',
      '}',
      'const coreChecks = [',
      "  ['contracts.createPrScope', contracts.createPrScope],",
      "  ['contracts.loadRuntimeLock', contracts.loadRuntimeLock],",
      "  ['contracts.loadBootstrapToolchainLock', contracts.loadBootstrapToolchainLock],",
      "  ['repository.createStateRepository', repository.createStateRepository],",
      "  ['engines.reconcileObservations', engines.reconcileObservations],",
      "  ['engines.executeAssistActions', engines.executeAssistActions],",
      "  ['protocols.createHandoffProtocol', protocols.createHandoffProtocol],",
      "  ['providers.createLocalCommandRunner', providers.createLocalCommandRunner],",
      "  ['providers.createBlockedNotificationWebhookTransport', providers.createBlockedNotificationWebhookTransport],",
      "  ['providers.resolveManagedRuntime', providers.resolveManagedRuntime],",
      "  ['providers.bootstrapManagedRuntime', providers.bootstrapManagedRuntime],",
      '];',
      'for (const [name, value] of coreChecks) {',
      "  if (typeof value !== 'function') throw new Error(`Missing public core export: ${name}`);",
      '}',
      'const cieNames = Object.keys(root).filter((name) => /cie|9709|questionpart/i.test(name));',
      "if (cieNames.length > 0) throw new Error(`CIE-specific exports found: ${cieNames.join(', ')}`);",
      'let deepImportBlocked = false;',
      'try {',
      "  await import('ao-pilot/scripts/ao/lib/state-contracts.js');",
      '} catch (error) {',
      "  if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;",
      '  deepImportBlocked = true;',
      '}',
      "if (!deepImportBlocked) throw new Error('Undeclared package deep import was not blocked');",
      'const runtimeLock = contracts.loadRuntimeLock();',
      "if (runtimeLock.lock.runtime_ref !== 'runtime.agent_orchestrator.v0_11_2_p0_1') {",
      "  throw new Error('Installed package runtime lock ref mismatch');",
      '}',
      "if (!runtimeLock.digest.match(/^sha256:[a-f0-9]{64}$/)) {",
      "  throw new Error('Installed package runtime lock digest missing');",
      '}',
      'process.stdout.write(JSON.stringify({',
      "  status: 'pass',",
      '  cli_export_count: cieCliExports.length,',
      '  core_group_count: coreChecks.length,',
      '  deep_import_blocked: deepImportBlocked,',
      '  runtime_lock: {',
      '    runtime_ref: runtimeLock.lock.runtime_ref,',
      '    digest: runtimeLock.digest,',
      '  },',
      '}));',
    ].join('\n'),
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
  run(binPath, ['start', '--help'], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });
  run(binPath, ['runtime-path', '--help'], {
    cwd: installRoot,
    shell: process.platform === 'win32',
  });
  const bootstrapPath = path.join(
    installRoot,
    'node_modules',
    'ao-pilot',
    'scripts',
    'bootstrap-runtime.js',
  );
  run(process.execPath, [bootstrapPath, '--help'], { cwd: installRoot });
  const versionResult = run(binPath, ['--version'], {
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
  const publicApiReport = JSON.parse(publicApiResult.stdout);
  const packageVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ).version;
  if (versionResult.stdout.trim() !== packageVersion) {
    throw new Error('Installed CLI version does not match package metadata');
  }
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
    version: packageVersion,
    eval_quality_gate: evalReport.scorecard.quality_gate.status,
    public_api: publicApiReport,
  }, null, 2)}\n`);
} finally {
  fs.rmSync(verificationRoot, { recursive: true, force: true });
}
