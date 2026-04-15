#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli as runReconcileCli } from '../ao-reconcile.js';
import { runCli as runDoctorCli } from '../ao-doctor.js';
import { runCli as runLifecycleCli } from '../ao-lifecycle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_RUNNERS = {
  'scripts/ao-reconcile.js': runReconcileCli,
  'scripts/ao-doctor.js': runDoctorCli,
  'scripts/ao-lifecycle.js': runLifecycleCli,
};

const SCENARIOS = {
  'ci-failed-pr': {
    fixtureRoot: path.join(ROOT, 'tests', 'ao', 'fixtures', 'acceptance', 'ci-failed-pr'),
    steps: [
      {
        label: 'reconcile',
        script: 'scripts/ao-reconcile.js',
        args: ['--pr', '92', '--strict'],
        expectExitCode: 11,
        expectStdoutContains: [
          'top_status: blocked',
          'automation_disposition: pause',
          'ownership_summary: PR #92 clear via worker-92',
          'release_readiness_summary: PR #92 blocked',
        ],
      },
      {
        label: 'doctor',
        script: 'scripts/ao-doctor.js',
        args: ['--pr', '92', '--strict'],
        expectExitCode: 21,
        expectStdoutContains: [
          'top_status: blocked',
          'reconciliation_top_status: blocked',
          'current_branch: feat/issue-92',
        ],
      },
      {
        label: 'lifecycle',
        script: 'scripts/ao-lifecycle.js',
        args: ['--pr', '92', '--trigger', 'ci_failed', '--strict'],
        expectExitCode: 31,
        expectStdoutContains: [
          'top_status: hold',
          'routing: continue_current_worker owner=worker-92 authoritative=true',
          'release: await_ci authoritative=true',
        ],
      },
    ],
  },
  'approved-and-green-pr': {
    fixtureRoot: path.join(ROOT, 'tests', 'ao', 'fixtures', 'acceptance', 'approved-and-green-pr'),
    steps: [
      {
        label: 'reconcile',
        script: 'scripts/ao-reconcile.js',
        args: ['--pr', '93', '--strict'],
        expectExitCode: 0,
        expectStdoutContains: [
          'top_status: healthy',
          'automation_disposition: continue',
          'ownership_summary: PR #93 clear via worker-93',
          'release_readiness_summary: PR #93 ready',
        ],
      },
      {
        label: 'doctor',
        script: 'scripts/ao-doctor.js',
        args: ['--pr', '93', '--strict'],
        expectExitCode: 0,
        expectStdoutContains: [
          'top_status: healthy',
          'reconciliation_top_status: healthy',
          'current_branch: feat/issue-93',
        ],
      },
      {
        label: 'lifecycle',
        script: 'scripts/ao-lifecycle.js',
        args: ['--pr', '93', '--trigger', 'approved_and_green', '--strict'],
        expectExitCode: 0,
        expectStdoutContains: [
          'top_status: continue',
          'routing: continue_current_worker owner=worker-93 authoritative=true',
          'release: notify_human_ready authoritative=true',
        ],
      },
    ],
  },
};

function parseArgs(argv) {
  const options = {
    scenario: 'ci-failed-pr',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--scenario') {
      options.scenario = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!SCENARIOS[options.scenario]) {
    throw new Error(`Unknown scenario: ${options.scenario}`);
  }

  return options;
}

function renderHelp() {
  return [
    'Usage: node scripts/ao/run-operator-smoke.js [options]',
    '',
    'Options:',
    '  --scenario <name>       Smoke scenario. Default: ci-failed-pr',
    '  -h, --help              Show help',
    '',
    `Available scenarios: ${Object.keys(SCENARIOS).join(', ')}`,
  ].join('\n');
}

async function runStep(step, fixtureRoot) {
  const runner = CLI_RUNNERS[step.script];
  if (!runner) {
    throw new Error(`Unsupported smoke script: ${step.script}`);
  }

  const stdout = [];
  const stderr = [];
  const originalFixtureRoot = process.env.AO_FIXTURE_ROOT;
  const originalCwd = process.cwd();
  process.env.AO_FIXTURE_ROOT = fixtureRoot;
  process.chdir(ROOT);

  let exitCode = 1;

  try {
    const result = await runner(step.args, {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    });
    exitCode = result.exitCode ?? 1;
  } finally {
    process.chdir(originalCwd);
    if (originalFixtureRoot == null) {
      delete process.env.AO_FIXTURE_ROOT;
    } else {
      process.env.AO_FIXTURE_ROOT = originalFixtureRoot;
    }
  }

  const renderedStdout = stdout.join('');
  const renderedStderr = stderr.join('');

  if (exitCode !== step.expectExitCode) {
    throw new Error([
      `${step.label} exit code mismatch: expected ${step.expectExitCode}, received ${exitCode}`,
      renderedStdout.trim(),
      renderedStderr.trim(),
    ].filter(Boolean).join('\n'));
  }

  for (const fragment of step.expectStdoutContains) {
    if (!renderedStdout.includes(fragment)) {
      throw new Error([
        `${step.label} output missing expected fragment: ${fragment}`,
        renderedStdout.trim(),
      ].filter(Boolean).join('\n'));
    }
  }

  return renderedStdout.trim();
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(renderHelp());
    process.exit(0);
  }

  const scenario = SCENARIOS[options.scenario];
  console.log(`ao smoke scenario: ${options.scenario}`);
  console.log(`fixture_root: ${scenario.fixtureRoot}`);

  for (const step of scenario.steps) {
    const summary = await runStep(step, scenario.fixtureRoot);
    console.log('');
    console.log(`## ${step.label}`);
    console.log(summary);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
