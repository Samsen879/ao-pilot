#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_AO_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_FIXTURE_PATH = path.join(
  HERE,
  'fixtures',
  'generic-v1',
  'scenario.json',
);
export const DEFAULT_APPROVED_DIFFERENCES_PATH = path.join(
  HERE,
  'fixtures',
  'approved-differences.json',
);
export const MISSING_VALUE = '__AO_CONSOLIDATION_MISSING__';

const FIXTURE_SCHEMA_VERSION = 'ao.consolidation.fixture.v1';
const REPORT_SCHEMA_VERSION = 'ao.consolidation.parity-report.v1';
const APPROVAL_SCHEMA_VERSION = 'ao.consolidation.approved-differences.v1';

const REQUIRED_MODULES = {
  stateContracts: {
    path: 'scripts/ao/lib/state-contracts.js',
    exports: [
      'CONTROL_PLANE_LATEST_VERSION',
      'createActionRecord',
      'createControllerModeRecord',
      'createEmptyControlPlaneState',
      'createManagedTask',
      'createOwnershipLease',
      'createPrBinding',
      'createTaskSpecRecord',
    ],
  },
  stateMigrations: {
    path: 'scripts/ao/lib/state-migrations.js',
    exports: ['bootstrapControlPlaneState'],
  },
  stateRepository: {
    path: 'scripts/ao/lib/state-repository.js',
    exports: ['createStateRepository'],
  },
  observation: {
    path: 'scripts/ao/lib/ao-observation-source.js',
    exports: ['loadAoProjectObservation'],
  },
  reconciliationContracts: {
    path: 'scripts/ao/lib/reconciliation-contracts.js',
    exports: ['createPrScope'],
  },
  reconciliation: {
    path: 'scripts/ao/lib/reconciliation-engine.js',
    exports: ['reconcileObservations'],
  },
  doctorContracts: {
    path: 'scripts/ao/lib/doctor-contracts.js',
    exports: ['createDoctorLocalState', 'createDoctorPrScope'],
  },
  doctor: {
    path: 'scripts/ao/lib/doctor-engine.js',
    exports: ['buildDoctorReport'],
  },
  lifecycleContracts: {
    path: 'scripts/ao/lib/lifecycle-contracts.js',
    exports: ['createLifecyclePrScope'],
  },
  lifecycle: {
    path: 'scripts/ao/lib/lifecycle-engine.js',
    exports: ['buildLifecycleReport'],
  },
  policy: {
    path: 'scripts/ao/lib/policy-engine.js',
    exports: ['evaluatePolicyDecision'],
  },
  policyRules: {
    path: 'scripts/ao/lib/policy-rules.js',
    exports: ['createDefaultPolicyRules'],
  },
  action: {
    path: 'scripts/ao/lib/action-executor.js',
    exports: [
      'buildAssistActionModel',
      'executeAssistActions',
      'summarizeAssistActionRecord',
    ],
  },
  checkpoint: {
    path: 'scripts/ao/lib/checkpoint-store.js',
    exports: ['createCheckpointStore'],
  },
  review: {
    path: 'scripts/ao/lib/review-protocol.js',
    exports: ['createReviewProtocol'],
  },
  handoff: {
    path: 'scripts/ao/lib/handoff-protocol.js',
    exports: ['createHandoffProtocol'],
  },
  metrics: {
    path: 'scripts/ao/lib/run-metrics.js',
    exports: ['buildAoMetricsReport'],
  },
  evaluation: {
    path: 'scripts/ao/lib/eval-harness.js',
    exports: ['runAoEvalHarness'],
  },
  scorecard: {
    path: 'scripts/ao/lib/scorecard.js',
    exports: ['buildAoEvalScorecard'],
  },
};

export class ParityHarnessError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ParityHarnessError';
    this.code = code;
    this.details = details;
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new ParityHarnessError(
      'invalid_json',
      `Unable to read ${label} at ${filePath}: ${error.message}`,
      { file_path: filePath },
    );
  }
}

function validateFixture(fixture, fixturePath) {
  if (fixture?.schema_version !== FIXTURE_SCHEMA_VERSION) {
    throw new ParityHarnessError(
      'invalid_fixture',
      `Unsupported consolidation fixture schema at ${fixturePath}`,
      { expected: FIXTURE_SCHEMA_VERSION, actual: fixture?.schema_version ?? null },
    );
  }
  if (typeof fixture?.fixture_id !== 'string' || fixture.fixture_id.trim() === '') {
    throw new ParityHarnessError('invalid_fixture', 'Fixture id is required');
  }
  if (!Array.isArray(fixture?.expectations) || fixture.expectations.length === 0) {
    throw new ParityHarnessError('invalid_fixture', 'Fixture expectations are required');
  }
}

export function loadFixture(fixturePath = DEFAULT_FIXTURE_PATH) {
  const resolved = path.resolve(fixturePath);
  const fixture = readJson(resolved, 'consolidation fixture');
  validateFixture(fixture, resolved);
  return { fixture, fixturePath: resolved };
}

