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
  repository.ensureRuntimePreflights({
    cwd,
  });
  return repository.getSnapshot();
}

export async function runDoctor({
  projectId = DEFAULT_PROJECT_ID,
  prNumber = null,
  cwd = process.cwd(),
} = {}) {
  const scope = prNumber != null
    ? createDoctorPrScope({ projectId, prNumber })
    : createDoctorProjectScope({ projectId });

  const { report: reconciliationReport } = await runReconciliation({
    projectId,
    prNumber,
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
  });

  return {
    scope,
    reconciliationReport,
    localState,
    controlPlaneSnapshot,
    report,
  };
}
