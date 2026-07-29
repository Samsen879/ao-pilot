import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runControllerLoop } from '../controller-loop.js';
import { loadAoProjectObservation } from '../ao-observation-source.js';
import { createCheckpointStore } from '../checkpoint-store.js';
import { buildTaskContinuityFromSnapshot } from '../continuity.js';
import { createDoctorPrScope } from '../doctor-contracts.js';
import { buildDoctorReport } from '../doctor-engine.js';
import { loadDoctorLocalState } from '../doctor-local-state-source.js';
import { loadGitHubObservationSet } from '../github-observation-source.js';
import { createHandoffProtocol } from '../handoff-protocol.js';
import { createLifecyclePrScope } from '../lifecycle-contracts.js';
import { buildLifecycleReport } from '../lifecycle-engine.js';
import { runManageCommand } from '../manage-runner.js';
import { buildAoMetricsReport } from '../run-metrics.js';
import { createPrScope } from '../reconciliation-contracts.js';
import { reconcileObservations } from '../reconciliation-engine.js';
import {
  createControllerModeRecord,
  createCredentialProvenanceRecord,
  createManagedTask,
  createPrBinding,
  createTaskSpecRecord,
} from '../state-contracts.js';
import { createStateRepository } from '../state-repository.js';

function createTempRepo(prefix, { git = false } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (git) {
    fs.mkdirSync(path.join(repoRoot, '.git'));
  }
  return repoRoot;
}