function normalizeString(value, context) {
  let result = value;
  for (const root of context.tempRoots ?? []) {
    if (root) result = result.split(root).join('<TEMP_REPO>');
  }
  if (context.harnessCwd) {
    result = result.split(context.harnessCwd).join('<HARNESS_CWD>');
  }
  result = result.replace(/\/proc\/\d+/g, '/proc/<PID>');
  result = result.replace(/^\/tmp\//, '<TMP>/');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(result)) {
    return '<TIMESTAMP>';
  }
  return result;
}

export function canonicalize(value, context = {}, key = null) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, context, null));
  }
  if (value != null && typeof value === 'object') {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .reduce((result, childKey) => {
        if (value[childKey] !== undefined) {
          result[childKey] = canonicalize(value[childKey], context, childKey);
        }
        return result;
      }, {});
  }
  if (typeof value === 'number' && /(^|_)pid$|process_id/.test(key ?? '')) {
    return '<PID>';
  }
  if (typeof value === 'string') return normalizeString(value, context);
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function buildStableFingerprint(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export async function loadImplementation(repoRoot, label = 'implementation') {
  const resolvedRoot = path.resolve(repoRoot);
  if (!fs.existsSync(path.join(resolvedRoot, 'package.json'))) {
    throw new ParityHarnessError(
      'invalid_repository',
      `${label} root does not contain package.json: ${resolvedRoot}`,
      { implementation: label, repo_root: resolvedRoot },
    );
  }

  const modules = {};
  for (const [moduleName, spec] of Object.entries(REQUIRED_MODULES)) {
    const modulePath = path.join(resolvedRoot, spec.path);
    if (!fs.existsSync(modulePath)) {
      throw new ParityHarnessError(
        'missing_parity_module',
        `${label} is missing parity-required module ${spec.path}`,
        { implementation: label, module: spec.path },
      );
    }
    let imported;
    try {
      imported = await import(pathToFileURL(modulePath).href);
    } catch (error) {
      throw new ParityHarnessError(
        'module_import_failed',
        `${label} could not import ${spec.path}: ${error.message}`,
        { implementation: label, module: spec.path },
      );
    }
    for (const exportName of spec.exports) {
      if (!(exportName in imported)) {
        throw new ParityHarnessError(
          'missing_parity_export',
          `${label} ${spec.path} is missing required export ${exportName}`,
          { implementation: label, module: spec.path, export_name: exportName },
        );
      }
    }
    modules[moduleName] = imported;
  }

  return {
    label,
    repoRoot: resolvedRoot,
    modules,
    requiredModulePaths: Object.values(REQUIRED_MODULES).map((spec) => spec.path),
  };
}

function writeFakeAoProvider(fakeBinRoot) {
  fs.mkdirSync(fakeBinRoot, { recursive: true });
  const commandPath = path.join(fakeBinRoot, 'ao');
  fs.writeFileSync(commandPath, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const receiptPath = process.env.AO_CONSOLIDATION_RECEIPT_PATH;',
    'const payloadPath = process.env.AO_CONSOLIDATION_FAKE_PAYLOAD_PATH;',
    "const payload = payloadPath ? fs.readFileSync(payloadPath, 'utf8') : '{}';",
    'const receipt = { args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, payload_bytes: Buffer.byteLength(payload) };',
    "if (receiptPath) fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');",
    'process.stdout.write(payload);',
    '',
  ].join('\n'), 'utf8');
  fs.chmodSync(commandPath, 0o755);
}

