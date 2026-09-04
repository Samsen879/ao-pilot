#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GIT_PUBLICATION_PREFLIGHT_EXIT_CODES,
  GitPublicationPreflightUsageError,
  runGitPublicationPreflight,
} from './ao/lib/git-publication-preflight.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-publication-preflight.js --expected-repository <owner/name> --expected-principal <login> --worker-principal <login> [options]',
    '',
    'Options:',
    '  --expected-repository <owner/name>  Bind the admitted GitHub repository',
    '  --expected-principal <login>        Bind the admitted GitHub principal',
    '  --worker-principal <login>          Assert the Worker publication principal',
    '  --remote <name>                     Publication remote. Default: origin',
    '  --credential-helper <helper>         Use a command-scoped helper for the read-only probe',
    '  --receipt-out <path>                Write a mode-0600 JSON receipt',
    '  --json                              Emit the redacted JSON receipt',
    '  -h, --help                          Show help',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    expectedRepository: null,
    expectedPrincipal: null,
    workerPrincipal: null,
    remote: 'origin',
    commandScopedCredentialHelper: null,
    receiptOut: null,
    json: false,
    help: false,
  };
  const mappings = new Map([
    ['--expected-repository', 'expectedRepository'],
    ['--expected-principal', 'expectedPrincipal'],
    ['--worker-principal', 'workerPrincipal'],
    ['--remote', 'remote'],
    ['--credential-helper', 'commandScopedCredentialHelper'],
    ['--receipt-out', 'receiptOut'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      options.json = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else if (mappings.has(argument)) {
      const value = argv[index + 1];
      if (value == null || value.startsWith('-')) {
        throw new Error(`Missing value for ${argument}`);
      }
      options[mappings.get(argument)] = value;
      index += 1;
    } else {
      throw new Error('Unknown argument');
    }
  }
  return options;
}

function renderSummary(receipt) {
  return [
    `Git publication preflight: ${receipt.status.toUpperCase()}`,
    `Risk tier: ${receipt.risk.tier}`,
    `Repository: ${receipt.scope.expected_repository}`,
    `Principal: ${receipt.scope.expected_principal}`,
    `Findings: ${receipt.findings.length}`,
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo(), dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return { exitCode: GIT_PUBLICATION_PREFLIGHT_EXIT_CODES.invalid_usage, receipt: null };
  }
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return { exitCode: 0, receipt: null };
  }

  let receipt;
  try {
    receipt = runGitPublicationPreflight({
      cwd: dependencies.cwd ?? process.cwd(),
      expectedRepository: options.expectedRepository,
      expectedPrincipal: options.expectedPrincipal,
      workerPrincipal: options.workerPrincipal,
      remote: options.remote,
      commandScopedCredentialHelper: options.commandScopedCredentialHelper,
      runner: dependencies.runner,
      env: dependencies.env,
      now: dependencies.now,
      resolveExecutable: dependencies.resolveExecutable,
    });
  } catch (error) {
    io.writeStderr(error instanceof GitPublicationPreflightUsageError
      ? `${error.message}\n`
      : 'Git publication preflight could not complete safely.\n');
    return { exitCode: GIT_PUBLICATION_PREFLIGHT_EXIT_CODES.invalid_usage, receipt: null };
  }

  if (options.receiptOut != null) {
    try {
      const receiptPath = path.resolve(options.receiptOut);
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
      fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
      fs.chmodSync(receiptPath, 0o600);
    } catch {
      io.writeStderr('The redacted publication receipt could not be written safely.\n');
      return { exitCode: GIT_PUBLICATION_PREFLIGHT_EXIT_CODES.invalid_usage, receipt: null };
    }
  }
  io.writeStdout(options.json
    ? `${JSON.stringify(receipt, null, 2)}\n`
    : `${renderSummary(receipt)}\n`);
  return {
    exitCode: GIT_PUBLICATION_PREFLIGHT_EXIT_CODES[receipt.status],
    receipt,
  };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