function removeTempRepo(repoRoot) {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

function joinTaskSpecBody(lines = []) {
  return Array.isArray(lines) ? lines.join('\n') : '';
}

function countInterventions(interventionCounts = {}) {
  return Object.values(interventionCounts ?? {}).reduce((total, value) => total + Number(value ?? 0), 0);
}

function summarizeMetrics(snapshot, projectId) {
  const report = buildAoMetricsReport({
    projectId,
    snapshot,
    traceLimit: 5,
  });
  const measurementRecords = [
    ...(snapshot?.state?.controller_run_metrics ?? []),
    ...(snapshot?.state?.execution_attempt_metrics ?? []),
  ];

  return {
    controller_run_count: report.summary.controller_run_count,
    execution_attempt_count: report.summary.execution_attempt_count,
    measurement_count: measurementRecords.length,
    intervened_measurement_count: measurementRecords.filter(
      (record) => countInterventions(record?.intervention_counts) > 0,
    ).length,
    intervention_counts: report.summary.intervention_counts,
    failure_class_counts: report.summary.failure_class_counts,
  };
}

function buildVerification(findings = []) {
  return {
    status: findings.length === 0 ? 'passed' : 'failed',
    findings,
  };
}

function createFinding(code, summary, details = null) {
  return {
    code,
    summary,
    details,
  };
}

function resolveScenarioTaskId(scenario) {
  if (scenario?.task?.task_id) return String(scenario.task.task_id);
  if (scenario?.task?.issue_number != null) return `issue-${scenario.task.issue_number}`;
  throw new Error(`Scenario ${scenario?.scenario_id ?? 'unknown'} is missing task identity`);
}

function resolveContinuityKindForRunner(runner = null) {
  switch (runner) {
    case 'managed_resume_continuity':
      return 'resume';
    case 'managed_successor_handoff':
      return 'handoff';
    case 'managed_ambiguous_continuity':
      return 'human_gate';
    default:
      return 'none';
  }
}

function inspectScenarioContinuity({
  repository,
  taskId,
  checkpointStore,
  handoffProtocol,
} = {}) {
  const snapshot = repository.getSnapshot();
  const checkpointInspection = checkpointStore.inspectCheckpoint({
    taskId,
  });
  const handoffInspection = handoffProtocol.inspectTaskHandoff({
    taskId,
  });
  const continuityInspection = buildTaskContinuityFromSnapshot({
    snapshot,
    taskId,
    checkpointInspection,
    handoffInspection,
  });

  return {
    snapshot,
    checkpointInspection,
    handoffInspection,
    continuityInspection,
  };
}

function verifyContinuityExpectation(findings, {
  scenario,
  continuityInspection,
} = {}) {
  const expected = scenario?.expected?.continuity ?? null;
  if (!expected) return;

  if (!continuityInspection) {
    findings.push(createFinding(
      'continuity_inspection_missing',
      `Scenario ${scenario.scenario_id} did not produce a continuity inspection.`,
    ));
    return;
  }

  if (
    expected.posture != null
      && continuityInspection.posture !== expected.posture
  ) {
    findings.push(createFinding(
      'continuity_posture_mismatch',
      `Expected continuity posture ${expected.posture} but received ${continuityInspection.posture}.`,
    ));
  }

  if (
    expected.recommended_action != null
      && continuityInspection.recommended_action !== expected.recommended_action
  ) {
    findings.push(createFinding(
      'continuity_action_mismatch',
      `Expected continuity action ${expected.recommended_action} but received ${continuityInspection.recommended_action}.`,
    ));
  }
}

function buildContinuityResult({
  scenario,
  continuityInspection,
  status,
} = {}) {
  const expected = scenario?.expected?.continuity ?? {};
  return {
    kind: expected.kind ?? resolveContinuityKindForRunner(scenario?.runner),
    status,
    outcome: status === 'success'
      ? (expected.outcome ?? 'none')
      : 'failed',
    posture: continuityInspection?.posture ?? null,
    recommended_action: continuityInspection?.recommended_action ?? null,
    checkpoint_state: continuityInspection?.checkpoint_state ?? null,
  };
}

function resolveEvalHolderId(scenario) {
  const controllerId = String(scenario?.controller?.controller_id ?? 'default').trim() || 'default';
  return `ao-eval-${controllerId}`;
}

function buildControllerTaskSeed(repository, scenario, now, { withCredentials = false } = {}) {
  repository.upsertManagedTask(createManagedTask({
    task_id: scenario.task.task_id,
    issue_number: scenario.task.issue_number,
    title: scenario.task.title,
    branch_name: scenario.task.branch_name,
    worktree_path: scenario.task.worktree_path,
    status: 'active',
    created_at: now,
    updated_at: now,
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: `binding-${scenario.task.task_id}-pr-${scenario.pr_binding.pr_number}`,
    task_id: scenario.task.task_id,
    pr_number: scenario.pr_binding.pr_number,
    branch_name: scenario.task.branch_name,
    base_branch: scenario.pr_binding.base_branch ?? 'main',
    status: 'bound',
    created_at: now,
    updated_at: now,
  }));
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: scenario.controller.controller_id,
    mode: scenario.controller.mode,
    updated_at: now,
    updated_by: 'ao_eval',
    reason: `Eval scenario ${scenario.scenario_id}`,
  }));

  if (withCredentials) {
    for (const record of scenario.seed?.credential_provenances ?? []) {
      repository.upsertCredentialProvenance(createCredentialProvenanceRecord(record));
    }
  }
}

function seedCleanRuntimeContracts(repository, scenario, now) {
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: scenario.task.task_id,
    source_kind: 'github_issue',
    source_issue_number: scenario.task.issue_number,
    created_at: now,
    updated_at: now,
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: [`Eval parity fixture for ${scenario.scenario_id}`],
        runtime_ref: 'runtime.github_local',
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_review'],
      },
    },
  }));
  repository.ensureRuntimePreflights({
    cwd: repository.getSnapshot().paths.repoRoot,
    now,
    probes: {
      commandExists: () => true,
      pathExists: () => true,
      capability: () => true,
    },
  });
}