function restoreEnvironment(saved) {
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

async function runObservation({ modules, fixture, tempRoot }) {
  const fakeBinRoot = path.join(tempRoot, 'fake-bin');
  const receiptPath = path.join(tempRoot, 'fake-provider-receipt.json');
  const payloadPath = path.join(tempRoot, 'fake-provider-payload.json');
  const observationFixtureRoot = path.join(tempRoot, 'observation-fixture');
  const payload = JSON.stringify(fixture.ao_status);
  const calls = [];
  const fakeRunner = {
    run(command, args = [], options = {}) {
      calls.push({
        command,
        args: args.map((item) => String(item)),
        cwd: options.cwd ?? process.cwd(),
      });
      return {
        status: 0,
        signal: null,
        stdout: payload,
        stderr: '',
        error: null,
      };
    },
  };
  writeFakeAoProvider(fakeBinRoot);
  fs.writeFileSync(payloadPath, payload, 'utf8');
  fs.mkdirSync(observationFixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(observationFixtureRoot, 'ao-status.json'), payload, 'utf8');

  const saved = {
    AO_FIXTURE_ROOT: process.env.AO_FIXTURE_ROOT,
    AO_CONSOLIDATION_RECEIPT_PATH: process.env.AO_CONSOLIDATION_RECEIPT_PATH,
    AO_CONSOLIDATION_FAKE_PAYLOAD_PATH: process.env.AO_CONSOLIDATION_FAKE_PAYLOAD_PATH,
    PATH: process.env.PATH,
  };
  delete process.env.AO_FIXTURE_ROOT;
  process.env.AO_CONSOLIDATION_RECEIPT_PATH = receiptPath;
  process.env.AO_CONSOLIDATION_FAKE_PAYLOAD_PATH = payloadPath;
  process.env.PATH = `${fakeBinRoot}${path.delimiter}${saved.PATH ?? ''}`;

  try {
    // First exercise the command boundary against an injected/PATH-isolated
    // fake. The semantic observation replay below uses a checked-in payload so
    // both implementations receive identical input even if only one currently
    // supports commandRunner injection.
    await modules.observation.loadAoProjectObservation({
      projectId: fixture.project_id,
      now: fixture.timing.observation_at,
      commandRunner: fakeRunner,
    });
    const processReceipt = fs.existsSync(receiptPath)
      ? readJson(receiptPath, 'fake provider receipt')
      : null;
    if (
      processReceipt?.payload_bytes != null
        && processReceipt.payload_bytes !== Buffer.byteLength(payload)
    ) {
      throw new ParityHarnessError(
        'fake_provider_payload_mismatch',
        'PATH-isolated fake provider did not receive the expected payload',
        {
          expected_bytes: Buffer.byteLength(payload),
          actual_bytes: processReceipt.payload_bytes,
        },
      );
    }
    const call = calls[0] ?? (processReceipt == null ? null : {
      command: 'ao',
      args: processReceipt.args,
      cwd: processReceipt.cwd,
    });
    if (!call) {
      throw new ParityHarnessError(
        'provider_intent_missing',
        'Observation source did not invoke the injected or PATH-isolated fake AO provider',
      );
    }
    process.env.AO_FIXTURE_ROOT = observationFixtureRoot;
    const observation = await modules.observation.loadAoProjectObservation({
      projectId: fixture.project_id,
      now: fixture.timing.observation_at,
      commandRunner: fakeRunner,
    });
    if (observation?.source_ok !== true) {
      throw new ParityHarnessError(
        'fixture_observation_failed',
        `Checked-in observation fixture was rejected: ${observation?.source_error ?? 'unknown error'}`,
      );
    }
    return {
      observation,
      providerIntent: {
        command: call.command,
        args: call.args,
        cwd: '<HARNESS_CWD>',
      },
      providerReceipt: {
        status: 0,
        stdout_sha256: createHash('sha256').update(payload).digest('hex'),
        stderr: '',
        fake_provider_call_count: 1,
        production_effect_count: 0,
      },
    };
  } finally {
    restoreEnvironment(saved);
  }
}

function nextAuditIdGenerator() {
  let index = 0;
  return () => {
    index += 1;
    return `audit-${String(index).padStart(3, '0')}`;
  };
}

function seedRepository(modules, repository, fixture) {
  const { task, timing } = fixture;
  const contracts = modules.stateContracts;
  repository.upsertManagedTask(contracts.createManagedTask({
    task_id: task.task_id,
    issue_number: task.issue_number,
    title: task.title,
    branch_name: task.branch_name,
    worktree_path: task.worktree_path,
    status: 'active',
    created_at: timing.created_at,
    updated_at: timing.created_at,
  }));
  repository.upsertPrBinding(contracts.createPrBinding({
    binding_id: `binding-${task.task_id}-pr-${task.pr_number}`,
    task_id: task.task_id,
    pr_number: task.pr_number,
    branch_name: task.branch_name,
    base_branch: 'main',
    status: 'bound',
    created_at: timing.created_at,
    updated_at: timing.created_at,
  }));
  repository.upsertOwnershipLease(contracts.createOwnershipLease({
    lease_id: `ownership-${task.task_id}-${task.owner_session_name}`,
    task_id: task.task_id,
    owner_session_name: task.owner_session_name,
    owner_session_id: task.owner_session_id,
    status: 'active',
    acquired_at: timing.created_at,
    expires_at: timing.lease_expires_at,
  }));
  repository.upsertControllerMode(contracts.createControllerModeRecord({
    controller_id: 'default',
    mode: 'observe',
    updated_at: timing.created_at,
    updated_by: 'parity_harness',
    reason: 'Deterministic consolidation fixture',
  }));
  repository.upsertTaskSpec(contracts.createTaskSpecRecord({
    task_id: task.task_id,
    source_kind: 'consolidation_fixture',
    source_issue_number: task.issue_number,
    created_at: timing.created_at,
    updated_at: timing.created_at,
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Generic behavioral parity is preserved.'],
        runtime_ref: 'runtime.github_local',
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_review'],
      },
    },
  }));
  repository.ensureRuntimePreflights({
    // The probes are fully fake. A stable virtual cwd keeps the preflight replay
    // key semantic and comparable instead of hashing a random mkdtemp suffix.
    cwd: '/virtual/ao-consolidation-repo',
    now: timing.created_at,
    probes: {
      commandExists: () => true,
      pathExists: () => true,
      capability: () => true,
    },
  });
}

function summarizeFindings(findings = []) {
  return findings.map((finding) => ({
    code: finding.code,
    severity: finding.severity ?? null,
    origin: finding.origin ?? null,
    subject_type: finding.subject_type ?? null,
    subject_id: finding.subject_id ?? null,
  }));
}

