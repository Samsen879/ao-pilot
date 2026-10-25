#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRelease, preflightRelease } from './ao/lib/release-installer.js';
import { createSystemdReleaseRunner } from './ao/lib/release-systemd.js';
import { inspectInstall } from './ao/lib/install-doctor.js';
import { assertRelease, readJson } from './ao/lib/release-manifest.js';

export function loadInstallConfiguration(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assertRelease(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0
      && stat.uid === process.getuid(), 'unsafe_install_configuration');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
export async function runCli(argv, io = { writeStdout: (text) => process.stdout.write(text), writeStderr: (text) => process.stderr.write(text) }, {
  apply = applyRelease, preflight = preflightRelease, runner = null, configLoader = loadInstallConfiguration, env = process.env,
} = {}) {
  if (argv.includes('--help') || argv.length === 0) {
    io.writeStdout('Usage: ao-pilot upgrade apply --release <id> [--install-config <file>] [--adopt-legacy] [--resume] [--allow-database-restore]\n       ao-pilot upgrade preflight --release <id> [--install-config <file>] [--adopt-legacy] [--prepared-config <file>] [--prepared-token <file>]\n       ao-pilot upgrade inspect [--install-config <file>]\n');
    return { exitCode: 0 };
  }
  let operation; let releaseId; let file = env.AO_INSTALL_CONFIG ?? path.join(os.homedir(), '.config/ao-pilot/install.json');
  let resume = false; let restore = false; let adoptLegacy = false;
  const preparedInputs = {};
  try {
    [operation] = argv;
    for (let i = 1; i < argv.length; i += 1) {
      const option = argv[i];
      if (option === '--release') releaseId = argv[++i];
      else if (option === '--install-config') file = argv[++i];
      else if (option === '--resume') resume = true;
      else if (option === '--allow-database-restore') restore = true;
      else if (option === '--adopt-legacy') adoptLegacy = true;
      else if (option === '--prepared-config') preparedInputs.configPath = argv[++i];
      else if (option === '--prepared-token') preparedInputs.terminalTokenFile = argv[++i];
      else throw Object.assign(new Error('Invalid upgrade argument'), { code: 'invalid_upgrade_argument' });
    }
    const configuration = { ...configLoader(file), installConfigPath: path.resolve(file) };
    assertRelease(operation === 'preflight' || Object.keys(preparedInputs).length === 0, 'invalid_upgrade_argument');
    if (operation === 'inspect') {
      assertRelease(!adoptLegacy, 'invalid_upgrade_argument');
      const root = fs.realpathSync(path.join(configuration.installRoot, 'current'));
      const service = runner ?? createSystemdReleaseRunner(configuration);
      const observation = await service.observe({ releaseRoot: root });
      const report = inspectInstall({ releaseRoot: root, observation, baseline: observation, requireRestart: false });
      // Inspect output is explicitly private diagnostic data, never a public receipt.
      io.writeStdout(`${JSON.stringify(report, null, 2)}\n`);
      return { exitCode: report.status === 'passed' ? 0 : 2, report };
    }
    assertRelease(['apply', 'preflight'].includes(operation) && /^[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(releaseId ?? ''), 'invalid_upgrade_argument');
    const entry = configuration.releaseCatalog?.[releaseId];
    assertRelease(entry && path.isAbsolute(entry.bundle), 'release_not_registered');
    assertRelease(operation !== 'preflight' || !resume && !restore, 'invalid_upgrade_argument');
    const operationRunner = runner ?? createSystemdReleaseRunner(configuration, { preparedInputs: Object.keys(preparedInputs).length ? preparedInputs : null });
    const receipt = await (operation === 'preflight' ? preflight : apply)({ bundle: entry.bundle, expectedEnvelopeSha256: entry.envelope_sha256,
      configuration, runner: operationRunner, mode: configuration.mode ?? 'daily', resume, allowDatabaseRestore: restore, adoptLegacy });
    io.writeStdout(`${JSON.stringify(receipt, null, 2)}\n`);
    return { exitCode: 0, receipt };
  } catch (error) {
    if (error.publicReceipt) io.writeStdout(`${JSON.stringify(error.publicReceipt, null, 2)}\n`);
    // Private CLI diagnostic; public receipts still use their fixed allowlist.
    io.writeStderr(`${JSON.stringify({ status: 'failed', code: /^[a-z_]+$/.test(error.code ?? '') ? error.code : 'upgrade_failed', message: error.message, ...(error.details ? { details: error.details } : {}) })}\n`);
    return { exitCode: 2, errorCode: error.code ?? 'upgrade_failed' };
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await runCli(process.argv.slice(2))).exitCode;
}