async function executeControllerParityScenario({
  scenario,
  fixtureRoot,
  projectId,
} = {}) {
  const repoRoot = createTempRepo('ao-eval-parity-');
  const acceptanceFixtureRoot = path.resolve(fixtureRoot, scenario.acceptance_fixture);
  const priorFixtureRoot = process.env.AO_FIXTURE_ROOT;

  try {
    process.env.AO_FIXTURE_ROOT = acceptanceFixtureRoot;
    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    buildControllerTaskSeed(repository, scenario, scenario.timing.created_at);
    seedCleanRuntimeContracts(repository, scenario, scenario.timing.created_at);

    const controllerResult = await runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId,
      controllerId: scenario.controller.controller_id,
      holderId: resolveEvalHolderId(scenario),
      mode: scenario.controller.mode,
      now: scenario.timing.run_at,
      deps: {
        loadAoProjectObservation: ({ projectId: activeProjectId, now }) => loadAoProjectObservation({
          projectId: activeProjectId,
          now,
        }),
        loadGitHubObservationSet: ({ now }) => loadGitHubObservationSet({
          scope: createPrScope(scenario.pr_binding.pr_number),
          now,
        }),
        ensureRuntimePreflights: ({ repository, cwd, now }) => repository.ensureRuntimePreflights({
          cwd,
          now,
          probes: {
            commandExists: () => true,
            pathExists: () => true,
            capability: () => true,
          },
        }),
      },
    });

    const reconciliationScope = createPrScope(scenario.pr_binding.pr_number);
    const aoObservation = await loadAoProjectObservation({
      projectId,
      now: scenario.timing.run_at,
    });
    const githubObservation = await loadGitHubObservationSet({
      scope: reconciliationScope,
      now: scenario.timing.run_at,
    });
    const reconciliationReport = reconcileObservations({
      scope: reconciliationScope,
      aoObservation,
      githubObservation,
    });
    const localState = await loadDoctorLocalState({
      cwd: repoRoot,
    });
    const doctorReport = buildDoctorReport({
      scope: createDoctorPrScope({
        projectId,
        prNumber: scenario.pr_binding.pr_number,
      }),
      reconciliationReport,
      localState,
    });
    const lifecycleReport = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId,
        prNumber: scenario.pr_binding.pr_number,
        trigger: scenario.expected.derived_trigger,
      }),
      reconciliationReport,
      doctorReport,
    });

    const snapshot = repository.getSnapshot();
    const findings = [];
    if (controllerResult.task_results[0]?.derived_trigger !== scenario.expected.derived_trigger) {
      findings.push(createFinding(
        'derived_trigger_mismatch',
        `Expected derived trigger ${scenario.expected.derived_trigger} but received ${controllerResult.task_results[0]?.derived_trigger}.`,
      ));
    }

    const actualActions = snapshot.state.actions
      .filter((record) => record.task_id === scenario.task.task_id)
      .map((record) => ({
        id: record.action_kind,
        action_class: record.payload.action_class,
        commands: record.payload.commands,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const expectedActions = lifecycleReport.actions
      .map((action) => ({
        id: action.id,
        action_class: action.action_class,
        commands: action.commands,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));

    if (JSON.stringify(actualActions) !== JSON.stringify(expectedActions)) {
      findings.push(createFinding(
        'action_parity_mismatch',
        'Controller action proposals did not match the lifecycle report actions.',
      ));
    }

    const deliveryFamilies = snapshot.state.delivery_events
      .filter((record) => record.task_id === scenario.task.task_id)
      .map((record) => record.event_family)
      .sort((left, right) => left.localeCompare(right));
    for (const requiredFamily of ['check', 'pr', 'review']) {
      if (!deliveryFamilies.includes(requiredFamily)) {
        findings.push(createFinding(
          'delivery_event_missing',
          `Expected ${requiredFamily} delivery event for ${scenario.scenario_id}.`,
          {
            required_family: requiredFamily,
          },
        ));
      }
    }

    const controllerMetric = snapshot.state.controller_run_metrics[0] ?? null;
    return {
      verification: buildVerification(findings),
      continuity: {
        kind: 'none',
        status: 'not_applicable',
        outcome: 'none',
      },
      metrics: summarizeMetrics(snapshot, projectId),
      stabilityVector: {
        derived_trigger: controllerResult.task_results[0]?.derived_trigger ?? null,
        actual_actions: actualActions,
        expected_actions: expectedActions,
        delivery_families: deliveryFamilies,
        controller_metric: controllerMetric == null
          ? null
          : {
              failure_class: controllerMetric.failure_class,
              trigger_kind: controllerMetric.trigger_kind,
              action_class_counts: controllerMetric.action_class_counts,
              intervention_counts: controllerMetric.intervention_counts,
            },
      },
    };
  } finally {
    if (priorFixtureRoot == null) {
      delete process.env.AO_FIXTURE_ROOT;
    } else {
      process.env.AO_FIXTURE_ROOT = priorFixtureRoot;
    }
    removeTempRepo(repoRoot);
  }
}

async function executeControllerPolicyScenario({
  scenario,
  projectId,
} = {}) {
  const repoRoot = createTempRepo('ao-eval-policy-');

  try {
    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    buildControllerTaskSeed(repository, scenario, scenario.timing.created_at, {
      withCredentials: true,
    });

    const controllerResult = await runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId,
      controllerId: scenario.controller.controller_id,
      holderId: resolveEvalHolderId(scenario),
      mode: scenario.controller.mode,
      now: scenario.timing.run_at,
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: scenario.timing.run_at,
          workers: [
            {
              session_name: scenario.task.owner_session_name ?? 'worker-54',
              session_runtime_id: scenario.task.owner_session_id ?? 'worker-54',
              issue_number: scenario.task.issue_number,
              branch_name: scenario.task.branch_name,
              pr_number: scenario.pr_binding.pr_number,
              lifecycle_state: 'idle',
              last_seen_at: scenario.timing.run_at,
              freshness: {
                status: 'fresh',
              },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: scenario.timing.run_at,
          prs: [
            {
              pr_number: scenario.pr_binding.pr_number,
              state: 'OPEN',
              head_branch: scenario.task.branch_name,
              head_sha: 'abc107',
              review_status: 'pending',
              ci_status: 'pending',
              mergeability: 'mergeable',
              is_draft: false,
              url: `https://example.test/pr/${scenario.pr_binding.pr_number}`,
            },
          ],
        }),
        resolveLifecycleReport: async () => scenario.lifecycle_report,
      },
    });

    const snapshot = repository.getSnapshot();
    const taskResult = controllerResult.task_results[0] ?? {};
    const findings = [];
    for (const fieldName of [
      'policy_decision_count',
      'policy_blocked_action_count',
      'denied_action_count',
      'downgraded_action_count',
    ]) {
      if (taskResult[fieldName] !== scenario.expected[fieldName]) {
        findings.push(createFinding(
          'policy_result_mismatch',
          `Expected ${fieldName}=${scenario.expected[fieldName]} but received ${taskResult[fieldName]}.`,
          {
            field: fieldName,
          },
        ));
      }
    }

    const decisionsByActionKind = snapshot.state.policy_decisions
      .map((record) => [record.action_kind, record.decision])
      .sort((left, right) => left[0].localeCompare(right[0]));
    const expectedDecisions = [
      ['continue_worker', 'allow'],
      ['gh_review', 'allow'],
      ['unknown_tool', 'deny'],
      ['workflow_gate', 'downgrade'],
    ];
    if (JSON.stringify(decisionsByActionKind) !== JSON.stringify(expectedDecisions)) {
      findings.push(createFinding(
        'policy_decision_mismatch',
        'Policy decisions did not match the expected fail-closed routing.',
      ));
    }

    const actionStatuses = snapshot.state.actions
      .map((record) => [record.action_kind, record.status])
      .sort((left, right) => left[0].localeCompare(right[0]));
    const expectedStatuses = [
      ['continue_worker', 'proposed'],
      ['gh_review', 'proposed'],
      ['unknown_tool', 'blocked'],
      ['workflow_gate', 'blocked'],
    ];
    if (JSON.stringify(actionStatuses) !== JSON.stringify(expectedStatuses)) {
      findings.push(createFinding(
        'policy_block_status_mismatch',
        'Action status did not reflect allow versus blocked policy outcomes.',
      ));
    }

    const controllerMetric = snapshot.state.controller_run_metrics[0] ?? null;
    return {
      verification: buildVerification(findings),
      continuity: {
        kind: 'none',
        status: 'not_applicable',
        outcome: 'none',
      },
      metrics: summarizeMetrics(snapshot, projectId),
      stabilityVector: {
        task_result: {
          policy_decision_count: taskResult.policy_decision_count ?? 0,
          policy_blocked_action_count: taskResult.policy_blocked_action_count ?? 0,
          denied_action_count: taskResult.denied_action_count ?? 0,
          downgraded_action_count: taskResult.downgraded_action_count ?? 0,
        },
        policy_decisions: decisionsByActionKind,
        action_statuses: actionStatuses,
        controller_metric: controllerMetric == null
          ? null
          : {
              failure_class: controllerMetric.failure_class,
              intervention_counts: controllerMetric.intervention_counts,
            },
      },
    };
  } finally {
    removeTempRepo(repoRoot);
  }
}

