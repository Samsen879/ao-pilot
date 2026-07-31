#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_STRICT_EXIT_CODES,
  createLifecycleProjectScope,
  createLifecyclePrScope,
  normalizeLifecycleTrigger,
} from './ao/lib/lifecycle-contracts.js';
import {
  DEFAULT_PROJECT_ID,
  runDoctor,
} from './ao/lib/doctor-runner.js';
import { buildDecisionChainReport } from './ao/lib/decision-chain.js';
import { buildLifecycleReport } from './ao/lib/lifecycle-engine.js';
import { renderLifecycleHumanSummary } from './ao/lib/lifecycle-report.js';
import { deriveReviewPosture } from './ao/lib/review-contracts.js';

function createDefaultIo() {
  return {
    writeStdout: (text) => process.stdout.write(text),
    writeStderr: (text) => process.stderr.write(text),
  };
}

function parseArgs(argv) {
  const options = {
    projectId: DEFAULT_PROJECT_ID,
    explicitProject: false,
    prNumber: null,
    trigger: 'manual',
    json: false,
    strict: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.projectId = argv[index + 1] ?? null;
      options.explicitProject = true;
      index += 1;
    } else if (arg === '--pr') {
      const value = argv[index + 1] ?? null;
      options.prNumber = value == null ? null : Number(value);
      index += 1;
    } else if (arg === '--trigger') {
      options.trigger = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      return {
        ok: false,
        error: `Unknown argument: ${arg}`,
      };
    }
  }

  if (options.explicitProject && options.prNumber != null) {
    return {
      ok: false,
      error: 'Cannot use --project and --pr together',
    };
  }

  if (options.projectId == null || options.projectId === '') {
    return {
      ok: false,
      error: 'Missing value for --project',
    };
  }

  if (options.prNumber != null && (!Number.isInteger(options.prNumber) || options.prNumber <= 0)) {
    return {
      ok: false,
      error: 'Invalid value for --pr',
    };
  }

  try {
    options.trigger = normalizeLifecycleTrigger(options.trigger);
  } catch {
    return {
      ok: false,
      error: 'Invalid value for --trigger',
    };
  }

  return {
    ok: true,
    options,
  };
}

function exitCodeForReport(report, strict) {
  if (strict) {
    return LIFECYCLE_STRICT_EXIT_CODES[report.top_status] ?? LIFECYCLE_STRICT_EXIT_CODES.invalid_usage;
  }

  if (report.top_status === 'source_failure') return 3;
  return 0;
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-lifecycle.js [options]',
    '',
    'Options:',
    '  --project <project_id>   Diagnose one AO project. Default: my-project',
    '  --pr <number>            Diagnose one explicit PR scope',
    '  --trigger <name>         Lifecycle trigger. Default: manual',
    '  --json                   Print machine-readable JSON output',
    '  --strict                 Use fixed lifecycle strict exit-code mapping',
    '  -h, --help               Show help',
  ].join('\n');
}

function compareIsoDescending(left, right) {
  return String(right ?? '').localeCompare(String(left ?? ''));
}

function resolveReviewInspection({ controlPlaneSnapshot, prNumber } = {}) {
  if (!controlPlaneSnapshot || !Number.isInteger(prNumber)) {
    return {
      reviewRequired: false,
      reviewInspection: null,
    };
  }

  const taskId = (controlPlaneSnapshot.state?.pr_bindings ?? []).find((binding) => (
    binding?.pr_number === prNumber && binding?.status === 'bound'
  ))?.task_id ?? null;
  if (!taskId) {
    return {
      reviewRequired: false,
      reviewInspection: null,
    };
  }

  const reviewRecord = [...(controlPlaneSnapshot.state?.review_records ?? [])]
    .filter((record) => record?.task_id === taskId)
    .sort((left, right) => {
      const byTimestamp = compareIsoDescending(left?.updated_at, right?.updated_at);
      if (byTimestamp !== 0) return byTimestamp;
      return String(right?.review_id ?? '').localeCompare(String(left?.review_id ?? ''));
    })[0] ?? null;
  if (!reviewRecord) {
    return {
      reviewRequired: false,
      reviewInspection: null,
    };
  }

  const posture = deriveReviewPosture(reviewRecord);
  return {
    reviewRequired: true,
    reviewInspection: {
      task_id: reviewRecord.task_id,
      issue_number: reviewRecord.issue_number ?? null,
      review_id: reviewRecord.review_id,
      reviewer_session_name: reviewRecord.reviewer_session_name ?? null,
      target_head_sha: reviewRecord.target_head_sha ?? null,
      freeze_status: reviewRecord.freeze_status ?? null,
      posture: posture.posture,
      freeze_active: posture.freeze_active,
    },
  };
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
  defaultProjectId = DEFAULT_PROJECT_ID,
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: argv.includes('--strict') ? LIFECYCLE_STRICT_EXIT_CODES.invalid_usage : 4,
      report: null,
    };
  }

  const { options } = parsed;
  if (!options.explicitProject) {
    options.projectId = defaultProjectId;
  }
  if (options.help) {
    io.writeStdout(`${renderHelp()}\n`);
    return {
      exitCode: 0,
      report: null,
    };
  }

  const scope = options.prNumber != null
    ? createLifecyclePrScope({
        projectId: options.projectId,
        prNumber: options.prNumber,
        trigger: options.trigger,
      })
    : createLifecycleProjectScope({
        projectId: options.projectId,
        trigger: options.trigger,
      });

  const doctorResult = await runDoctor({
    projectId: options.projectId,
    prNumber: options.prNumber,
    cwd,
  });
  const { reviewRequired, reviewInspection } = resolveReviewInspection({
    controlPlaneSnapshot: doctorResult.controlPlaneSnapshot ?? null,
    prNumber: options.prNumber,
  });
  const lifecycleReport = buildLifecycleReport({
    scope,
    reconciliationReport: doctorResult.reconciliationReport,
    doctorReport: doctorResult.report,
    reviewRequired,
    reviewInspection,
    currentHeadSha: doctorResult.localState?.head_sha ?? null,
  });
  const report = {
    ...lifecycleReport,
    decision_chain: buildDecisionChainReport({
      scope,
      reconciliationReport: doctorResult.reconciliationReport,
      doctorReport: doctorResult.report,
      lifecycleReport,
    }),
  };

  if (options.json) {
    io.writeStdout(JSON.stringify(report, null, 2));
  } else {
    io.writeStdout(`${renderLifecycleHumanSummary(report)}\n`);
  }

  return {
    exitCode: exitCodeForReport(report, options.strict),
    report,
  };
}

const currentFile = fileURLToPath(import.meta.url);
const executedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (executedFile && executedFile === currentFile) {
  const { exitCode } = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
