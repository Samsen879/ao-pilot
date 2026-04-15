import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from '@jest/globals';

import { loadAoProjectObservation } from '../../scripts/ao/lib/ao-observation-source.js';
import { runControllerLoop } from '../../scripts/ao/lib/controller-loop.js';
import { createDoctorPrScope } from '../../scripts/ao/lib/doctor-contracts.js';
import { buildDoctorReport } from '../../scripts/ao/lib/doctor-engine.js';
import { loadDoctorLocalState } from '../../scripts/ao/lib/doctor-local-state-source.js';
import { loadGitHubObservationSet } from '../../scripts/ao/lib/github-observation-source.js';
import { createLifecyclePrScope } from '../../scripts/ao/lib/lifecycle-contracts.js';
import { buildLifecycleReport } from '../../scripts/ao/lib/lifecycle-engine.js';
import { createPrScope } from '../../scripts/ao/lib/reconciliation-contracts.js';
import { reconcileObservations } from '../../scripts/ao/lib/reconciliation-engine.js';
import {
  createControllerModeRecord,
  createManagedTask,
  createPrBinding,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'acceptance');
const ORIGINAL_FIXTURE_ROOT = process.env.AO_FIXTURE_ROOT;
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-parity-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function seedCleanRuntimePreflight(repository, {
  taskId,
  issueNumber,
  now = '2026-03-29T06:50:00.000Z',
} = {}) {
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
    created_at: now,
    updated_at: now,
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Fixture parity scenario uses stable runtime contracts.'],
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

afterEach(() => {
  process.env.AO_FIXTURE_ROOT = ORIGINAL_FIXTURE_ROOT;
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('ao controller shadow parity', () => {
  it.each([
    {
      name: 'ci-failed-pr',
      issueNumber: 92,
      prNumber: 92,
      branchName: 'feat/issue-92',
      expectedTrigger: 'ci_failed',
    },
    {
      name: 'approved-and-green-pr',
      issueNumber: 93,
      prNumber: 93,
      branchName: 'feat/issue-93',
      expectedTrigger: 'approved_and_green',
    },
    {
      name: 'orphaned-ownership',
      issueNumber: 94,
      prNumber: 94,
      branchName: 'feat/issue-94',
      expectedTrigger: 'agent_exited',
    },
  ])('matches lifecycle action outputs for $name', async ({
    name,
    issueNumber,
    prNumber,
    branchName,
    expectedTrigger,
  }) => {
    process.env.AO_FIXTURE_ROOT = path.join(FIXTURE_ROOT, name);
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: `issue-${issueNumber}`,
      issue_number: issueNumber,
      title: `Fixture parity ${name}`,
      branch_name: branchName,
      worktree_path: `/tmp/${branchName}`,
      status: 'active',
      created_at: '2026-03-29T06:50:00.000Z',
      updated_at: '2026-03-29T06:50:00.000Z',
    }));
    repository.upsertPrBinding(createPrBinding({
      binding_id: `binding-issue-${issueNumber}-pr-${prNumber}`,
      task_id: `issue-${issueNumber}`,
      pr_number: prNumber,
      branch_name: branchName,
      base_branch: 'main',
      status: 'bound',
      created_at: '2026-03-29T06:50:00.000Z',
      updated_at: '2026-03-29T06:50:00.000Z',
    }));
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'shadow',
      updated_at: '2026-03-29T06:50:00.000Z',
      updated_by: 'operator',
      reason: 'Parity test setup',
    }));
    seedCleanRuntimePreflight(repository, {
      taskId: `issue-${issueNumber}`,
      issueNumber,
    });

    const controllerResult = await runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'test-controller-parity',
      mode: 'shadow',
      now: '2026-03-29T06:51:00.000Z',
      deps: {
        loadAoProjectObservation: ({ projectId, now }) => loadAoProjectObservation({
          projectId,
          now,
        }),
        loadGitHubObservationSet: ({ now }) => loadGitHubObservationSet({
          scope: createPrScope(prNumber),
          now,
        }),
        ensureRuntimePreflights: ({ repository: activeRepository, cwd, now }) => activeRepository.ensureRuntimePreflights({
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

    expect(controllerResult.task_results[0].derived_trigger).toBe(expectedTrigger);

    const reconciliationScope = createPrScope(prNumber);
    const aoObservation = await loadAoProjectObservation({
      projectId: PROJECT_ID,
      now: '2026-03-29T06:51:00.000Z',
    });
    const githubObservation = await loadGitHubObservationSet({
      scope: reconciliationScope,
      now: '2026-03-29T06:51:00.000Z',
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
        projectId: PROJECT_ID,
        prNumber,
      }),
      reconciliationReport,
      localState,
    });
    const lifecycleReport = buildLifecycleReport({
      scope: createLifecyclePrScope({
        projectId: PROJECT_ID,
        prNumber,
        trigger: expectedTrigger,
      }),
      reconciliationReport,
      doctorReport,
    });

    const actualActions = repository.getSnapshot().state.actions
      .filter((record) => record.task_id === `issue-${issueNumber}`)
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

    const deliveryEvents = repository.getSnapshot().state.delivery_events
      .filter((record) => record.task_id === `issue-${issueNumber}`)
      .map((record) => ({
        event_family: record.event_family,
        lifecycle_trigger: record.lifecycle_trigger,
        lineage: record.lineage,
      }));

    expect(actualActions).toEqual(expectedActions);
    expect(deliveryEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_family: 'pr',
        lineage: expect.objectContaining({
          source_observation_id: expect.stringContaining(`issue-${issueNumber}:github_poll:`),
        }),
      }),
      expect.objectContaining({
        event_family: 'check',
        lineage: expect.objectContaining({
          source_observation_id: expect.stringContaining(`issue-${issueNumber}:github_poll:`),
        }),
      }),
      expect.objectContaining({
        event_family: 'review',
        lineage: expect.objectContaining({
          source_observation_id: expect.stringContaining(`issue-${issueNumber}:github_poll:`),
        }),
      }),
    ]));
  });
});