function sortExecutionAttempts(records = []) {
  return [...records].sort((left, right) => String(left?.started_at ?? '').localeCompare(String(right?.started_at ?? '')));
}

async function executeResumeContinuityScenario({
  scenario,
  projectId,
} = {}) {
  const repoRoot = createTempRepo('ao-eval-resume-', { git: true });
  const taskId = resolveScenarioTaskId(scenario);

  try {
    await runManageCommand({
      repoRoot,
      projectId,
      command: 'enroll',
      issueNumber: scenario.task.issue_number,
      title: scenario.task.title,
      branchName: scenario.task.branch_name,
      worktreePath: scenario.task.worktree_path,
      prNumber: scenario.task.pr_number,
      ownerSessionName: scenario.task.owner_session_name,
      ownerSessionId: scenario.task.owner_session_id,
      taskSpecBody: joinTaskSpecBody(scenario.task_spec_body),
      now: scenario.timing.enroll_at,
    });

    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: scenario.timing.preflight_at,
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => scenario.timing.checkpoint_at,
    });
    const handoffProtocol = createHandoffProtocol({
      repository,
      now: () => scenario.timing.resume_at,
    });
    const checkpoint = checkpointStore.captureCheckpoint({
      taskId,
      controllerId: 'default',
      derivedTrigger: 'manual',
      observedAt: scenario.timing.checkpoint_at,
      actionIds: ['proposal-resume-continuity'],
    });

    await runManageCommand({
      repoRoot,
      projectId,
      command: 'unmanage',
      issueNumber: scenario.task.issue_number,
      now: scenario.timing.pause_at,
      reason: 'worker_exited',
    });

    const inspectedContinuity = inspectScenarioContinuity({
      repository,
      taskId,
      checkpointStore,
      handoffProtocol,
    });

    const findings = [];
    verifyContinuityExpectation(findings, {
      scenario,
      continuityInspection: inspectedContinuity.continuityInspection,
    });
    const result = await runManageCommand({
      repoRoot,
      projectId,
      command: 'resume',
      issueNumber: scenario.task.issue_number,
      ownerSessionName: scenario.task.owner_session_name,
      ownerSessionId: scenario.task.owner_session_id,
      now: scenario.timing.resume_at,
    });

    const snapshot = repository.getSnapshot();
    const executionAttempts = sortExecutionAttempts(snapshot.state.execution_attempt_metrics);
    if (result.resume?.state !== 'valid') {
      findings.push(createFinding(
        'resume_checkpoint_invalid',
        'Explicit resume did not resolve a valid checkpoint.',
      ));
    }
    if (result.task?.metadata?.resume?.last_resume_checkpoint_id !== checkpoint.checkpoint_id) {
      findings.push(createFinding(
        'resume_checkpoint_lineage_missing',
        'Resumed managed task did not retain checkpoint lineage metadata.',
      ));
    }
    if (!executionAttempts.some((record) => (
      record.command === 'resume'
        && record.retry_cause === 'explicit_resume'
        && record.status === 'active'
    ))) {
      findings.push(createFinding(
        'resume_retry_cause_missing',
        'Resume attempt did not record an explicit_resume retry cause.',
      ));
    }
    if (!executionAttempts.some((record) => (
      record.command === 'enroll'
        && record.failure_class === 'worker_exit'
        && record.status === 'paused'
    ))) {
      findings.push(createFinding(
        'resume_prior_attempt_missing',
        'Paused enrollment attempt was not retained as worker_exit history.',
      ));
    }

    return {
      verification: buildVerification(findings),
      continuity: buildContinuityResult({
        scenario,
        continuityInspection: inspectedContinuity.continuityInspection,
        status: findings.length === 0 ? 'success' : 'failed',
      }),
      metrics: summarizeMetrics(snapshot, projectId),
      stabilityVector: {
        continuity_pre_action: {
          posture: inspectedContinuity.continuityInspection?.posture ?? null,
          recommended_action: inspectedContinuity.continuityInspection?.recommended_action ?? null,
          checkpoint_state: inspectedContinuity.continuityInspection?.checkpoint_state ?? null,
        },
        task: {
          status: result.task?.status ?? null,
          branch_name: result.task?.branch_name ?? null,
          worktree_path: result.task?.worktree_path ?? null,
        },
        ownership_lease: {
          owner_session_name: result.ownershipLease?.owner_session_name ?? null,
          status: result.ownershipLease?.status ?? null,
        },
        resume: {
          checkpoint_id: result.resume?.checkpoint_id ?? null,
          state: result.resume?.state ?? null,
        },
        execution_attempts: executionAttempts.map((record) => ({
          command: record.command,
          status: record.status,
          retry_cause: record.retry_cause,
          failure_class: record.failure_class,
        })),
      },
    };
  } finally {
    removeTempRepo(repoRoot);
  }
}

