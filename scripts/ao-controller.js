#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runControllerLoop } from './ao/lib/controller-loop.js';
import { findRepoRoot } from './ao/lib/repo-root.js';

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
    projectId: 'my-project',
    controllerId: 'default',
    holderId: null,
    mode: null,
    issueNumber: null,
    continuous: false,
    pollIntervalMs: 30 * 1000,
    shutdownTimeoutMs: 10 * 1000,
    json: false,
    help: false,
  };

  try {
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg === '--project') {
        options.projectId = readOptionValue(argv, index, '--project');
        index += 1;
      } else if (arg === '--controller') {
        options.controllerId = readOptionValue(argv, index, '--controller');
        index += 1;
      } else if (arg === '--holder') {
        options.holderId = readOptionValue(argv, index, '--holder');
        index += 1;
      } else if (arg === '--mode') {
        options.mode = readOptionValue(argv, index, '--mode');
        index += 1;
      } else if (arg === '--issue') {
        options.issueNumber = Number(readOptionValue(argv, index, '--issue'));
        index += 1;
      } else if (arg === '--continuous') {
        options.continuous = true;
      } else if (arg === '--poll-interval-ms') {
        options.pollIntervalMs = Number(readOptionValue(argv, index, '--poll-interval-ms'));
        index += 1;
      } else if (arg === '--shutdown-timeout-ms') {
        options.shutdownTimeoutMs = Number(readOptionValue(argv, index, '--shutdown-timeout-ms'));
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
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }

  if (options.help) {
    return {
      ok: true,
      options,
    };
  }

  if (options.mode != null && !['observe', 'shadow', 'assist'].includes(options.mode)) {
    return {
      ok: false,
      error: 'Invalid value for --mode',
    };
  }

  if (options.issueNumber != null && (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --issue',
    };
  }

  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    return {
      ok: false,
      error: 'Invalid value for --poll-interval-ms',
    };
  }

  if (!Number.isInteger(options.shutdownTimeoutMs) || options.shutdownTimeoutMs <= 0) {
    return {
      ok: false,
      error: 'Invalid value for --shutdown-timeout-ms',
    };
  }

  if (
    (process.env.AO_SESSION_NAME == null || process.env.AO_SESSION_NAME === '')
      && (process.env.AO_SESSION_ID == null || process.env.AO_SESSION_ID === '')
      && (options.holderId == null || options.holderId.trim() === '')
  ) {
    return {
      ok: false,
      error: 'Manual controller runs require --holder when AO_SESSION_NAME/AO_SESSION_ID are unset',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-controller.js [options]',
    '',
    'Options:',
    '  --project <project_id>      AO project id. Default: my-project',
    '  --controller <id>           Controller id. Default: default',
    '  --holder <id>               Durable holder identity for manual controller runs',
    '  --mode <observe|shadow|assist> Override the durable controller mode',
    '  --issue <number>            Limit one loop to a specific issue-backed task',
    '  --continuous                Run the controller continuously until stopped',
    '  --poll-interval-ms <ms>     Continuous-mode poll interval. Default: 30000',
    '  --shutdown-timeout-ms <ms>  Continuous-mode shutdown grace bound. Default: 10000',
    '  --json                      Print machine-readable JSON output',
    '  -h, --help                  Show help',
  ].join('\n');
}

function renderHumanSummary(result) {
  const taskSummaries = result.task_results.map((taskResult) => `${taskResult.task_id}:${taskResult.derived_trigger}:${taskResult.proposed_action_count}`);

  return [
    `controller_id: ${result.controller_id}`,
    `mode: ${result.mode}`,
    `runtime_kind: ${result.runtime_kind ?? 'oneshot'}`,
    `pass_count: ${result.pass_count ?? 1}`,
    `stop_reason: ${result.stop_reason ?? 'completed'}`,
    `processed_tasks: ${result.processed_task_count}`,
    `ingested_observations: ${result.ingested_observation_count}`,
    `proposed_actions: ${result.proposed_action_count}`,
    `executed_actions: ${result.executed_action_count ?? 0}`,
    `blocked_actions: ${result.blocked_action_count ?? 0}`,
    `task_results: ${taskSummaries.length ? taskSummaries.join(', ') : 'none'}`,
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: 4,
      result: null,
    };
  }

  const { options } = parsed;
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return {
      exitCode: 0,
      result: null,
    };
  }

  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    io.writeStderr(`Could not locate repo root from ${cwd}\n`);
    return {
      exitCode: 3,
      result: null,
    };
  }

  const stopSignal = {
    aborted: false,
    requested_at: null,
  };
  const requestStop = () => {
    if (stopSignal.aborted) return;
    stopSignal.aborted = true;
    stopSignal.requested_at = new Date().toISOString();
  };

  try {
    process.once('SIGINT', requestStop);
    process.once('SIGTERM', requestStop);

    const result = await runControllerLoop({
      repoRoot,
      cwd,
      projectId: options.projectId,
      controllerId: options.controllerId,
      holderId: options.holderId,
      mode: options.mode,
      issueNumber: options.issueNumber,
      continuous: options.continuous,
      pollIntervalMs: options.pollIntervalMs,
      shutdownTimeoutMs: options.shutdownTimeoutMs,
      stopSignal,
    });

    if (options.json) {
      io.writeStdout(JSON.stringify(result, null, 2));
    } else {
      io.writeStdout(`${renderHumanSummary(result)}\n`);
    }

    return {
      exitCode: 0,
      result,
    };
  } catch (error) {
    io.writeStderr(`${error.message}\n`);
    return {
      exitCode: 3,
      result: null,
    };
  } finally {
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
