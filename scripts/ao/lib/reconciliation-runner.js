import {
  createPrScope,
  createProjectScope,
} from './reconciliation-contracts.js';
import { loadAoProjectObservation } from './ao-observation-source.js';
import { loadGitHubObservationSet } from './github-observation-source.js';
import { createHandoffProtocol } from './handoff-protocol.js';
import { findRepoRoot } from './repo-root.js';
import { reconcileObservations } from './reconciliation-engine.js';
import { createStateRepository } from './state-repository.js';

export const DEFAULT_PROJECT_ID = 'my-project';

export function buildProjectScopeFromAoObservation(aoObservation) {
  const prNumbers = [...new Set((aoObservation?.workers ?? [])
    .map((worker) => worker.pr_number)
    .filter((value) => Number.isInteger(value)))]
    .sort((left, right) => left - right);
  const branchNames = [...new Set((aoObservation?.workers ?? [])
    .map((worker) => worker.branch_name)
    .filter((value) => typeof value === 'string' && value.trim() !== ''))]
    .sort((left, right) => left.localeCompare(right));
  const selectionBasis = [];

  if (prNumbers.length) selectionBasis.push('ao_session_pr_reference');
  if (branchNames.length) selectionBasis.push('ao_session_branch_match');

  return createProjectScope({
    prNumbers,
    selectionBasis,
    notes: branchNames.map((branchName) => `branch:${branchName}`),
  });
}

export async function runReconciliation({
  projectId = DEFAULT_PROJECT_ID,
  prNumber = null,
  cwd = process.cwd(),
} = {}) {
  const aoObservation = await loadAoProjectObservation({
    projectId,
  });
  const scope = prNumber != null
    ? createPrScope(prNumber)
    : buildProjectScopeFromAoObservation(aoObservation);
  const githubObservation = await loadGitHubObservationSet({ scope });
  const report = reconcileObservations({
    scope,
    aoObservation,
    githubObservation,
  });
  const repoRoot = findRepoRoot(cwd);
  let handoffSummary = {
    inspection_count: 0,
    active_count: 0,
    ambiguous_count: 0,
    accepted_count: 0,
    tasks: [],
  };

  if (repoRoot) {
    const repository = createStateRepository({
      repoRoot,
      projectId,
    });
    const inspections = createHandoffProtocol({
      repository,
    }).inspectAllHandoffs();
    const prSelections = new Set(scope.selected_pr_numbers ?? []);
    const taskIds = prSelections.size === 0
      ? new Set(inspections.map((inspection) => inspection.task_id))
      : new Set(
          repository.getSnapshot().state.pr_bindings
            .filter((binding) => binding.status === 'bound' && prSelections.has(binding.pr_number))
            .map((binding) => binding.task_id),
        );
    const relevantInspections = inspections.filter((inspection) => taskIds.has(inspection.task_id));

    handoffSummary = {
      inspection_count: relevantInspections.length,
      active_count: relevantInspections.filter((inspection) => ['open', 'pending_decision', 'accepted'].includes(inspection.top_status)).length,
      ambiguous_count: relevantInspections.filter((inspection) => inspection.top_status === 'ambiguous').length,
      accepted_count: relevantInspections.filter((inspection) => inspection.top_status === 'accepted').length,
      tasks: relevantInspections.map((inspection) => ({
        task_id: inspection.task_id,
        request_id: inspection.request_id,
        top_status: inspection.top_status,
      })),
    };
  }

  return {
    scope,
    aoObservation,
    githubObservation,
    report: {
      ...report,
      handoff_summary: handoffSummary,
    },
  };
}