async function executeSuccessorHandoffScenario({
  scenario,
  projectId,
} = {}) {
  const repoRoot = createTempRepo('ao-eval-handoff-', { git: true });
  const taskId = resolveScenarioTaskId(scenario);

  try {
    await runManageCommand({
      repoRoot,
      projectId,
      command: 'enroll',
      issueNumber: scenario.task.issue_number,
      title: scenario.task.title,
      branchName: scenario.task.branch_name,
      worktreePath: scenario.task.worktree_path,
      prNumber: scenario.task.pr_number,
      ownerSessionName: scenario.task.owner_session_name,
      ownerSessionId: scenario.task.owner_session_id,
      taskSpecBody: joinTaskSpecBody(scenario.task_spec_body),
      now: scenario.timing.enroll_at,
    });

    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: scenario.timing.preflight_at,
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => scenario.timing.checkpoint_at,
    });
    checkpointStore.captureCheckpoint({
      taskId,
      controllerId: 'default',
      derivedTrigger: 'agent_exited',
      observedAt: scenario.timing.checkpoint_at,
      actionIds: ['proposal-handoff-continuity'],
    });

    await runManageCommand({
      repoRoot,
      projectId,
      command: 'unmanage',
      issueNumber: scenario.task.issue_number,
      now: scenario.timing.pause_at,
      reason: 'worker_stale',
    });

    const handoffProtocol = createHandoffProtocol({
      repository,
      now: () => scenario.timing.handoff_at,
    });
    const request = handoffProtocol.requestHandoff({
      taskId: `issue-${scenario.task.issue_number}`,
      requestedBySessionName: scenario.task.operator_session_name,
      requestedBySessionId: scenario.task.operator_session_id,
      operatorSessionName: scenario.task.operator_session_name,
      operatorSessionId: scenario.task.operator_session_id,
      successorSessionName: scenario.task.successor_session_name,
      successorSessionId: scenario.task.successor_session_id,
      reason: 'owner_stale',
    });
    const claim = handoffProtocol.claimHandoff({
      requestId: request.request_id,
      successorSessionName: scenario.task.successor_session_name,
      successorSessionId: scenario.task.successor_session_id,
      reason: 'resume_as_successor',
    });
    handoffProtocol.acceptHandoff({
      requestId: request.request_id,
      claimId: claim.claim_id,
      operatorSessionName: scenario.task.operator_session_name,
      operatorSessionId: scenario.task.operator_session_id,
      reason: 'approved_successor',
      grantExpiresAt: scenario.timing.grant_expires_at,
    });

    const inspectedContinuity = inspectScenarioContinuity({
      repository,
      taskId,
      checkpointStore,
      handoffProtocol,
    });

    const findings = [];
    verifyContinuityExpectation(findings, {
      scenario,
      continuityInspection: inspectedContinuity.continuityInspection,
    });
    const result = await runManageCommand({
      repoRoot,
      projectId,
      command: 'resume',
      issueNumber: scenario.task.issue_number,
      ownerSessionName: scenario.task.successor_session_name,
      ownerSessionId: scenario.task.successor_session_id,
      now: scenario.timing.resume_at,
    });

    const snapshot = repository.getSnapshot();
    const executionAttempts = sortExecutionAttempts(snapshot.state.execution_attempt_metrics);
    if (result.handoffTransfer == null) {
      findings.push(createFinding(
        'handoff_transfer_missing',
        'Resume did not complete the accepted handoff transfer.',
      ));
    }
    if (!snapshot.state.handoff_requests.some((record) => record.status === 'completed')) {
      findings.push(createFinding(
        'handoff_request_not_completed',
        'Accepted handoff request was not marked completed after resume.',
      ));
    }
    if (!executionAttempts.some((record) => (
      record.command === 'resume'
        && record.retry_cause === 'successor_handoff'
        && record.status === 'active'
    ))) {
      findings.push(createFinding(
        'handoff_retry_cause_missing',
        'Successor resume did not record a successor_handoff retry cause.',
      ));
    }

    return {
      verification: buildVerification(findings),
      continuity: buildContinuityResult({
        scenario,
        continuityInspection: inspectedContinuity.continuityInspection,
        status: findings.length === 0 ? 'success' : 'failed',
      }),
      metrics: summarizeMetrics(snapshot, projectId),
      stabilityVector: {
        continuity_pre_action: {
          posture: inspectedContinuity.continuityInspection?.posture ?? null,
          recommended_action: inspectedContinuity.continuityInspection?.recommended_action ?? null,
          checkpoint_state: inspectedContinuity.continuityInspection?.checkpoint_state ?? null,
        },
        ownership_lease: {
          owner_session_name: result.ownershipLease?.owner_session_name ?? null,
          status: result.ownershipLease?.status ?? null,
        },
        handoff_transfer: {
          successor_session_name: result.handoffTransfer?.successor_session_name ?? null,
          reason: result.handoffTransfer?.reason ?? null,
        },
        handoff_request_statuses: snapshot.state.handoff_requests.map((record) => record.status).sort(),
        execution_attempts: executionAttempts.map((record) => ({
          command: record.command,
          status: record.status,
          retry_cause: record.retry_cause,
          failure_class: record.failure_class,
        })),
      },
    };
  } finally {
    removeTempRepo(repoRoot);
  }
}

