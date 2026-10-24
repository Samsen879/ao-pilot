#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyPackedRelease } from './ao/lib/release-tarball.js';
import { verifyReleaseTree } from './ao/lib/release-manifest.js';
import { verifyPackageDependencies } from './ao/lib/package-dependencies.js';

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
  const args = process.argv.slice(2);
  const argument = (name) => { const index = args.indexOf(name); return index < 0 ? null : args[index + 1]; };
  const suppliedTarball = argument('--tarball') ?? process.env.AO_RELEASE_TARBALL;
  const expectedSha = argument('--sha256') ?? process.env.AO_RELEASE_TARBALL_SHA256;
  let packReport;
  let tarball;
  if (suppliedTarball) {
    if (!/^[a-f0-9]{64}$/.test(expectedSha ?? '')) throw new Error('A pinned SHA256 is required for the supplied package');
    tarball = path.resolve(suppliedTarball);
    const actual = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    if (actual !== expectedSha) throw new Error('Supplied package SHA256 mismatch');
    packReport = [{ filename: path.basename(tarball), entryCount: null, unpackedSize: null }];
  } else {
    const packResult = run(npmCommand, ['pack', '--json', '--pack-destination', verificationRoot], { cwd: packageRoot });
    packReport = JSON.parse(packResult.stdout);
    tarball = path.join(verificationRoot, packReport?.[0]?.filename ?? '');
  }
  const filename = packReport?.[0]?.filename;
  if (typeof filename !== 'string' || filename === '') throw new Error('npm pack did not return a package filename');
  const tarballSha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const payload = argument('--release-payload');
  if (payload) {
    const manifest = verifyReleaseTree(payload); verifyPackedRelease(tarball, payload, manifest);
    const metadata = JSON.parse(fs.readFileSync(path.join(payload, 'package.json'), 'utf8'));
    const paths = Object.entries(metadata.exports).filter(([name, value]) => !name.endsWith('.json') && typeof value === 'string').map(([, value]) => value);
    run(process.execPath, ['--input-type=module', '--eval', `import {pathToFileURL} from 'node:url'; import path from 'node:path'; for (const file of ${JSON.stringify(paths)}) await import(pathToFileURL(path.resolve(${JSON.stringify(payload)}, file)));`], { cwd: payload });
    run(process.execPath, [path.join(payload, 'bin/ao-pilot.js'), '--version'], { cwd: payload });
    // Consume the actual installed payload's dependency trees. npm excludes
    // node_modules from tgz, so checking only its imports would miss a broken
    // browser/workspace payload that apply will copy verbatim.
    const dependencyManifests = manifest.files.filter((file) => file.type === 'file' && !file.path.split('/').includes('node_modules')
      && (file.path === 'package.json' || file.path === 'browser/package.json' || /^browser\/packages\/.+\/package\.json$/.test(file.path))).map((file) => file.path);
    for (const relative of dependencyManifests) verifyPackageDependencies(path.join(payload, relative));
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
    tarball,
  ], {
    cwd: installRoot,
  });

  const publicApiResult = run(process.execPath, [
    '--input-type=module',
    '--eval',
    [
      "const root = await import('ao-pilot');",
      "const packageJson = JSON.parse((await import('node:fs')).readFileSync(new URL('./node_modules/ao-pilot/package.json', import.meta.url), 'utf8'));",
      "for (const key of Object.keys(packageJson.exports)) {",
      "  const specifier = key === '.' ? 'ao-pilot' : `ao-pilot${key.slice(1)}`;",
      "  if (key.endsWith('.json')) (await import('node:module')).createRequire(import.meta.url).resolve(specifier);",
      "  else await import(specifier);",
      "}",
      "const cli = await import('ao-pilot/cli');",
      "const contracts = await import('ao-pilot/contracts');",
      "const repository = await import('ao-pilot/repository');",
      "const engines = await import('ao-pilot/engines');",
      "const protocols = await import('ao-pilot/protocols');",
      "const providers = await import('ao-pilot/providers');",
      "const { createRequire } = await import('node:module');",
      "const packageRequire = createRequire(import.meta.url);",
      "const completionRecordSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.child-completion.v1alpha1.schema.json');",
      "const completionInputManifestSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.child-completion-input-manifest.v1alpha1.schema.json');",
      "const taskRelationSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.task-relation.v1alpha1.schema.json');",
      "const mergePreflightSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.or-merge-preflight.v1.schema.json');",
      "const githubMergeObservationSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.github-merge-observation.v1.schema.json');",
      "const mergeOutcomeSchemaPath = packageRequire.resolve('ao-pilot/schemas/ao.or-merge-outcome.v1.schema.json');",
      'const cieCliExports = [',
      "  'runControllerCli', 'runDoctorCli', 'runEvalCli', 'runHandoffCli',",
      "  'runKnowledgeCli', 'runLifecycleCli', 'runManageCli', 'runMetricsCli',",
      "  'runOverrideCli', 'runReconcileCli', 'runReviewCli', 'runStateCli',",
      "  'runPublicationPreflightCli',",
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
      "  ['contracts.normalizeCompletionRecord', contracts.normalizeCompletionRecord],",
      "  ['contracts.createTaskRelation', contracts.createTaskRelation],",
      "  ['repository.createStateRepository', repository.createStateRepository],",
      "  ['engines.reconcileObservations', engines.reconcileObservations],",
      "  ['engines.executeAssistActions', engines.executeAssistActions],",
      "  ['protocols.createHandoffProtocol', protocols.createHandoffProtocol],",
      "  ['protocols.evaluateOrMergePreflight', protocols.evaluateOrMergePreflight],",
      "  ['protocols.bindGitHubMergeOutcome', protocols.bindGitHubMergeOutcome],",
      "  ['protocols.runGitPublicationPreflight', protocols.runGitPublicationPreflight],",
      "  ['providers.createLocalCommandRunner', providers.createLocalCommandRunner],",
      "  ['providers.createBlockedNotificationWebhookTransport', providers.createBlockedNotificationWebhookTransport],",
      "  ['providers.resolveManagedRuntime', providers.resolveManagedRuntime],",
      "  ['providers.bootstrapManagedRuntime', providers.bootstrapManagedRuntime],",
      "  ['providers.loadGitHubMergeObservation', providers.loadGitHubMergeObservation],",
      '];',
      'for (const [name, value] of coreChecks) {',
      "  if (typeof value !== 'function') throw new Error(`Missing public core export: ${name}`);",
      '}',
      "if (!completionRecordSchemaPath.endsWith('/schemas/ao.child-completion.v1alpha1.schema.json')) {",
      "  throw new Error('Completion Record schema export did not resolve');",
      '}',
      "if (!completionInputManifestSchemaPath.endsWith('/schemas/ao.child-completion-input-manifest.v1alpha1.schema.json')) {",
      "  throw new Error('Completion input manifest schema export did not resolve');",
      '}',
      "if (!taskRelationSchemaPath.endsWith('/schemas/ao.task-relation.v1alpha1.schema.json')) {",
      "  throw new Error('Task relation schema export did not resolve');",
      '}',
      "if (!mergePreflightSchemaPath.endsWith('/schemas/ao.or-merge-preflight.v1.schema.json')) throw new Error('OR merge preflight schema export did not resolve');",
      "if (!githubMergeObservationSchemaPath.endsWith('/schemas/ao.github-merge-observation.v1.schema.json')) throw new Error('GitHub merge observation schema export did not resolve');",
      "if (!mergeOutcomeSchemaPath.endsWith('/schemas/ao.or-merge-outcome.v1.schema.json')) throw new Error('OR merge outcome schema export did not resolve');",
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
      "if (runtimeLock.lock.runtime_ref !== 'runtime.ao_pilot_headless.v0_11_2_p0_4') {",
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

  if (createHash('sha256').update(fs.readFileSync(tarball)).digest('hex') !== tarballSha256) throw new Error('Package bytes changed during verification');
  process.stdout.write(`${JSON.stringify({
    status: 'pass',
    package: filename,
    tarball_sha256: tarballSha256,
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
