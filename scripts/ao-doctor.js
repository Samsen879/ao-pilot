#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DOCTOR_STRICT_EXIT_CODES,
} from './ao/lib/doctor-contracts.js';
import { buildDecisionChainReport } from './ao/lib/decision-chain.js';
import { createDecisionChainScope } from './ao/lib/decision-chain-contracts.js';
import { renderDoctorHumanSummary } from './ao/lib/doctor-report.js';
import { inspectRuntimeControl } from './ao/lib/runtime-control.js';
import {
  DEFAULT_PROJECT_ID,
  runDoctor,
} from './ao/lib/doctor-runner.js';

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
    json: false,
    strict: false,
    runtimeStore: null,
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
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--runtime-store') {
      const value = argv[index + 1] ?? null;
      if (value == null || value.startsWith('-')) {
        return { ok: false, error: 'Missing value for --runtime-store' };
      }
      options.runtimeStore = path.resolve(value);
      index += 1;
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

  return {
    ok: true,
    options,
  };
}

function exitCodeForReport(report, strict) {
  if (strict) {
    return DOCTOR_STRICT_EXIT_CODES[report.top_status] ?? DOCTOR_STRICT_EXIT_CODES.invalid_usage;
  }

  if (report.top_status === 'source_failure') return 3;
  return 0;
}

function renderHelp() {
  return [
    'Usage: node scripts/ao-doctor.js [options]',
    '',
    'Options:',
    '  --project <project_id>   Diagnose one AO project. Default: my-project',
    '  --pr <number>            Diagnose one explicit PR scope',
    '  --json                   Print machine-readable JSON output',
    '  --strict                 Use fixed diagnose-only exit-code mapping',
    '  --runtime-store <path>   Inspect an explicit managed runtime store',
    '  -h, --help               Show help',
  ].join('\n');
}

export async function runCli(argv, io = createDefaultIo(), {
  cwd = process.cwd(),
  defaultProjectId = DEFAULT_PROJECT_ID,
  env = process.env,
  inspectRuntime = inspectRuntimeControl,
} = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.writeStderr(`${parsed.error}\n`);
    return {
      exitCode: argv.includes('--strict') ? DOCTOR_STRICT_EXIT_CODES.invalid_usage : 4,
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

  const doctorResult = await runDoctor({
    projectId: options.projectId,
    prNumber: options.prNumber,
    cwd,
    env: options.runtimeStore == null
      ? env
      : { ...env, AO_PILOT_RUNTIME_STORE: options.runtimeStore },
  });
  const runtimeInspection = inspectRuntime({
    cwd,
    env,
    storeRoot: options.runtimeStore,
  });
  const runtimeBlocked = runtimeInspection.status !== 'verified';
  const baseTopStatus = doctorResult.report.top_status;
  const topStatus = runtimeBlocked && ['healthy', 'warning'].includes(baseTopStatus)
    ? 'blocked'
    : baseTopStatus;
  const runtimeFinding = runtimeBlocked ? [{
    code: runtimeInspection.runtime.code,
    severity: 'blocker',
    origin: 'doctor',
    source_area: 'runtime',
    subject_type: 'runtime',
    subject_id: runtimeInspection.runtime.runtime_ref,
    summary: runtimeInspection.runtime.message,
    details: [runtimeInspection.runtime.message],
    evidence_refs: [],
    suggestion_ids: [],
  }] : [];
  const sourceHealth = {
    ...doctorResult.report.source_health,
    runtime: runtimeBlocked ? 'failed' : 'ok',
  };
  const findings = [
    ...(doctorResult.report.findings ?? []),
    ...runtimeFinding,
  ];
  const report = {
    ...doctorResult.report,
    top_status: topStatus,
    source_health: sourceHealth,
    findings,
    runtime: runtimeInspection.runtime,
    authentication: runtimeInspection.authentication,
    decision_chain: buildDecisionChainReport({
      scope: createDecisionChainScope({
        projectId: options.projectId,
        prNumber: options.prNumber,
      }),
      reconciliationReport: doctorResult.reconciliationReport,
      doctorReport: {
        ...doctorResult.report,
        top_status: topStatus,
        source_health: sourceHealth,
        findings,
      },
    }),
  };

  if (options.json) {
    io.writeStdout(JSON.stringify(report, null, 2));
  } else {
    io.writeStdout(`${renderDoctorHumanSummary(report)}\n`);
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