async function executeAmbiguousContinuityScenario({
  scenario,
  projectId,
} = {}) {
  const repoRoot = createTempRepo('ao-eval-ambiguous-', { git: true });
  const taskId = resolveScenarioTaskId(scenario);

  try {
    await runManageCommand({
      repoRoot,
      projectId,
      command: 'enroll',
      issueNumber: scenario.task.issue_number,
      title: scenario.task.title,
      branchName: scenario.task.branch_name,
      worktreePath: scenario.task.worktree_path,
      prNumber: scenario.task.pr_number,
      ownerSessionName: scenario.task.owner_session_name,
      ownerSessionId: scenario.task.owner_session_id,
      taskSpecBody: joinTaskSpecBody(scenario.task_spec_body),
      now: scenario.timing.enroll_at,
    });

    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: scenario.timing.preflight_at,
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });
    const checkpointStore = createCheckpointStore({
      repository,
      now: () => scenario.timing.checkpoint_at,
    });
    checkpointStore.captureCheckpoint({
      taskId,
      controllerId: 'default',
      derivedTrigger: 'agent_exited',
      observedAt: scenario.timing.checkpoint_at,
      actionIds: ['proposal-ambiguous-continuity'],
    });

    await runManageCommand({
      repoRoot,
      projectId,
      command: 'unmanage',
      issueNumber: scenario.task.issue_number,
      now: scenario.timing.pause_at,
      reason: 'worker_stale',
    });

    const handoffProtocol = createHandoffProtocol({
      repository,
      now: () => scenario.timing.handoff_at,
    });
    const request = handoffProtocol.requestHandoff({
      taskId,
      requestedBySessionName: scenario.task.operator_session_name,
      requestedBySessionId: scenario.task.operator_session_id,
      operatorSessionName: scenario.task.operator_session_name,
      operatorSessionId: scenario.task.operator_session_id,
      successorSessionName: null,
      successorSessionId: null,
      reason: 'open_successor_selection',
    });

    const successorCandidates = Array.isArray(scenario.task.successor_candidates)
      ? scenario.task.successor_candidates
      : [];
    if (successorCandidates.length < 2) {
      throw new Error(`Scenario ${scenario.scenario_id} requires at least two successor candidates`);
    }

    for (const candidate of successorCandidates) {
      handoffProtocol.claimHandoff({
        requestId: request.request_id,
        successorSessionName: candidate.session_name,
        successorSessionId: candidate.session_id,
        reason: 'candidate_ready',
      });
    }

    const inspectedContinuity = inspectScenarioContinuity({
      repository,
      taskId,
      checkpointStore,
      handoffProtocol,
    });
    const snapshot = inspectedContinuity.snapshot;
    const executionAttempts = sortExecutionAttempts(snapshot.state.execution_attempt_metrics);
    const findings = [];
    verifyContinuityExpectation(findings, {
      scenario,
      continuityInspection: inspectedContinuity.continuityInspection,
    });

    if (inspectedContinuity.handoffInspection?.top_status !== 'ambiguous') {
      findings.push(createFinding(
        'handoff_status_mismatch',
        `Expected ambiguous handoff inspection but received ${inspectedContinuity.handoffInspection?.top_status ?? 'none'}.`,
      ));
    }
    if (snapshot.state.handoff_transfers.length !== 0) {
      findings.push(createFinding(
        'unexpected_handoff_transfer',
        'Ambiguous continuity scenario should not complete any handoff transfer.',
      ));
    }
    if (executionAttempts.some((record) => record.command === 'resume')) {
      findings.push(createFinding(
        'unexpected_resume_attempt',
        'Ambiguous continuity scenario should not execute a resume attempt.',
      ));
    }

    return {
      verification: buildVerification(findings),
      continuity: buildContinuityResult({
        scenario,
        continuityInspection: inspectedContinuity.continuityInspection,
        status: findings.length === 0 ? 'success' : 'failed',
      }),
      metrics: summarizeMetrics(snapshot, projectId),
      stabilityVector: {
        continuity_pre_action: {
          posture: inspectedContinuity.continuityInspection?.posture ?? null,
          recommended_action: inspectedContinuity.continuityInspection?.recommended_action ?? null,
          checkpoint_state: inspectedContinuity.continuityInspection?.checkpoint_state ?? null,
        },
        handoff_status: {
          top_status: inspectedContinuity.handoffInspection?.top_status ?? null,
          reason_codes: inspectedContinuity.handoffInspection?.reason_codes ?? [],
        },
        handoff_claims: (inspectedContinuity.handoffInspection?.claims ?? []).map((claim) => ({
          successor_session_name: claim.successor_session_name,
          status: claim.status,
        })),
        execution_attempts: executionAttempts.map((record) => ({
          command: record.command,
          status: record.status,
          retry_cause: record.retry_cause,
          failure_class: record.failure_class,
        })),
      },
    };
  } finally {
    removeTempRepo(repoRoot);
  }
}

export function createBuiltinEvalRunners() {
  return new Map([
    ['controller_shadow_parity', executeControllerParityScenario],
    ['controller_policy_fail_closed', executeControllerPolicyScenario],
    ['managed_resume_continuity', executeResumeContinuityScenario],
    ['managed_successor_handoff', executeSuccessorHandoffScenario],
    ['managed_ambiguous_continuity', executeAmbiguousContinuityScenario],
  ]);
}
