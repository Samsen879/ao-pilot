#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReviewProtocol } from './ao/lib/review-protocol.js';
import { deriveReviewPosture, REVIEW_VERDICTS } from './ao/lib/review-contracts.js';
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

function parseJsonValue(value, optionName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON for ${optionName}: ${error.message}`);
  }
}

function readJsonSource({
  jsonValue = null,
  filePath = null,
  optionName,
  defaultValue,
} = {}) {
  if (jsonValue != null && filePath != null) {
    throw new Error(`Specify only one of ${optionName}-json or ${optionName}-file`);
  }
  if (jsonValue != null) {
    return parseJsonValue(jsonValue, `${optionName}-json`);
  }
  if (filePath != null) {
    return parseJsonValue(fs.readFileSync(path.resolve(filePath), 'utf8'), `${optionName}-file`);
  }
  return defaultValue;
}

function parseArgs(argv) {
  const options = {
    command: null,
    projectId: DEFAULT_PROJECT_ID,
    taskId: null,
    issueNumber: null,
    reviewId: null,
    requestedBySessionName: process.env.AO_SESSION_NAME ?? null,
    requestedBySessionId: process.env.AO_SESSION_ID ?? null,
    implementationSessionName: process.env.AO_SESSION_NAME ?? null,
    implementationSessionId: process.env.AO_SESSION_ID ?? null,
    reviewerSessionName: process.env.AO_SESSION_NAME ?? null,
    reviewerSessionId: process.env.AO_SESSION_ID ?? null,
    targetBranch: null,
    targetHeadSha: null,
    verificationBaselineJson: null,
    verificationBaselineFile: null,
    findingsSummaryJson: null,
    findingsSummaryFile: null,
    baselineExecutionJson: null,
    baselineExecutionFile: null,
    verdict: null,
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
    } else if (arg === '--review') {
      options.reviewId = readOptionValue(argv, index, '--review');
      index += 1;
    } else if (arg === '--requested-by-session') {
      options.requestedBySessionName = readOptionValue(argv, index, '--requested-by-session');
      index += 1;
    } else if (arg === '--requested-by-session-id') {
      options.requestedBySessionId = readOptionValue(argv, index, '--requested-by-session-id');
      index += 1;
    } else if (arg === '--implementation-session') {
      options.implementationSessionName = readOptionValue(argv, index, '--implementation-session');
      index += 1;
    } else if (arg === '--implementation-session-id') {
      options.implementationSessionId = readOptionValue(argv, index, '--implementation-session-id');
      index += 1;
    } else if (arg === '--reviewer-session') {
      options.reviewerSessionName = readOptionValue(argv, index, '--reviewer-session');
      index += 1;
    } else if (arg === '--reviewer-session-id') {
      options.reviewerSessionId = readOptionValue(argv, index, '--reviewer-session-id');
      index += 1;
    } else if (arg === '--target-branch') {
      options.targetBranch = readOptionValue(argv, index, '--target-branch');
      index += 1;
    } else if (arg === '--target-sha') {
      options.targetHeadSha = readOptionValue(argv, index, '--target-sha');
      index += 1;
    } else if (arg === '--verification-baseline-json') {
      options.verificationBaselineJson = readOptionValue(argv, index, '--verification-baseline-json');
      index += 1;
    } else if (arg === '--verification-baseline-file') {
      options.verificationBaselineFile = readOptionValue(argv, index, '--verification-baseline-file');
      index += 1;
    } else if (arg === '--findings-summary-json') {
      options.findingsSummaryJson = readOptionValue(argv, index, '--findings-summary-json');
      index += 1;
    } else if (arg === '--findings-summary-file') {
      options.findingsSummaryFile = readOptionValue(argv, index, '--findings-summary-file');
      index += 1;
    } else if (arg === '--baseline-execution-json') {
      options.baselineExecutionJson = readOptionValue(argv, index, '--baseline-execution-json');
      index += 1;
    } else if (arg === '--baseline-execution-file') {
      options.baselineExecutionFile = readOptionValue(argv, index, '--baseline-execution-file');
      index += 1;
    } else if (arg === '--verdict') {
      options.verdict = readOptionValue(argv, index, '--verdict');
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

  if (!['request', 'claim', 'verdict', 'inspect'].includes(options.command)) {
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

  if (options.verdict != null && !REVIEW_VERDICTS.includes(options.verdict)) {
    return {
      ok: false,
      error: 'Invalid value for --verdict',
    };
  }

  try {
    options.verificationBaseline = readJsonSource({
      jsonValue: options.verificationBaselineJson,
      filePath: options.verificationBaselineFile,
      optionName: '--verification-baseline',
      defaultValue: [],
    });
    options.findingsSummary = readJsonSource({
      jsonValue: options.findingsSummaryJson,
      filePath: options.findingsSummaryFile,
      optionName: '--findings-summary',
      defaultValue: [],
    });
    options.baselineExecution = readJsonSource({
      jsonValue: options.baselineExecutionJson,
      filePath: options.baselineExecutionFile,
      optionName: '--baseline-execution',
      defaultValue: null,
    });
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }

  return {
    ok: true,
    options,
  };
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-review.js <command> [options]',
    '',
    'Commands:',
    '  request     Create a durable independent review request',
    '  claim       Record a reviewer claim',
    '  verdict     Record a reviewer verdict',
    '  inspect     Inspect one task review state',
    '',
    'Options:',
    '  --project <project_id>                 AO project id. Default: my-project',
    '  --task <task_id>                       Managed task id',
    '  --issue <number>                       Issue number used to derive task id',
    '  --review <review_id>                   Review record id',
    '  --requested-by-session <name>          Requesting session name',
    '  --requested-by-session-id <id>         Requesting session id',
    '  --implementation-session <name>        Implementation session name',
    '  --implementation-session-id <id>       Implementation session id',
    '  --reviewer-session <name>              Reviewer session name',
    '  --reviewer-session-id <id>             Reviewer session id',
    '  --target-branch <name>                 Target branch under review',
    '  --target-sha <sha>                     Fixed target head SHA under review',
    '  --verification-baseline-json <json>    Review verification baseline JSON',
    '  --verification-baseline-file <path>    Path to review verification baseline JSON',
    '  --findings-summary-json <json>         Findings summary JSON',
    '  --findings-summary-file <path>         Path to findings summary JSON',
    '  --baseline-execution-json <json>       Baseline execution evidence JSON',
    '  --baseline-execution-file <path>       Path to baseline execution evidence JSON',
    '  --verdict <pass|changes_required|escalate_human>',
    '  --json                                 Print machine-readable JSON output',
    '  -h, --help                             Show help',
  ].join('\n');
}

function deriveDisplayPosture(result) {
  if (result?.posture) return result;
  const derived = deriveReviewPosture(result);
  return {
    ...result,
    posture: derived.posture,
    freeze_active: derived.freeze_active,
  };
}

function renderHumanSummary(result) {
  if (Array.isArray(result)) {
    return result.map((item) => renderHumanSummary(item)).join('\n\n');
  }

  const display = deriveDisplayPosture(result);
  return [
    `review: ${display.review_id ?? 'none'}`,
    `task: ${display.task_id ?? 'none'}`,
    `status: ${display.status ?? 'unknown'}`,
    `posture: ${display.posture ?? 'idle'}`,
    `reviewer: ${display.reviewer_session_name ?? 'none'}`,
    `target: ${display.target_branch ?? 'none'}@${display.target_head_sha ?? 'none'}`,
    `freeze: ${display.freeze_status ?? (display.freeze_active ? 'active' : 'released')}`,
    `verdict: ${display.verdict ?? 'none'}`,
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
    const repository = createStateRepository({
      repoRoot,
      projectId: options.projectId,
    });
    const protocol = createReviewProtocol({
      repository,
    });
    const payload = {
      taskId: options.taskId,
      issueNumber: options.issueNumber,
      reviewId: options.reviewId,
      requestedBySessionName: options.requestedBySessionName,
      requestedBySessionId: options.requestedBySessionId,
      implementationSessionName: options.implementationSessionName,
      implementationSessionId: options.implementationSessionId,
      reviewerSessionName: options.reviewerSessionName,
      reviewerSessionId: options.reviewerSessionId,
      targetBranch: options.targetBranch,
      targetHeadSha: options.targetHeadSha,
      verificationBaseline: options.verificationBaseline,
      verdict: options.verdict,
      findingsSummary: options.findingsSummary,
      baselineExecution: options.baselineExecution,
    };

    let result;
    if (options.command === 'request') {
      result = protocol.requestReview(payload);
    } else if (options.command === 'claim') {
      result = protocol.claimReview(payload);
    } else if (options.command === 'verdict') {
      result = protocol.recordVerdict(payload);
    } else {
      result = protocol.inspectTaskReview({
        taskId: options.taskId,
        issueNumber: options.issueNumber,
        reviewId: options.reviewId,
      });
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
