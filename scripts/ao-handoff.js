#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTaskContinuityFromSnapshot } from './ao/lib/continuity.js';
import { createHandoffProtocol } from './ao/lib/handoff-protocol.js';
import { findRepoRoot } from './ao/lib/repo-root.js';
import { createStateRepository } from './ao/lib/state-repository.js';

export const DEFAULT_PROJECT_ID = 'my-project';

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
    requestId: null,
    claimId: null,
    requestedBySessionName: null,
    requestedBySessionId: null,
    successorSessionName: null,
    successorSessionId: null,
    operatorSessionName: null,
    operatorSessionId: null,
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
    } else if (arg === '--request') {
      options.requestId = readOptionValue(argv, index, '--request');
      index += 1;
    } else if (arg === '--claim') {
      options.claimId = readOptionValue(argv, index, '--claim');
      index += 1;
    } else if (arg === '--successor-session') {
      options.successorSessionName = readOptionValue(argv, index, '--successor-session');
      index += 1;
    } else if (arg === '--successor-session-id') {
      options.successorSessionId = readOptionValue(argv, index, '--successor-session-id');
      index += 1;
    } else if (arg === '--operator-session') {
      options.operatorSessionName = readOptionValue(argv, index, '--operator-session');
      index += 1;
    } else if (arg === '--operator-session-id') {
      options.operatorSessionId = readOptionValue(argv, index, '--operator-session-id');
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
    return { ok: true, options };
  }

  if (!['request', 'claim', 'accept', 'reject', 'expire', 'inspect'].includes(options.command)) {
    return {
      ok: false,
      error: `Unsupported command: ${options.command ?? 'none'}`,
    };
  }

  if (options.issueNumber != null && (!Number.isInteger(options.issueNumber) || options.issueNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --issue',
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-handoff.js <command> [options]',
    '',
    'Commands:',
    '  request     Create a durable successor handoff request',
    '  claim       Record a successor claim',
    '  accept      Accept one successor claim',
    '  reject      Reject a handoff request or claim',
    '  expire      Expire a handoff request',
    '  inspect     Inspect one handoff request or task handoff state',
    '',
    'Options:',
    '  --project <project_id>           AO project id. Default: my-project',
    '  --task <task_id>                 Managed task id',
    '  --issue <number>                 Issue number used to derive task id',
    '  --request <request_id>           Handoff request id',
    '  --claim <claim_id>               Handoff claim id',
    '  --successor-session <name>       Successor session name',
    '  --successor-session-id <id>      Successor session id',
    '  --operator-session <name>        Operator session name',
    '  --operator-session-id <id>       Operator session id',
    '  --reason <text>                  Operation reason',
    '  --json                           Print machine-readable JSON output',
    '  -h, --help                       Show help',
  ].join('\n');
}

function renderHumanSummary(result) {
  if (Array.isArray(result)) {
    return result.map((inspection) => (
      `${inspection.task_id}: ${inspection.top_status} (${(inspection.reason_codes ?? []).join(', ') || 'none'})`
    )).join('\n');
  }

  if (result?.request_id) {
    return [
      `request: ${result.request_id}`,
      `task: ${result.task_id}`,
      `status: ${result.status ?? result.top_status ?? 'unknown'}`,
      `successor: ${result.successor_session_name ?? 'none'}`,
      `continuity: ${result.continuity ? `${result.continuity.posture} -> ${result.continuity.recommended_action}` : 'none'}`,
    ].join('\n');
  }

  return JSON.stringify(result, null, 2);
}

function attachContinuity(snapshot, result) {
  if (Array.isArray(result)) {
    return result.map((inspection) => ({
      ...inspection,
      continuity: inspection?.task_id == null
        ? null
        : buildTaskContinuityFromSnapshot({
            snapshot,
            taskId: inspection.task_id,
            checkpointInspection: inspection.checkpoint,
            handoffInspection: inspection,
          }),
    }));
  }

  if (result?.task_id == null || result?.top_status == null) {
    return result;
  }

  return {
    ...result,
    continuity: buildTaskContinuityFromSnapshot({
      snapshot,
      taskId: result.task_id,
      checkpointInspection: result.checkpoint,
      handoffInspection: result,
    }),
  };
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

  try {
    const repository = createStateRepository({
      repoRoot,
      projectId: options.projectId,
    });
    const protocol = createHandoffProtocol({
      repository,
    });
    const payload = {
      taskId: options.taskId,
      issueNumber: options.issueNumber,
      requestId: options.requestId,
      claimId: options.claimId,
      requestedBySessionName: options.requestedBySessionName,
      requestedBySessionId: options.requestedBySessionId,
      operatorSessionName: options.operatorSessionName,
      operatorSessionId: options.operatorSessionId,
      successorSessionName: options.successorSessionName,
      successorSessionId: options.successorSessionId,
      reason: options.reason,
    };

    let result;
    if (options.command === 'request') {
      result = protocol.requestHandoff(payload);
    } else if (options.command === 'claim') {
      result = protocol.claimHandoff(payload);
    } else if (options.command === 'accept') {
      result = protocol.acceptHandoff(payload);
    } else if (options.command === 'reject') {
      result = protocol.rejectHandoff(payload);
    } else if (options.command === 'expire') {
      result = protocol.expireHandoff(payload);
    } else if (options.requestId || options.taskId || options.issueNumber != null) {
      result = protocol.inspectTaskHandoff({
        taskId: options.taskId,
        issueNumber: options.issueNumber,
        requestId: options.requestId,
      });
      result = attachContinuity(repository.getSnapshot(), result);
    } else {
      result = protocol.inspectAllHandoffs();
      result = attachContinuity(repository.getSnapshot(), result);
    }

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
