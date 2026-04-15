import {
  DECISION_CHAIN_CONTRACT_STATUSES,
  DECISION_CHAIN_REPORT_FORMAT,
  DECISION_CHAIN_SCHEMA_VERSION,
  createDecisionChainStage,
} from './decision-chain-contracts.js';

function uniqueStrings(values) {
  return [...new Set((values ?? [])
    .map((value) => String(value))
    .filter((value) => value !== ''))];
}

function chooseObservedAt(reconciliationReport, doctorReport, lifecycleReport) {
  return lifecycleReport?.observed_at
    ?? doctorReport?.observed_at
    ?? reconciliationReport?.observed_at
    ?? null;
}

function normalizeFinding(stage, finding) {
  return {
    stage,
    code: String(finding?.code ?? 'unknown_finding'),
    severity: String(finding?.severity ?? 'info'),
    origin: String(finding?.origin ?? stage),
    summary: String(finding?.summary ?? ''),
    subject_type: finding?.subject_type ?? null,
    subject_id: finding?.subject_id ?? null,
  };
}

function normalizeAction(stage, action) {
  return {
    stage,
    id: String(action?.id ?? 'unknown_action'),
    action_class: String(action?.action_class ?? 'unknown'),
    summary: String(action?.summary ?? ''),
    commands: uniqueStrings(action?.commands ?? []),
    rationale: String(action?.rationale ?? ''),
  };
}

function dedupeBy(items, keyFn) {
  const deduped = new Map();
  for (const item of items ?? []) {
    deduped.set(keyFn(item), item);
  }
  return [...deduped.values()];
}

function stageContractStatus(scope) {
  if (scope?.mode === 'pr') {
    return DECISION_CHAIN_CONTRACT_STATUSES[0];
  }

  if (scope?.trigger && scope.trigger !== 'manual') {
    return DECISION_CHAIN_CONTRACT_STATUSES[2];
  }

  return DECISION_CHAIN_CONTRACT_STATUSES[1];
}

export function buildDecisionChainStagePlan({
  scope,
  reconciliationReport = null,
  doctorReport = null,
  lifecycleReport = null,
} = {}) {
  const scopeMode = scope?.mode === 'pr' ? 'pr' : 'project';
  const prScoped = scopeMode === 'pr';
  const projectTriggerRequiresPrScope = !prScoped && scope?.trigger && scope.trigger !== 'manual';

  return [
    createDecisionChainStage({
      stage: 'reconcile',
      role: 'truth',
      required: true,
      executed: reconciliationReport != null,
      authority: prScoped ? 'authoritative' : 'advisory',
      scopeMode,
      rationale: prScoped
        ? 'PR-scoped reconciliation is the authoritative truth gate.'
        : 'Project-scoped reconciliation is an advisory inspection surface.',
    }),
    createDecisionChainStage({
      stage: 'doctor',
      role: 'diagnose',
      required: prScoped,
      executed: doctorReport != null,
      authority: prScoped ? 'diagnose_only' : 'advisory',
      scopeMode,
      rationale: prScoped
        ? 'PR-scoped diagnosis is part of the authoritative chain before control decisions.'
        : (projectTriggerRequiresPrScope
            ? 'Project mode may inspect diagnosis, but this trigger still requires explicit PR scope for authoritative control.'
            : 'Project mode diagnosis is optional advisory triage.'),
    }),
    createDecisionChainStage({
      stage: 'lifecycle',
      role: 'decide',
      required: prScoped,
      executed: lifecycleReport != null,
      authority: prScoped ? 'authoritative' : 'advisory',
      scopeMode,
      rationale: prScoped
        ? 'PR-scoped lifecycle decisions are the authoritative control output.'
        : (projectTriggerRequiresPrScope
            ? 'Project-scoped lifecycle output is advisory only when a trigger needs explicit PR scope.'
            : 'Project-scoped lifecycle output is advisory-only triage.'),
    }),
  ];
}

function collectBlockingReasons({ reconciliationReport, doctorReport, lifecycleReport } = {}) {
  const relevantFindings = [
    ...(reconciliationReport?.findings ?? []).map((finding) => normalizeFinding('reconcile', finding)),
    ...(doctorReport?.findings ?? []).map((finding) => normalizeFinding('doctor', finding)),
    ...(lifecycleReport?.findings ?? []).map((finding) => normalizeFinding('lifecycle', finding)),
  ].filter((finding) => finding.severity !== 'info');

  return dedupeBy(relevantFindings, (finding) => `${finding.stage}:${finding.code}`);
}

function collectNextActions({ doctorReport, lifecycleReport } = {}) {
  const actions = [
    ...(doctorReport?.suggestions ?? []).map((suggestion) => normalizeAction('doctor', suggestion)),
    ...(lifecycleReport?.actions ?? []).map((action) => normalizeAction('lifecycle', action)),
  ];

  return dedupeBy(actions, (action) => `${action.stage}:${action.id}`);
}

export function buildDecisionChainReport({
  scope,
  reconciliationReport = null,
  doctorReport = null,
  lifecycleReport = null,
} = {}) {
  const blockingReasons = collectBlockingReasons({
    reconciliationReport,
    doctorReport,
    lifecycleReport,
  });
  const nextActions = collectNextActions({
    doctorReport,
    lifecycleReport,
  });

  return {
    schema_version: DECISION_CHAIN_SCHEMA_VERSION,
    report_format: DECISION_CHAIN_REPORT_FORMAT,
    observed_at: chooseObservedAt(reconciliationReport, doctorReport, lifecycleReport),
    project_id: scope?.project_id ?? 'unknown-project',
    scope: {
      mode: scope?.mode === 'pr' ? 'pr' : 'project',
      project_id: scope?.project_id ?? 'unknown-project',
      pr_number: scope?.pr_number ?? null,
      trigger: scope?.trigger ?? 'manual',
    },
    contract_status: stageContractStatus(scope),
    stages: buildDecisionChainStagePlan({
      scope,
      reconciliationReport,
      doctorReport,
      lifecycleReport,
    }),
    top_status: lifecycleReport?.top_status ?? doctorReport?.top_status ?? reconciliationReport?.top_status ?? null,
    automation_disposition: reconciliationReport?.automation_disposition ?? null,
    routing_decision: lifecycleReport?.routing_decision ?? null,
    release_decision: lifecycleReport?.release_decision ?? null,
    key_findings: blockingReasons,
    blocking_reasons: blockingReasons,
    next_actions: nextActions,
    next_commands: uniqueStrings(nextActions.flatMap((action) => action.commands ?? [])),
  };
}