function summarizeActions(actions = []) {
  return actions.map((action) => ({
    id: action.id ?? null,
    action_class: action.action_class,
    commands: action.commands ?? [],
    summary: action.summary,
  }));
}

async function runPolicyAndAction({ modules, repository, fixture }) {
  const { task, timing } = fixture;
  const taskRecord = repository.getSnapshot().state.managed_tasks[0];
  const runtimePreflight = repository.getSnapshot().state.runtime_preflights[0];
  const policy = modules.policy.evaluatePolicyDecision({
    input: fixture.policy_input,
    rules: modules.policyRules.createDefaultPolicyRules(),
  });
  const model = modules.action.buildAssistActionModel({
    controllerId: 'default',
    task: taskRecord,
    prNumber: task.pr_number,
    derivedTrigger: 'manual',
    lifecycleTopStatus: 'continue',
    runtimeRef: 'runtime.github_local',
    runtimePreflight,
    action: fixture.action,
  });
  repository.upsertAction(modules.stateContracts.createActionRecord({
    action_id: 'action-parity-1',
    task_id: task.task_id,
    action_kind: fixture.action.id,
    status: 'proposed',
    requested_by: 'parity_harness',
    reason: fixture.action.summary,
    created_at: timing.action_at,
    updated_at: timing.action_at,
    payload: {
      action_model: model,
      policy_decision_id: 'policy-parity-1',
      policy,
    },
  }));

  const externalEffectCalls = [];
  const execution = await modules.action.executeAssistActions({
    repository,
    controllerId: 'default',
    task: taskRecord,
    actionIds: ['action-parity-1'],
    now: timing.action_at,
    commandRunner: async (intent) => {
      externalEffectCalls.push(intent);
      return { status: 0, stdout: '', stderr: '' };
    },
    blockedNotificationTransport: {
      async sendBlockedNotification(intent) {
        externalEffectCalls.push(intent);
        return { status: 'fake' };
      },
    },
  });
  const actionRecord = repository.getSnapshot().state.actions.find(
    (record) => record.action_id === 'action-parity-1',
  );

  return {
    policy,
    action_model: model,
    execution_result: execution,
    action_record: modules.action.summarizeAssistActionRecord(actionRecord),
    execution_receipt: {
      outcome: actionRecord?.payload?.execution?.outcome ?? null,
      reason: actionRecord?.payload?.execution?.reason ?? null,
      executor: actionRecord?.payload?.execution?.executor ?? null,
      idempotency_mode: actionRecord?.payload?.execution?.idempotency_mode ?? null,
      rollback_mode: actionRecord?.payload?.execution?.rollback_mode ?? null,
    },
    executed_vs_effect: {
      durable_status: actionRecord?.status ?? null,
      declared_command_count: model.commands.length,
      external_effect_count: externalEffectCalls.length,
      external_effect_observed: externalEffectCalls.length > 0,
      semantic_classification: externalEffectCalls.length === 0
        ? 'durable_state_transition_without_external_command_effect'
        : 'external_command_effect_observed',
      risk: externalEffectCalls.length === 0
        ? 'executed status does not by itself prove an external command ran'
        : null,
    },
  };
}

function runCheckpoint({ modules, repository, fixture }) {
  const store = modules.checkpoint.createCheckpointStore({
    repository,
    now: () => fixture.timing.checkpoint_at,
  });
  const record = store.captureCheckpoint({
    taskId: fixture.task.task_id,
    controllerId: 'default',
    derivedTrigger: 'manual',
    lifecycleTopStatus: 'hold',
    observedAt: fixture.timing.observation_at,
    actionIds: ['action-parity-1'],
  });
  const inspection = store.inspectCheckpoint({ checkpointId: record.checkpoint_id });
  const resume = store.loadCheckpointForResume({ checkpointId: record.checkpoint_id });
  return {
    record: {
      checkpoint_id: record.checkpoint_id,
      task_id: record.task_id,
      recorded_at: record.recorded_at,
      schema_version: record.snapshot.schema_version,
      format: record.snapshot.format,
      task_ref: record.snapshot.task_ref,
      verification_ref: record.snapshot.verification_ref,
      execution_ref: record.snapshot.execution_ref,
    },
    inspection: {
      checkpoint_id: inspection.checkpoint_id,
      task_id: inspection.task_id,
      state: inspection.state,
      reason_codes: inspection.reason_codes,
    },
    resume: {
      checkpoint_id: resume.checkpoint_id,
      task_id: resume.task_id,
      state: resume.state,
      reason_codes: resume.reason_codes,
    },
  };
}

