#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAoEvalHarness } from './ao/lib/eval-harness.js';
import { findRepoRoot } from './ao/lib/repo-root.js';
import {
  buildAoEvalScorecard,
  compareAoEvalScorecards,
  DEFAULT_PROJECT_ID,
  loadAoEvalBaseline,
  persistAoEvalScorecard,
  renderAoEvalHumanSummary,
} from './ao/lib/scorecard.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_EVAL_FIXTURE_ROOT = path.join(
  PACKAGE_ROOT,
  'tests',
  'ao',
  'fixtures',
  'eval',
);

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1] ?? null;
  if (value == null || value.startsWith('-')) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    packNames: [],
    baselineRef: null,
    saveBaseline: null,
    fixtureRoot: DEFAULT_EVAL_FIXTURE_ROOT,
    replayCount: 2,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      try {
        options.projectId = readOptionValue(argv, index, '--project');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--pack') {
      try {
        options.packNames.push(readOptionValue(argv, index, '--pack'));
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--baseline') {
      try {
        options.baselineRef = readOptionValue(argv, index, '--baseline');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--save-baseline') {
      try {
        options.saveBaseline = readOptionValue(argv, index, '--save-baseline');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--fixture-root') {
      try {
        options.fixtureRoot = readOptionValue(argv, index, '--fixture-root');
      } catch (error) {
        return {
          ok: false,
          error: error.message,
        };
      }
      index += 1;
    } else if (arg === '--replay-count') {
      const value = argv[index + 1] ?? null;
      options.replayCount = value == null ? null : Number(value);
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}`,
      };
    }
  }

  if (!options.packNames.length) {
    options.packNames = ['all'];
  }

  if (options.projectId == null || String(options.projectId).trim() === '') {
    return {
      ok: false,
      error: 'Missing value for --project',
    };
  }
  if (typeof options.fixtureRoot !== 'string' || options.fixtureRoot.trim() === '') {
    return {
      ok: false,
      error: 'Missing value for --fixture-root',
    };
  }
  if (!Number.isInteger(options.replayCount) || options.replayCount < 2) {
    return {
      ok: false,
      error: 'Invalid value for --replay-count',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-eval.js [options]',
    '',
    'Options:',
    '  --project <project_id>       AO project id. Default: my-project',
    '  --pack <name>               Eval pack to run. Repeatable. Default: all',
    '  --baseline <ref>            Compare against a saved baseline alias, scorecard id, or JSON path',
    '  --save-baseline <name>      Save the current scorecard as a named baseline alias',
    '  --fixture-root <path>        Eval pack root. Default: bundled public packs',
    '  --replay-count <number>      Executions per scenario. Minimum/default: 2',
    '  --json                      Print machine-readable JSON output',
    '  -h, --help                  Show help',
  ].join('\n');
}

function exitCodeForResult(scorecard, comparison) {
  if ((scorecard?.summary?.failed_scenario_count ?? 0) > 0) return 1;
  if (comparison != null && comparison.status !== 'ok') return 1;
  return 0;
}

export async function runCli(argv, io = createDefaultIo()) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: 4,
      scorecard: null,
      comparison: null,
      persisted: null,
    };
  }

  const { options } = parsed;
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return {
      exitCode: 0,
      scorecard: null,
      comparison: null,
      persisted: null,
    };
  }

  try {
    const repoRoot = findRepoRoot(process.cwd());
    if (!repoRoot) {
      throw new Error(`Could not locate repo root from ${process.cwd()}`);
    }

    const harnessResult = await runAoEvalHarness({
      projectId: options.projectId,
      fixtureRoot: path.resolve(process.cwd(), options.fixtureRoot),
      packNames: options.packNames,
      replayCount: options.replayCount,
    });
    const scorecard = buildAoEvalScorecard({
      projectId: options.projectId,
      harnessResult,
    });
    const comparison = options.baselineRef == null
      ? null
      : compareAoEvalScorecards({
          baselineScorecard: loadAoEvalBaseline({
            repoRoot,
            projectId: options.projectId,
            baselineRef: options.baselineRef,
            cwd: process.cwd(),
          }),
          currentScorecard: scorecard,
        });
    const persisted = persistAoEvalScorecard({
      repoRoot,
      projectId: options.projectId,
      scorecard,
      baselineName: options.saveBaseline,
    });
    const payload = {
      scorecard,
      comparison,
      persisted,
    };

    if (options.json) {
      io.writeStdout(JSON.stringify(payload, null, 2));
    } else {
      io.writeStdout(`${renderAoEvalHumanSummary(payload)}\n`);
    }

    return {
      exitCode: exitCodeForResult(scorecard, comparison),
      scorecard,
      comparison,
      persisted,
    };
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return {
      exitCode: 3,
      scorecard: null,
      comparison: null,
      persisted: null,
    };
  }
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
