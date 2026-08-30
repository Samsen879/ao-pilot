import {
  createDoctorProjectScope,
  createDoctorPrScope,
} from './doctor-contracts.js';
import { findRepoRoot } from './repo-root.js';
import {
  DEFAULT_PROJECT_ID,
  runReconciliation,
} from './reconciliation-runner.js';
import { loadDoctorLocalState } from './doctor-local-state-source.js';
import { buildDoctorReport } from './doctor-engine.js';
import { createStateRepository } from './state-repository.js';

export { DEFAULT_PROJECT_ID };

function loadControlPlaneSnapshot({
  projectId,
  cwd,
} = {}) {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) return null;

  const repository = createStateRepository({
    repoRoot,
    projectId,
  });
  const diagnosticSnapshot = repository.getDiagnosticSnapshot();
  if (diagnosticSnapshot.task_graph_inspection?.structurally_healthy === false) {
    return diagnosticSnapshot;
  }
  repository.ensureRuntimePreflights({
    cwd,
  });
  return repository.getDiagnosticSnapshot();
}

export async function runDoctor({
  projectId = DEFAULT_PROJECT_ID,
  prNumber = null,
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const scope = prNumber != null
    ? createDoctorPrScope({ projectId, prNumber })
    : createDoctorProjectScope({ projectId });

  const { report: reconciliationReport } = await runReconciliation({
    projectId,
    prNumber,
    cwd,
    env,
  });
  const localState = await loadDoctorLocalState({ cwd });
  const controlPlaneSnapshot = loadControlPlaneSnapshot({
    projectId,
    cwd,
  });
  const report = buildDoctorReport({
    scope,
    reconciliationReport,
    localState,
    controlPlaneSnapshot,
    runtimeStore: env.AO_PILOT_RUNTIME_STORE ?? null,
  });

  return {
    scope,
    reconciliationReport,
    localState,
    controlPlaneSnapshot,
    report,
  };
}