function runReview({ modules, repository, fixture }) {
  const protocol = modules.review.createReviewProtocol({
    repository,
    now: () => fixture.timing.review_at,
  });
  const request = protocol.requestReview({
    taskId: fixture.task.task_id,
    requestedBySessionName: fixture.review.implementation_session_name,
    requestedBySessionId: fixture.review.implementation_session_id,
    implementationSessionName: fixture.review.implementation_session_name,
    implementationSessionId: fixture.review.implementation_session_id,
    targetHeadSha: fixture.review.target_head_sha,
    verificationBaseline: fixture.review.verification_baseline,
  });
  const claim = protocol.claimReview({
    reviewId: request.review_id,
    reviewerSessionName: fixture.review.reviewer_session_name,
    reviewerSessionId: fixture.review.reviewer_session_id,
  });
  const verdict = protocol.recordVerdict({
    reviewId: request.review_id,
    verdict: 'pass',
    findingsSummary: [],
    baselineExecution: {
      status: 'attested',
      summary: 'Fixture baseline executed by independent reviewer.',
      recorded_at: fixture.timing.review_at,
      attested_by_session_name: fixture.review.reviewer_session_name,
      attested_by_session_id: fixture.review.reviewer_session_id,
      commands_run: fixture.review.verification_baseline.flatMap((entry) => entry.commands),
    },
  });
  return {
    request: {
      review_id: request.review_id,
      status: request.status,
      target_head_sha: request.target_head_sha,
      freeze_status: request.freeze_status,
    },
    claim: {
      status: claim.status,
      reviewer_session_name: claim.reviewer_session_name,
    },
    verdict: {
      status: verdict.status,
      verdict: verdict.verdict,
      freeze_status: verdict.freeze_status,
      baseline_execution: verdict.baseline_execution,
    },
    inspection: protocol.inspectTaskReview({ reviewId: request.review_id }),
  };
}

function runHandoff({ modules, repository, fixture }) {
  const protocol = modules.handoff.createHandoffProtocol({
    repository,
    now: () => fixture.timing.handoff_at,
  });
  const request = protocol.requestHandoff({
    taskId: fixture.task.task_id,
    requestedBySessionName: fixture.handoff.operator_session_name,
    requestedBySessionId: fixture.handoff.operator_session_id,
    operatorSessionName: fixture.handoff.operator_session_name,
    operatorSessionId: fixture.handoff.operator_session_id,
    successorSessionName: fixture.handoff.successor_session_name,
    successorSessionId: fixture.handoff.successor_session_id,
    reason: 'owner_stale',
  });
  const claim = protocol.claimHandoff({
    requestId: request.request_id,
    successorSessionName: fixture.handoff.successor_session_name,
    successorSessionId: fixture.handoff.successor_session_id,
    reason: 'ready_to_continue',
  });
  const inspection = protocol.inspectTaskHandoff({ requestId: request.request_id });
  return {
    request: {
      request_id: request.request_id,
      task_id: request.task_id,
      status: request.status,
      successor_session_name: request.successor_session_name,
      lineage: request.lineage,
    },
    claim: {
      claim_id: claim.claim_id,
      status: claim.status,
      successor_session_name: claim.successor_session_name,
      reason_codes: claim.reason_codes,
    },
    inspection: {
      task_id: inspection.task_id,
      request_id: inspection.request_id,
      top_status: inspection.top_status,
      reason_codes: inspection.reason_codes,
      checkpoint_state: inspection.checkpoint?.state ?? null,
      claim_statuses: inspection.claims.map((record) => record.status),
    },
  };
}

async function runEvaluation({ modules, fixture, fixturePath }) {
  const evalRoot = path.join(path.dirname(fixturePath), 'eval');
  const customRunner = async () => ({
    verification: { status: 'passed', findings: [] },
    continuity: { kind: 'none', status: 'not_applicable', outcome: 'none' },
    metrics: {
      controller_run_count: 0,
      execution_attempt_count: 0,
      measurement_count: 1,
      intervened_measurement_count: 0,
      intervention_counts: {},
      failure_class_counts: { none: 1 },
    },
    stabilityVector: {
      alpha: 1,
      beta: 2,
      pid: 4242,
      temp_path: '/tmp/consolidation-eval-shape',
    },
  });
  const harness = await modules.evaluation.runAoEvalHarness({
    projectId: fixture.project_id,
    fixtureRoot: evalRoot,
    packNames: ['generic-shape'],
    replayCount: 2,
    runnerOverrides: {
      consolidation_generic_shape: customRunner,
    },
  });
  const scorecard = modules.scorecard.buildAoEvalScorecard({
    projectId: fixture.project_id,
    harnessResult: harness,
    generatedAt: fixture.timing.handoff_at,
  });
  return {
    harness: {
      schema_version: harness.schema_version,
      format: harness.format,
      replay_count: harness.replay_count,
      pack_ids: harness.pack_ids,
      scenario_ids: harness.scenario_ids,
      summary: harness.summary,
      scenarios: harness.scenario_results.map((scenario) => ({
        scenario_id: scenario.scenario_id,
        status: scenario.status,
        verification: scenario.verification,
        replay: scenario.replay,
        continuity: scenario.continuity,
        metrics: scenario.metrics,
      })),
    },
    scorecard: {
      schema_version: scorecard.schema_version,
      format: scorecard.format,
      scope: scorecard.scope,
      summary: scorecard.summary,
      quality_gate: scorecard.quality_gate,
      findings: scorecard.findings,
    },
  };
}

function stateCollectionKeys(state) {
  return Object.keys(state)
    .filter((key) => Array.isArray(state[key]))
    .sort((left, right) => left.localeCompare(right));
}

