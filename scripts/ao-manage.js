#!/usr/bin/env node

import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_PROJECT_ID,
  runManageCommand,
} from './ao/lib/manage-runner.js';
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
    command: null,
    projectId: DEFAULT_PROJECT_ID,
    taskId: null,
    issueNumber: null,
    title: null,
    branchName: null,
    worktreePath: null,
    prNumber: null,
    taskSpecFile: null,
    taskSpecBody: null,
    ownerSessionName: process.env.AO_SESSION_NAME ?? null,
    ownerSessionId: process.env.AO_SESSION_ID ?? null,
    reason: null,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (options.command == null && !arg.startsWith('-')) {
      options.command = arg;
      continue;
    }

    if (arg === '--project') {
      options.projectId = readOptionValue(argv, index, '--project');
      index += 1;
    } else if (arg === '--task') {
      options.taskId = readOptionValue(argv, index, '--task');
      index += 1;
    } else if (arg === '--issue') {
      options.issueNumber = Number(readOptionValue(argv, index, '--issue'));
      index += 1;
    } else if (arg === '--title') {
      options.title = readOptionValue(argv, index, '--title');
      index += 1;
    } else if (arg === '--branch') {
      options.branchName = readOptionValue(argv, index, '--branch');
      index += 1;
    } else if (arg === '--worktree') {
      options.worktreePath = readOptionValue(argv, index, '--worktree');
      index += 1;
    } else if (arg === '--pr') {
      options.prNumber = Number(readOptionValue(argv, index, '--pr'));
      index += 1;
    } else if (arg === '--task-spec-file') {
      options.taskSpecFile = readOptionValue(argv, index, '--task-spec-file');
      index += 1;
    } else if (arg === '--owner-session') {
      options.ownerSessionName = readOptionValue(argv, index, '--owner-session');
      index += 1;
    } else if (arg === '--owner-session-id') {
      options.ownerSessionId = readOptionValue(argv, index, '--owner-session-id');
      index += 1;
    } else if (arg === '--reason') {
      options.reason = readOptionValue(argv, index, '--reason');
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

  if (options.help) {
    return {
      ok: true,
      options,
    };
  }

  if (!['enroll', 'adopt', 'resume', 'unmanage', 'retire'].includes(options.command)) {
    return {
      ok: false,
      error: `Unsupported command: ${options.command ?? 'none'}`,
    };
  }

  if (options.taskId == null && (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --issue',
    };
  }

  if (options.prNumber != null && (!Number.isInteger(options.prNumber) || options.prNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --pr',
    };
  }

  if (options.command === 'enroll' && (!options.branchName || !options.worktreePath)) {
    return {
      ok: false,
      error: 'enroll requires --branch and --worktree',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-manage.js <command> [options]',
    '',
    'Commands:',
    '  enroll      Explicitly enroll one managed task',
    '  adopt       Re-activate a paused managed task and refresh bindings',
    '  resume      Re-activate work from the latest valid checkpoint',
    '  unmanage    Pause active management while preserving bindings',
    '  retire      Retire the managed task and release active bindings',
    '',
    'Options:',
    '  --project <project_id>      AO project id. Default: my-project',
    '  --task <task_id>            Explicit managed task id',
    '  --issue <number>            Issue number used to derive task id',
    '  --title <text>              Managed task title',
    '  --branch <name>             Durable branch binding',
    '  --worktree <path>           Durable worktree binding',
    '  --task-spec-file <path>     Markdown issue/template input used to build TaskSpec v1',
    '  --pr <number>               Durable PR binding',
    '  --owner-session <name>      Ownership session name',
    '  --owner-session-id <id>     Ownership session id',
    '  --reason <text>             Transition reason',
    '  --json                      Print machine-readable JSON output',
    '  -h, --help                  Show help',
  ].join('\n');
}

function renderHumanSummary(result) {
  return [
    `command: ${result.command}`,
    `task: ${result.task.task_id} status=${result.task.status}`,
    `pr_binding: ${result.prBinding ? `${result.prBinding.pr_number}/${result.prBinding.status}` : 'none'}`,
    `ownership_lease: ${result.ownershipLease ? `${result.ownershipLease.owner_session_name}/${result.ownershipLease.status}` : 'none'}`,
    `resume_checkpoint: ${result.resume ? `${result.resume.checkpoint_id}/${result.resume.state}` : 'none'}`,
    `handoff_transfer: ${result.handoffTransfer ? `${result.handoffTransfer.request_id}/${result.handoffTransfer.transfer_id}` : 'none'}`,
    `continuity: ${result.continuity ? `${result.continuity.posture} -> ${result.continuity.recommended_action} owner=${result.continuity.owner_session_name ?? 'none'} successor=${result.continuity.successor_session_name ?? 'none'} checkpoint=${result.continuity.checkpoint_state ?? 'none'}` : 'none'}`,
    `review: ${result.review ? `${result.review.posture ?? 'idle'} freeze=${result.review.freeze_status ?? 'released'} reviewer=${result.review.reviewer_session_name ?? 'none'} target=${result.review.target_head_sha ?? 'none'} reason=${result.review.blocking_reason ?? 'none'}` : 'none'}`,
    `released_ownership_leases: ${result.releasedOwnershipLeaseIds.length ? result.releasedOwnershipLeaseIds.join(', ') : 'none'}`,
    `released_pr_bindings: ${result.releasedPrBindingIds.length ? result.releasedPrBindingIds.join(', ') : 'none'}`,
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo()) {
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

  const repoRoot = findRepoRoot(process.cwd());
  if (!repoRoot) {
    io.writeStderr(`Could not locate repo root from ${process.cwd()}\n`);
    return {
      exitCode: 3,
      result: null,
    };
  }

  try {
    if (options.taskSpecFile) {
      options.taskSpecBody = fs.readFileSync(path.resolve(options.taskSpecFile), 'utf8');
    }

    const result = await runManageCommand({
      repoRoot,
      cwd: process.cwd(),
      projectId: options.projectId,
      command: options.command,
      taskId: options.taskId,
      issueNumber: options.issueNumber,
      title: options.title,
      branchName: options.branchName,
      worktreePath: options.worktreePath,
      prNumber: options.prNumber,
      taskSpecBody: options.taskSpecBody,
      ownerSessionName: options.ownerSessionName,
      ownerSessionId: options.ownerSessionId,
      reason: options.reason,
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
  }
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