function getPath(value, expression) {
  if (typeof expression !== 'string' || !expression.startsWith('$')) return MISSING_VALUE;
  const tokens = [];
  expression.replace(/\.([A-Za-z0-9_-]+)|\[(\d+)\]/g, (_match, name, index) => {
    tokens.push(name ?? Number(index));
    return _match;
  });
  let current = value;
  for (const token of tokens) {
    if (current == null || !(token in Object(current))) return MISSING_VALUE;
    current = current[token];
  }
  return current;
}

function verifyExpectations(observable, expectations = []) {
  return expectations.flatMap((expectation) => {
    const actual = getPath(observable, expectation.path);
    return stableStringify(actual) === stableStringify(expectation.equals)
      ? []
      : [{
          path: expectation.path,
          expected: expectation.equals,
          actual,
        }];
  });
}

export async function runImplementation({
  implementation,
  fixture,
  fixturePath = DEFAULT_FIXTURE_PATH,
} = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-consolidation-parity-'));
  const { modules } = implementation;
  try {
    const initialState = modules.stateContracts.createEmptyControlPlaneState({
      project_id: fixture.project_id,
      created_at: fixture.timing.created_at,
      updated_at: fixture.timing.created_at,
    });
    const migration = modules.stateMigrations.bootstrapControlPlaneState({
      repoRoot: tempRoot,
      projectId: fixture.project_id,
      now: fixture.timing.created_at,
    });
    const idempotentReplay = modules.stateMigrations.bootstrapControlPlaneState({
      repoRoot: tempRoot,
      projectId: fixture.project_id,
      now: fixture.timing.observation_at,
    });
    const repository = modules.stateRepository.createStateRepository({
      repoRoot: tempRoot,
      projectId: fixture.project_id,
      clock: () => fixture.timing.created_at,
      auditIdGenerator: nextAuditIdGenerator(),
    });
    seedRepository(modules, repository, fixture);

    const observationRun = await runObservation({ modules, fixture, tempRoot });
    const reconciliationScope = modules.reconciliationContracts.createPrScope(
      fixture.task.pr_number,
    );
    const githubObservation = {
      ...fixture.github_observation,
      scope: reconciliationScope,
    };
    const reconciliation = modules.reconciliation.reconcileObservations({
      scope: reconciliationScope,
      aoObservation: observationRun.observation,
      githubObservation,
    });
    const doctorScope = modules.doctorContracts.createDoctorPrScope({
      projectId: fixture.project_id,
      prNumber: fixture.task.pr_number,
    });
    const localState = modules.doctorContracts.createDoctorLocalState({
      ...fixture.local_state,
      repo_root: tempRoot,
      cwd: tempRoot,
    });
    const doctor = modules.doctor.buildDoctorReport({
      scope: doctorScope,
      reconciliationReport: reconciliation,
      localState,
      controlPlaneSnapshot: repository.getSnapshot(),
    });
    const lifecycle = modules.lifecycle.buildLifecycleReport({
      scope: modules.lifecycleContracts.createLifecyclePrScope({
        projectId: fixture.project_id,
        prNumber: fixture.task.pr_number,
        trigger: 'ci_failed',
      }),
      reconciliationReport: reconciliation,
      doctorReport: doctor,
      currentHeadSha: fixture.task.head_sha,
    });
    const policyAction = await runPolicyAndAction({ modules, repository, fixture });
    const checkpoint = runCheckpoint({ modules, repository, fixture });
    const review = runReview({ modules, repository, fixture });
    const handoff = runHandoff({ modules, repository, fixture });
    const metricsReport = modules.metrics.buildAoMetricsReport({
      projectId: fixture.project_id,
      repoRoot: tempRoot,
      snapshot: repository.getSnapshot(),
      traceLimit: 5,
      since: fixture.timing.metrics_since,
      until: fixture.timing.metrics_until,
    });
    const evaluation = await runEvaluation({ modules, fixture, fixturePath });

    const rawObservable = {
      fixture_id: fixture.fixture_id,
      state_input: {
        schema_version: initialState.schema_version,
        format: initialState.format,
        project_id: initialState.project_id,
        collection_keys: stateCollectionKeys(initialState),
      },
      provider: {
        intent: observationRun.providerIntent,
        receipt: observationRun.providerReceipt,
      },
      observation: observationRun.observation,
      reconciliation: {
        schema_version: reconciliation.schema_version,
        report_format: reconciliation.report_format,
        top_status: reconciliation.top_status,
        automation_disposition: reconciliation.automation_disposition,
        source_health: reconciliation.source_health,
        pr_assessments: reconciliation.pr_assessments,
        findings: summarizeFindings(reconciliation.findings),
        recommended_actions: reconciliation.recommended_actions,
      },
      doctor: {
        schema_version: doctor.schema_version,
        report_format: doctor.report_format,
        top_status: doctor.top_status,
        source_health: doctor.source_health,
        findings: summarizeFindings(doctor.findings),
        suggestions: doctor.suggestions,
      },
      lifecycle: {
        schema_version: lifecycle.schema_version,
        report_format: lifecycle.report_format,
        top_status: lifecycle.top_status,
        source_health: lifecycle.source_health,
        routing_decision: lifecycle.routing_decision,
        release_decision: lifecycle.release_decision,
        findings: summarizeFindings(lifecycle.findings),
        actions: summarizeActions(lifecycle.actions),
      },
      policy_action: policyAction,
      checkpoint,
      review,
      handoff,
      metrics: {
        schema_version: metricsReport.schema_version,
        report_format: metricsReport.report_format,
        window: metricsReport.window,
        summary: metricsReport.summary,
        recent_traces: metricsReport.recent_traces,
      },
      evaluation,
      migration: {
        bootstrapped: migration.bootstrapped,
        migrated: migration.migrated,
        schema: {
          current_version: migration.schema.current_version,
          latest_version: migration.schema.latest_version,
          applied_migrations: migration.schema.applied_migrations,
        },
        state_collection_keys: stateCollectionKeys(migration.state),
        idempotent_replay: {
          bootstrapped: idempotentReplay.bootstrapped,
          migrated: idempotentReplay.migrated,
          current_version: idempotentReplay.schema.current_version,
        },
      },
    };
    const observable = canonicalize(rawObservable, {
      tempRoots: [tempRoot],
      harnessCwd: process.cwd(),
    });
    return {
      label: implementation.label,
      fingerprint: buildStableFingerprint(observable),
      expectation_failures: verifyExpectations(observable, fixture.expectations),
      observable,
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function valuesEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

export function diffObservables(left, right, currentPath = '$') {
  if (valuesEqual(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    const differences = [];
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      if (index >= left.length) {
        differences.push({ path: `${currentPath}[${index}]`, standalone: MISSING_VALUE, cie: right[index] });
      } else if (index >= right.length) {
        differences.push({ path: `${currentPath}[${index}]`, standalone: left[index], cie: MISSING_VALUE });
      } else {
        differences.push(...diffObservables(left[index], right[index], `${currentPath}[${index}]`));
      }
    }
    return differences;
  }
  if (
    left != null && right != null
      && typeof left === 'object' && typeof right === 'object'
      && !Array.isArray(left) && !Array.isArray(right)
  ) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort((a, b) => a.localeCompare(b));
    return keys.flatMap((key) => {
      if (!(key in left)) {
        return [{ path: `${currentPath}.${key}`, standalone: MISSING_VALUE, cie: right[key] }];
      }
      if (!(key in right)) {
        return [{ path: `${currentPath}.${key}`, standalone: left[key], cie: MISSING_VALUE }];
      }
      return diffObservables(left[key], right[key], `${currentPath}.${key}`);
    });
  }
  return [{ path: currentPath, standalone: left, cie: right }];
}

export function loadApprovedDifferences(filePath = DEFAULT_APPROVED_DIFFERENCES_PATH) {
  const resolved = path.resolve(filePath);
  const registry = readJson(resolved, 'approved differences');
  if (
    registry?.schema_version !== APPROVAL_SCHEMA_VERSION
      || !Array.isArray(registry?.differences)
  ) {
    throw new ParityHarnessError(
      'invalid_approval_registry',
      `Invalid approved-differences registry: ${resolved}`,
    );
  }
  const ids = new Set();
  for (const approval of registry.differences) {
    if (
      typeof approval?.id !== 'string'
        || typeof approval?.path !== 'string'
        || typeof approval?.reason !== 'string'
        || !Object.hasOwn(approval, 'standalone')
        || !Object.hasOwn(approval, 'cie')
    ) {
      throw new ParityHarnessError(
        'invalid_approval_registry',
        'Each approved difference requires id, path, reason, standalone, and cie',
      );
    }
    if (ids.has(approval.id)) {
      throw new ParityHarnessError('invalid_approval_registry', `Duplicate approval id: ${approval.id}`);
    }
    ids.add(approval.id);
  }
  return { ...registry, file_path: resolved };
}

function approvalMatches(approval, difference) {
  const standaloneMatches = approval.standalone === '__ANY__'
    || valuesEqual(approval.standalone, difference.standalone);
  const cieMatches = approval.cie === '__ANY__'
    || valuesEqual(approval.cie, difference.cie);
  return approval.path === difference.path && standaloneMatches && cieMatches;
}

export function applyApprovedDifferences(differences, registry) {
  const usedIds = new Set();
  const classified = differences.map((difference) => {
    const approval = registry.differences.find((candidate) => (
      approvalMatches(candidate, difference)
    ));
    if (!approval) return { ...difference, approved: false };
    usedIds.add(approval.id);
    return {
      ...difference,
      approved: true,
      approval_id: approval.id,
      approval_reason: approval.reason,
    };
  });
  return {
    differences: classified,
    approved: classified.filter((item) => item.approved),
    unapproved: classified.filter((item) => !item.approved),
    unused_approvals: registry.differences.filter((item) => !usedIds.has(item.id)),
  };
}

export async function runConsolidationParity({
  aoRoot = DEFAULT_AO_ROOT,
  cieRoot = process.env.AO_CIE_REPO ?? null,
  fixturePath = DEFAULT_FIXTURE_PATH,
  approvedDifferencesPath = DEFAULT_APPROVED_DIFFERENCES_PATH,
} = {}) {
  const { fixture, fixturePath: resolvedFixturePath } = loadFixture(fixturePath);
  const approvals = loadApprovedDifferences(approvedDifferencesPath);
  const standaloneImplementation = await loadImplementation(aoRoot, 'ao-pilot');
  const standalone = await runImplementation({
    implementation: standaloneImplementation,
    fixture,
    fixturePath: resolvedFixturePath,
  });
  const expectedFingerprint = fixture.expected_standalone_fingerprint;
  const standaloneBaseline = {
    expected_fingerprint: expectedFingerprint,
    actual_fingerprint: standalone.fingerprint,
    matches: standalone.fingerprint === expectedFingerprint,
    expectation_failure_count: standalone.expectation_failures.length,
  };

  let cie = null;
  let parity = {
    requested: false,
    status: 'not_requested',
    difference_count: 0,
    approved_difference_count: 0,
    unapproved_difference_count: 0,
    unused_approval_count: approvals.differences.length,
    differences: [],
    unused_approvals: approvals.differences,
  };
  if (cieRoot) {
    const cieImplementation = await loadImplementation(cieRoot, 'ciecopilot-home');
    cie = await runImplementation({
      implementation: cieImplementation,
      fixture,
      fixturePath: resolvedFixturePath,
    });
    const rawDifferences = diffObservables(standalone.observable, cie.observable);
    const classified = applyApprovedDifferences(rawDifferences, approvals);
    const passed = classified.unapproved.length === 0
      && classified.unused_approvals.length === 0
      && cie.expectation_failures.length === 0;
    parity = {
      requested: true,
      status: passed ? 'passed' : 'failed',
      difference_count: rawDifferences.length,
      approved_difference_count: classified.approved.length,
      unapproved_difference_count: classified.unapproved.length,
      unused_approval_count: classified.unused_approvals.length,
      cie_expectation_failure_count: cie.expectation_failures.length,
      differences: classified.differences,
      unused_approvals: classified.unused_approvals,
    };
  }

  const passed = standaloneBaseline.matches
    && standalone.expectation_failures.length === 0
    && (!cieRoot || parity.status === 'passed');
  return {
    schema_version: REPORT_SCHEMA_VERSION,
    fixture_id: fixture.fixture_id,
    status: passed ? 'passed' : 'failed',
    canonical_repository: 'ao-pilot',
    standalone_baseline: standaloneBaseline,
    standalone,
    cie,
    parity,
    approved_differences_file: approvals.file_path,
  };
}

function parseArgs(argv) {
  const args = {
    aoRoot: DEFAULT_AO_ROOT,
    cieRoot: process.env.AO_CIE_REPO ?? null,
    fixturePath: DEFAULT_FIXTURE_PATH,
    approvedDifferencesPath: DEFAULT_APPROVED_DIFFERENCES_PATH,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--ao-root') args.aoRoot = argv[++index];
    else if (arg === '--cie-root') args.cieRoot = argv[++index];
    else if (arg === '--fixture') args.fixturePath = argv[++index];
    else if (arg === '--approved-differences') args.approvedDifferencesPath = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new ParityHarnessError('invalid_usage', `Unknown argument: ${arg}`);
  }
  return args;
}

function renderHuman(report) {
  const lines = [
    `status: ${report.status}`,
    `fixture: ${report.fixture_id}`,
    `standalone_fingerprint: ${report.standalone.fingerprint}`,
    `standalone_baseline: ${report.standalone_baseline.matches ? 'matched' : 'mismatch'}`,
    `standalone_expectation_failures: ${report.standalone.expectation_failures.length}`,
    `cross_repo_parity: ${report.parity.status}`,
  ];
  if (report.parity.requested) {
    lines.push(`cross_repo_differences: ${report.parity.difference_count}`);
    lines.push(`approved_differences: ${report.parity.approved_difference_count}`);
    lines.push(`unapproved_differences: ${report.parity.unapproved_difference_count}`);
    lines.push(`cie_expectation_failures: ${report.parity.cie_expectation_failure_count}`);
    for (const difference of report.parity.differences.filter((item) => !item.approved)) {
      lines.push(`DIFF ${difference.path}`);
    }
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write([
      'Usage: node scripts/consolidation/parity-harness.js [options]',
      '',
      'Options:',
      '  --cie-root PATH              Compare against a CIE checkout',
      '  --ao-root PATH               Override the standalone checkout',
      '  --fixture PATH               Override the generic fixture',
      '  --approved-differences PATH  Explicit difference registry',
      '  --json                       Emit the full machine-readable report',
      '',
      'AO_CIE_REPO may be used instead of --cie-root.',
      '',
    ].join('\n'));
    return 0;
  }
  const report = await runConsolidationParity(args);
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : renderHuman(report)}\n`);
  return report.status === 'passed' ? 0 : 1;
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    const result = {
      schema_version: REPORT_SCHEMA_VERSION,
      status: 'error',
      code: error?.code ?? 'unexpected_error',
      message: error?.message ?? String(error),
      details: error?.details ?? {},
    };
    process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = 2;
  });
}
