import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import {
  createControllerLease,
  createControllerModeRecord,
  createManagedTask,
  createPrBinding,
  createReviewRecord,
  createRuntimePreflightRecord,
  createTaskSpecRecord,
} from '../../scripts/ao/lib/state-contracts.js';
import { runControllerLoop } from '../../scripts/ao/lib/controller-loop.js';
import { runRuntimeBootstrapPreflight } from '../../scripts/ao/lib/runtime-preflight.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const PROJECT_ID = 'my-project';
const tempDirs = [];
const originalAoSessionName = process.env.AO_SESSION_NAME;
const originalAoSessionId = process.env.AO_SESSION_ID;
const originalAoCallerType = process.env.AO_CALLER_TYPE;

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-controller-loop-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function seedActiveTask(repository, mode) {
  repository.upsertManagedTask(createManagedTask({
    task_id: 'issue-92',
    issue_number: 92,
    title: 'CI failed parity scenario',
    branch_name: 'feat/issue-92',
    worktree_path: '/tmp/worker-92',
    status: 'active',
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
  }));
  repository.upsertPrBinding(createPrBinding({
    binding_id: 'binding-issue-92-pr-92',
    task_id: 'issue-92',
    pr_number: 92,
    branch_name: 'feat/issue-92',
    base_branch: 'main',
    status: 'bound',
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
  }));
  repository.upsertControllerMode(createControllerModeRecord({
    controller_id: 'default',
    mode,
    updated_at: '2026-03-29T06:40:00.000Z',
    updated_by: 'operator',
    reason: 'Issue #89 test setup',
  }));
}

function seedCleanRuntimePreflight(repository, {
  taskId = 'issue-92',
  issueNumber = 92,
  runtimeRef = 'runtime.github_local',
} = {}) {
  repository.upsertTaskSpec(createTaskSpecRecord({
    task_id: taskId,
    source_kind: 'github_issue',
    source_issue_number: issueNumber,
    created_at: '2026-03-29T06:40:00.000Z',
    updated_at: '2026-03-29T06:40:00.000Z',
    snapshot: {
      schema_version: 'ao.task-spec.v1alpha1',
      spec: {
        problem_type: 'issue_delivery',
        acceptance_contract: ['Assist only executes after clean runtime preflight.'],
        runtime_ref: runtimeRef,
        policy_ref: 'policy.operator_gated',
        human_gates: ['operator_review'],
      },
    },
  }));

  repository.upsertRuntimePreflight(createRuntimePreflightRecord({
    recorded_at: '2026-03-29T06:40:00.000Z',
    snapshot: runRuntimeBootstrapPreflight({
      runtimeRef,
      cwd: repository.getSnapshot().paths.repoRoot,
      now: '2026-03-29T06:40:00.000Z',
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    }),
  }));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
  process.env.AO_SESSION_NAME = originalAoSessionName;
  process.env.AO_SESSION_ID = originalAoSessionId;
  process.env.AO_CALLER_TYPE = originalAoCallerType;
});

beforeEach(() => {
  process.env.AO_SESSION_NAME = 'test-controller-holder';
  process.env.AO_CALLER_TYPE = 'session';
});

describe('ao controller loop', () => {
  it('migrates legacy v10 authority before resolving startup mode from a direct snapshot', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({ repoRoot, projectId: PROJECT_ID });
    repository.upsertControllerMode(createControllerModeRecord({
      controller_id: 'default',
      mode: 'observe',
      updated_at: '2026-03-29T06:40:00.000Z',
      updated_by: 'operator',
      reason: 'Legacy startup migration fixture.',
    }));
    const paths = repository.getSnapshot().paths;
    const schema = JSON.parse(fs.readFileSync(paths.schemaPath, 'utf8'));
    schema.current_version = 10;
    schema.latest_version = 10;
    schema.applied_migrations = schema.applied_migrations.filter((entry) => entry.version <= 10);
    fs.writeFileSync(paths.schemaPath, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    state.controller_leases = [];
    fs.writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.unlinkSync(paths.controllerLeasesPath);
    fs.unlinkSync(paths.controllerLeaseMigrationReceiptPath);
    const auditEntries = fs.readFileSync(paths.auditPath, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.entity_id !== 'v11');
    fs.writeFileSync(paths.auditPath, `${auditEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

    await expect(runControllerLoop({
      repoRoot,
      projectId: PROJECT_ID,
      now: '2026-03-29T06:41:00.000Z',
      stopSignal: { aborted: true },
    })).resolves.toMatchObject({ mode: 'observe', pass_count: 0 });
    expect(JSON.parse(fs.readFileSync(paths.schemaPath, 'utf8')).current_version).toBe(11);
    expect(JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))).not.toHaveProperty('controller_leases');
  });

  it('observe mode persists observations without proposing actions', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    seedCleanRuntimePreflight(repository);
    const resolveLifecycleReport = jest.fn();

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        ensureRuntimePreflights: ({ repository: activeRepository, cwd, now }) => activeRepository.ensureRuntimePreflights({
          cwd,
          now,
          probes: {
            commandExists: () => true,
            pathExists: () => true,
            capability: () => true,
          },
        }),
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-29T06:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'pending',
              ci_status: 'pending',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        resolveLifecycleReport,
      },
    });

    expect(resolveLifecycleReport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'observe',
      processed_task_count: 1,
      ingested_observation_count: 2,
      proposed_action_count: 0,
      task_results: [
        expect.objectContaining({
          task_id: 'issue-92',
          derived_trigger: 'manual',
          new_observation_count: 2,
          proposed_action_count: 0,
        }),
      ],
    });

    const snapshot = repository.getSnapshot().state;
    expect(snapshot.observations).toHaveLength(2);
    expect(snapshot.actions).toEqual([]);
    expect(snapshot.controller_run_metrics).toEqual([
      expect.objectContaining({
        task_id: 'issue-92',
        controller_id: 'default',
        controller_mode: 'observe',
        trigger_kind: 'manual',
        failure_class: 'none',
        lifecycle_top_status: null,
        observation_count: 2,
        delivery_event_count: 3,
        proposed_action_count: 0,
        executed_action_count: 0,
        blocked_action_count: 0,
        intervention_counts: expect.objectContaining({
          human_gate: 0,
          override: 0,
          explicit_resume: 0,
          successor_handoff: 0,
          policy_block: 0,
          preflight_block: 0,
        }),
        token_usage: {
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
        },
        cost: {
          usd: null,
        },
      }),
    ]);
    expect(snapshot.checkpoints).toEqual([
      expect.objectContaining({
        task_id: 'issue-92',
        snapshot: expect.objectContaining({
          schema_version: 'ao.checkpoint.v1alpha1',
          verification_ref: expect.objectContaining({
            task_spec: expect.objectContaining({
              task_id: 'issue-92',
              state: 'valid',
            }),
            runtime_preflight: expect.objectContaining({
              runtime_ref: 'runtime.github_local',
              status: 'clean',
            }),
          }),
          execution_ref: expect.objectContaining({
            controller_id: 'default',
            controller_mode: 'observe',
            derived_trigger: 'manual',
          }),
        }),
      }),
    ]);
    expect(snapshot.controller_leases).toEqual([
      expect.objectContaining({
        controller_id: 'default',
        status: 'released',
      }),
    ]);
  });

  it('shadow mode records proposed lifecycle actions without executing them', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'shadow');

    const lifecycleReport = {
      top_status: 'hold',
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-92',
      },
      release_decision: {
        disposition: 'await_ci',
      },
      actions: [
        {
          id: 'continue_worker',
          action_class: 'continue_worker',
          summary: 'Continue the current worker owner.',
          commands: ['ao status -p my-project --json'],
          rationale: 'Ownership continuity is clear enough to continue the current worker.',
        },
        {
          id: 'hold_ci',
          action_class: 'hold',
          summary: 'Hold until CI is green.',
          commands: ['gh pr checks 92'],
          rationale: 'Required CI state is not yet ready.',
        },
      ],
    };

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-29T06:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'pending',
              ci_status: 'failing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        resolveLifecycleReport: async ({ derivedTrigger }) => {
          expect(derivedTrigger).toBe('ci_failed');
          return lifecycleReport;
        },
      },
    });

    expect(result).toMatchObject({
      mode: 'shadow',
      processed_task_count: 1,
      ingested_observation_count: 2,
      delivery_event_count: 3,
      proposed_action_count: 2,
      task_results: [
        expect.objectContaining({
          task_id: 'issue-92',
          derived_trigger: 'ci_failed',
          new_delivery_event_count: 3,
          proposed_action_count: 2,
          lifecycle_top_status: 'hold',
          continuity: expect.objectContaining({
            posture: 'active_owner',
            recommended_action: 'continue_current_worker',
            owner_session_name: 'worker-92',
          }),
          decision_chain: expect.objectContaining({
            contract_status: 'authoritative_pr_chain',
          }),
        }),
      ],
    });

    const snapshot = repository.getSnapshot().state;
    expect(snapshot.delivery_events.map((record) => record.event_family)).toEqual(expect.arrayContaining([
      'check',
      'pr',
      'review',
    ]));
    expect(snapshot.controller_run_metrics).toEqual([
      expect.objectContaining({
        task_id: 'issue-92',
        trigger_kind: 'ci_failed',
        failure_class: 'ci_failure',
        action_class_counts: expect.objectContaining({
          continue_worker: 1,
          hold: 1,
        }),
      }),
    ]);
    expect(snapshot.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        task_id: 'issue-92',
        action_kind: 'continue_worker',
        status: 'proposed',
        requested_by: 'shadow_controller',
        payload: expect.objectContaining({
          action_class: 'continue_worker',
          commands: ['ao status -p my-project --json'],
        }),
      }),
      expect.objectContaining({
        task_id: 'issue-92',
        action_kind: 'hold_ci',
        status: 'proposed',
        requested_by: 'shadow_controller',
        payload: expect.objectContaining({
          action_class: 'hold',
          commands: ['gh pr checks 92'],
        }),
      }),
    ]));
    expect(repository.listAuditEntries().filter((entry) => entry.entity_kind === 'action')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'proposed',
          actor: 'shadow_controller',
        }),
      ]),
    );
  });

  it('passes the control-plane snapshot into doctor resolution for lifecycle handoff analysis', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'shadow');
    seedCleanRuntimePreflight(repository);
    const buildDoctorReport = jest.fn(() => ({
      top_status: 'healthy',
      source_health: {
        reconciliation: 'ok',
        ao: 'ok',
        github: 'ok',
        git: 'ok',
        worktree: 'ok',
      },
      reconciliation_summary: {
        top_status: 'healthy',
        selected_pr_numbers: [92],
      },
      local_state: {
        current_branch: 'feat/issue-92',
        upstream_branch: 'origin/feat/issue-92',
        worktree_dirty: false,
        ao_artifact_paths: [],
      },
      findings: [],
      suggestions: [],
    }));
    const buildLifecycleReport = jest.fn(() => ({
      top_status: 'continue',
      routing_decision: {
        action: 'continue_current_worker',
      },
      release_decision: {
        disposition: 'continue_current_worker',
      },
      actions: [],
    }));

    await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-29T06:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'pending',
              ci_status: 'pending',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        reconcileObservations: () => ({
          top_status: 'healthy',
          source_health: { ao: 'ok', github: 'ok' },
          scope: { selected_pr_numbers: [92] },
          pr_assessments: [],
          findings: [],
        }),
        loadDoctorLocalState: async () => ({
          git_observable: true,
          repo_root: repository.getSnapshot().paths.repoRoot,
          head_sha: 'abc123',
          current_branch: 'feat/issue-92',
          upstream_branch: 'origin/feat/issue-92',
          upstream_tracking: 'present',
          worktree_dirty: false,
          staged_changes: false,
          unstaged_changes: false,
          untracked_file_count: 0,
          untracked_file_samples: [],
          ao_artifact_paths: [],
        }),
        buildDoctorReport,
        buildLifecycleReport,
      },
    });

    expect(buildDoctorReport).toHaveBeenCalledWith(expect.objectContaining({
      controlPlaneSnapshot: expect.objectContaining({
        bootstrapped: true,
        state: expect.objectContaining({
          handoff_requests: expect.any(Array),
        }),
      }),
    }));
  });

  it('derives bugbot comment follow-up from protocolized review-comment delivery events', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'shadow');

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-30T08:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-30T08:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-30T08:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-30T08:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
              reviews: [
                {
                  review_id: 'review-comment-1',
                  state: 'commented',
                  author_login: 'chatgpt-codex-connector',
                  submitted_at: '2026-03-30T08:40:50.000Z',
                  commit_oid: 'abc123',
                },
              ],
            },
          ],
        }),
        resolveLifecycleReport: async ({ derivedTrigger }) => {
          expect(derivedTrigger).toBe('bugbot_comments');
          return {
            top_status: 'hold',
            routing_decision: {
              action: 'continue_current_worker',
            },
            release_decision: {
              disposition: 'await_review',
            },
            actions: [
              {
                id: 'hold_review',
                action_class: 'hold',
                summary: 'Hold until review is resolved.',
                commands: ['gh pr view 92 --json reviewDecision,url'],
                rationale: 'Automated review comments remain unresolved for this head SHA.',
              },
            ],
          };
        },
      },
    });

    expect(result).toMatchObject({
      delivery_event_count: 4,
      task_results: [
        expect.objectContaining({
          derived_trigger: 'bugbot_comments',
          new_delivery_event_count: 4,
        }),
      ],
    });
    expect(repository.getSnapshot().state.delivery_events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event_family: 'review_comment',
        lifecycle_trigger: 'bugbot_comments',
        payload: expect.objectContaining({
          review_id: 'review-comment-1',
          commit_oid: 'abc123',
        }),
      }),
    ]));
  });

  it('ignores superseded failing delivery events once a later approved-and-green state is observed on the same head', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const firstResult = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-30T09:00:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-30T09:00:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-30T08:59:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-30T09:00:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'changes_requested',
              ci_status: 'failing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
      },
    });

    const secondResult = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-30T09:05:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-30T09:05:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-30T09:04:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-30T09:05:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
      },
    });

    expect(firstResult.task_results[0]).toMatchObject({
      derived_trigger: 'changes_requested',
      new_delivery_event_count: 3,
    });
    expect(secondResult.task_results[0]).toMatchObject({
      derived_trigger: 'approved_and_green',
      new_delivery_event_count: 3,
    });
  });

  it('produces deterministic delivery envelopes and routing decisions for the same seeded state', async () => {
    const createRepositoryAndRun = async () => {
      const repository = createStateRepository({
        repoRoot: createTempRepo(),
        projectId: PROJECT_ID,
      });
      seedActiveTask(repository, 'shadow');

      const result = await runControllerLoop({
        repoRoot: repository.getSnapshot().paths.repoRoot,
        cwd: repository.getSnapshot().paths.repoRoot,
        projectId: PROJECT_ID,
        controllerId: 'default',
        now: '2026-03-30T08:45:00.000Z',
        deps: {
          loadAoProjectObservation: async () => ({
            observed_at: '2026-03-30T08:45:00.000Z',
            workers: [
              {
                session_name: 'worker-92',
                session_runtime_id: 'worker-92',
                issue_number: 92,
                branch_name: 'feat/issue-92',
                pr_number: 92,
                lifecycle_state: 'idle',
                last_seen_at: '2026-03-30T08:44:45.000Z',
                freshness: { status: 'fresh' },
              },
            ],
          }),
          loadGitHubObservationSet: async () => ({
            observed_at: '2026-03-30T08:45:00.000Z',
            prs: [
              {
                pr_number: 92,
                state: 'OPEN',
                head_branch: 'feat/issue-92',
                head_sha: 'abc123',
                review_status: 'changes_requested',
                ci_status: 'failing',
                mergeability: 'mergeable',
                is_draft: false,
                url: 'https://example.test/pr/92',
              },
            ],
          }),
          resolveLifecycleReport: async ({ derivedTrigger }) => ({
            top_status: 'hold',
            routing_decision: {
              action: 'continue_current_worker',
            },
            release_decision: {
              disposition: 'await_ci',
            },
            actions: [
              {
                id: `hold-${derivedTrigger}`,
                action_class: 'hold',
                summary: `Hold on ${derivedTrigger}.`,
                commands: ['gh pr checks 92'],
                rationale: 'Deterministic shadow routing must be stable for identical state.',
              },
            ],
          }),
        },
      });

      return {
        result,
        deliveryEvents: repository.getSnapshot().state.delivery_events,
        actions: repository.getSnapshot().state.actions,
      };
    };

    const left = await createRepositoryAndRun();
    const right = await createRepositoryAndRun();

    expect(left.result.task_results).toEqual(right.result.task_results);
    expect(left.deliveryEvents).toEqual(right.deliveryEvents);
    expect(left.actions).toEqual(right.actions);
  });

  it('assist mode executes only explicit class A actions and keeps higher-risk actions gated', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'assist');
    seedCleanRuntimePreflight(repository);

    const lifecycleReport = {
      top_status: 'continue',
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-92',
      },
      release_decision: {
        disposition: 'notify_human_ready',
      },
      actions: [
        {
          id: 'continue_worker',
          action_class: 'continue_worker',
          summary: 'Continue the current worker owner.',
          commands: ['ao status -p my-project --json'],
          rationale: 'Ownership continuity is clear enough to continue the current worker.',
        },
        {
          id: 'restore_worker',
          action_class: 'restore_worker',
          summary: 'Restore the previously identified worker.',
          commands: ['ao status -p my-project --json', 'node scripts/ao-reconcile.js --pr 92 --json --strict'],
          rationale: 'The prior owner is still identifiable, but continuity is stale.',
        },
        {
          id: 'hold_ci',
          action_class: 'hold',
          summary: 'Hold until CI is green.',
          commands: ['gh pr checks 92'],
          rationale: 'Required CI state is not yet ready.',
        },
        {
          id: 'notify_human_ready',
          action_class: 'notify_human',
          summary: 'Notify the human that the PR appears ready.',
          commands: ['terraform plan'],
          rationale: 'This should be blocked by policy because terraform is not an allowlisted tool.',
        },
      ],
    };

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-29T06:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        resolveLifecycleReport: async () => lifecycleReport,
        ensureRuntimePreflights: () => repository.getSnapshot().state.runtime_preflights,
      },
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 4,
      executed_action_count: 1,
      blocked_action_count: 2,
      policy_blocked_action_count: 1,
      task_results: [
        expect.objectContaining({
          proposed_action_count: 4,
          executed_action_count: 1,
          blocked_action_count: 2,
          policy_blocked_action_count: 1,
          continuity: expect.objectContaining({
            posture: 'active_owner',
            recommended_action: 'continue_current_worker',
          }),
          decision_chain: expect.objectContaining({
            contract_status: 'authoritative_pr_chain',
          }),
          assist_actions: expect.arrayContaining([
            expect.objectContaining({
              action_kind: 'continue_worker',
              status: 'executed',
              risk_class: 'class_a',
              policy_decision: 'allow',
              model_executable: true,
              model_reason: 'class_a_allowlist',
              execution_reason: 'class_a_assist_execution',
              runtime_preflight_status: 'clean',
              idempotency_mode: 'action_status_gate',
              rollback_mode: 'audit_only',
            }),
            expect.objectContaining({
              action_kind: 'restore_worker',
              status: 'blocked',
              risk_class: 'class_c',
              policy_decision: 'allow',
              model_executable: false,
              model_reason: 'runtime_ownership_change_forbidden',
              execution_reason: 'runtime_ownership_change_forbidden',
              rollback_mode: 'manual_only',
            }),
            expect.objectContaining({
              action_kind: 'hold_ci',
              status: 'blocked',
              risk_class: 'class_b',
              policy_decision: 'allow',
              model_executable: false,
              model_reason: 'advisory_hold_non_executable',
              execution_reason: 'advisory_hold_non_executable',
              rollback_mode: 'not_applicable',
            }),
            expect.objectContaining({
              action_kind: 'notify_human_ready',
              status: 'blocked',
              risk_class: 'class_a',
              policy_decision: 'deny',
              model_executable: true,
              model_reason: 'class_a_allowlist',
              execution_reason: 'policy_denied',
              rollback_mode: 'audit_only',
            }),
          ]),
        }),
      ],
    });

    expect(repository.getSnapshot().state.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action_kind: 'continue_worker',
        status: 'executed',
        payload: expect.objectContaining({
          action_model: expect.objectContaining({
            risk_class: 'class_a',
          }),
        }),
      }),
      expect.objectContaining({
        action_kind: 'restore_worker',
        status: 'blocked',
        payload: expect.objectContaining({
          action_model: expect.objectContaining({
            risk_class: 'class_c',
          }),
          execution: expect.objectContaining({
            outcome: 'blocked',
          }),
        }),
      }),
      expect.objectContaining({
        action_kind: 'hold_ci',
        status: 'blocked',
        payload: expect.objectContaining({
          action_model: expect.objectContaining({
            risk_class: 'class_b',
          }),
          execution: expect.objectContaining({
            outcome: 'blocked',
          }),
        }),
      }),
      expect.objectContaining({
        action_kind: 'notify_human_ready',
        status: 'blocked',
        payload: expect.objectContaining({
          policy: expect.objectContaining({
            decision: 'deny',
          }),
        }),
      }),
    ]));
    expect(repository.getSnapshot().state.controller_run_metrics).toEqual([
      expect.objectContaining({
        task_id: 'issue-92',
        controller_mode: 'assist',
        trigger_kind: 'approved_and_green',
        failure_class: 'policy_block',
        intervention_counts: expect.objectContaining({
          human_gate: 0,
          override: 0,
          explicit_resume: 0,
          successor_handoff: 0,
          policy_block: 1,
          preflight_block: 0,
        }),
      }),
    ]);
  });

  it('blocks notify_human_ready in assist mode when independent review has not passed for the current head sha', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'assist');
    seedCleanRuntimePreflight(repository);
    repository.upsertReviewRecord(createReviewRecord({
      review_id: 'review-issue-92-1',
      task_id: 'issue-92',
      issue_number: 92,
      pr_number: 92,
      status: 'claimed',
      trigger_kind: 'ready_for_review',
      target_branch: 'feat/issue-92',
      target_head_sha: 'stale-review-sha',
      requested_by_session_name: 'worker-92',
      requested_by_session_id: 'worker-92',
      implementation_session_name: 'worker-92',
      implementation_session_id: 'worker-92',
      reviewer_session_name: 'worker-92-review',
      reviewer_session_id: 'worker-92-review',
      verification_baseline: [
        {
          category: 'workspace_sanity',
          commands: ['git status --short'],
        },
      ],
      freeze_status: 'active',
      created_at: '2026-04-03T15:00:00.000Z',
      updated_at: '2026-04-03T15:01:00.000Z',
    }));

    const lifecycleReport = {
      top_status: 'continue',
      routing_decision: {
        action: 'continue_current_worker',
        owner_session: 'worker-92',
      },
      release_decision: {
        disposition: 'notify_human_ready',
      },
      actions: [
        {
          id: 'continue_worker',
          action_class: 'continue_worker',
          summary: 'Continue the current worker owner.',
          commands: ['ao status -p my-project --json'],
          rationale: 'Ownership continuity is clear enough to continue the current worker.',
        },
        {
          id: 'notify_human_ready',
          action_class: 'notify_human',
          summary: 'Notify the human that the PR appears ready.',
          commands: ['gh pr view 92 --json mergeable,reviewDecision,isDraft,url'],
          rationale: 'Human approval remains required even when the PR appears ready.',
        },
      ],
    };

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-04-03T15:02:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-04-03T15:02:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-04-03T15:01:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-04-03T15:02:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        resolveLifecycleReport: async () => lifecycleReport,
        ensureRuntimePreflights: () => repository.getSnapshot().state.runtime_preflights,
      },
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 1,
      executed_action_count: 0,
      blocked_action_count: 1,
      task_results: [
        expect.objectContaining({
          blocking_reasons: expect.arrayContaining([
            expect.objectContaining({
              code: 'release_waiting_on_review',
            }),
          ]),
          release_decision: expect.objectContaining({
            disposition: 'await_review',
            basis: ['review_target_mismatch'],
          }),
          next_actions: [
            expect.objectContaining({
              id: 'hold_review',
            }),
          ],
          assist_actions: [
            expect.objectContaining({
              action_kind: 'hold_review',
              status: 'blocked',
              execution_reason: 'advisory_hold_non_executable',
            }),
          ],
        }),
      ],
    });
  });

  it('assist mode blocks class A actions until runtime preflight has passed', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'assist');

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [
            {
              session_name: 'worker-92',
              session_runtime_id: 'worker-92',
              issue_number: 92,
              branch_name: 'feat/issue-92',
              pr_number: 92,
              lifecycle_state: 'idle',
              last_seen_at: '2026-03-29T06:40:45.000Z',
              freshness: { status: 'fresh' },
            },
          ],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [
            {
              pr_number: 92,
              state: 'OPEN',
              head_branch: 'feat/issue-92',
              head_sha: 'abc123',
              review_status: 'approved',
              ci_status: 'passing',
              mergeability: 'mergeable',
              is_draft: false,
              url: 'https://example.test/pr/92',
            },
          ],
        }),
        resolveLifecycleReport: async () => ({
          top_status: 'continue',
          routing_decision: {
            action: 'continue_current_worker',
          },
          release_decision: {
            disposition: 'continue_current_worker',
          },
          actions: [
            {
              id: 'continue_worker',
              action_class: 'continue_worker',
              summary: 'Continue the current worker owner.',
              commands: ['ao status -p my-project --json'],
              rationale: 'Ownership continuity is clear enough to continue the current worker.',
            },
          ],
        }),
      },
    });

    expect(result).toMatchObject({
      mode: 'assist',
      proposed_action_count: 1,
      executed_action_count: 0,
      blocked_action_count: 1,
      task_results: [
        expect.objectContaining({
          proposed_action_count: 1,
          executed_action_count: 0,
          blocked_action_count: 1,
        }),
      ],
    });

    expect(repository.getSnapshot().state.actions).toEqual([
      expect.objectContaining({
        action_kind: 'continue_worker',
        status: 'blocked',
        payload: expect.objectContaining({
          action_model: expect.objectContaining({
            phase4_assist: expect.objectContaining({
              executable: false,
              reason: 'runtime_preflight_clean',
            }),
          }),
          execution: expect.objectContaining({
            outcome: 'blocked',
            reason: 'runtime_preflight_clean',
          }),
        }),
      }),
    ]);
    expect(repository.getSnapshot().state.controller_run_metrics).toEqual([
      expect.objectContaining({
        task_id: 'issue-92',
        trigger_kind: 'approved_and_green',
        failure_class: 'preflight_block',
        intervention_counts: expect.objectContaining({
          preflight_block: 1,
        }),
      }),
    ]);
  });

  it('blocks when another active lease already exists for the same controller', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-other-holder',
      controller_id: 'default',
      holder_id: 'other-holder',
      holder_type: 'session',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
    }));

    await expect(runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);

    const snapshot = repository.getSnapshot().state;
    expect(snapshot.observations).toEqual([]);
    expect(snapshot.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-other-holder',
        status: 'active',
      }),
    ]);
  });

  it('does not persist a mode override when leadership acquisition loses to another active leader', async () => {
    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-other-holder',
      controller_id: 'default',
      holder_id: 'other-holder',
      holder_type: 'session',
      incarnation_id: 'other-incarnation',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      heartbeat_at: '2026-03-29T06:40:30.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
      metadata: {
        process_pid: process.pid,
        process_started_at: '2026-03-29T06:40:30.000Z',
        process_start_token: 'current-process-token',
      },
    }));

    await expect(runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      mode: 'assist',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);

    expect(repository.getSnapshot().state.controller_modes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        controller_id: 'default',
        mode: 'observe',
      }),
    ]));
    expect(repository.getSnapshot().state.controller_modes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        controller_id: 'default',
        mode: 'assist',
      }),
    ]));
  });

  it('requires an explicit durable holder identity when AO session env is missing', async () => {
    delete process.env.AO_SESSION_NAME;
    delete process.env.AO_SESSION_ID;
    delete process.env.AO_CALLER_TYPE;

    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const manualStart = () => runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    });

    await expect(Promise.allSettled([
      manualStart(),
      manualStart(),
    ])).resolves.toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringMatching(/holder identity/i),
        }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({
          message: expect.stringMatching(/holder identity/i),
        }),
      }),
    ]);

    expect(repository.getSnapshot().state.controller_leases).toEqual([]);
  });

  it('falls back from a blank AO_SESSION_NAME to AO_SESSION_ID when resolving holder identity', async () => {
    process.env.AO_SESSION_NAME = '';
    process.env.AO_SESSION_ID = 'fallback-session-id';
    delete process.env.AO_CALLER_TYPE;

    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    await expect(runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        holder_id: 'fallback-session-id',
        holder_type: 'session',
        status: 'released',
      }),
    ]);
  });

  it('renews the current holder lease instead of treating it as split-brain', async () => {
    process.env.AO_SESSION_NAME = 'same-holder';
    process.env.AO_CALLER_TYPE = 'session';

    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-same-holder-same-holder-incarnation',
      controller_id: 'default',
      holder_id: 'same-holder',
      holder_type: 'session',
      incarnation_id: 'same-holder-incarnation',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      heartbeat_at: '2026-03-29T06:40:30.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
      poll_interval_ms: 30000,
      shutdown_timeout_ms: 10000,
      last_run_started_at: '2026-03-29T06:40:30.000Z',
      last_run_completed_at: '2026-03-29T06:40:30.000Z',
      last_run_status: 'completed',
    }));

    await expect(runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      leaseIncarnationId: 'same-holder-incarnation',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
      processed_task_count: 1,
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-same-holder-same-holder-incarnation',
        holder_id: 'same-holder',
        status: 'released',
        acquired_at: '2026-03-29T06:40:30.000Z',
        heartbeat_at: '2026-03-29T06:41:00.000Z',
        incarnation_id: 'same-holder-incarnation',
        last_run_started_at: '2026-03-29T06:41:00.000Z',
        last_run_completed_at: '2026-03-29T06:41:00.000Z',
        last_run_status: 'completed',
      }),
    ]);
  });

  it('reclaims a stale controller lease before starting a new pass', async () => {
    process.env.AO_SESSION_NAME = 'replacement-holder';
    process.env.AO_CALLER_TYPE = 'session';

    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-stale-holder',
      controller_id: 'default',
      holder_id: 'stale-holder',
      holder_type: 'session',
      status: 'active',
      acquired_at: '2026-03-29T06:30:00.000Z',
      heartbeat_at: '2026-03-29T06:34:00.000Z',
      expires_at: '2026-03-29T06:35:00.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
      poll_interval_ms: 30000,
      shutdown_timeout_ms: 10000,
      last_run_started_at: '2026-03-29T06:34:00.000Z',
      last_run_completed_at: '2026-03-29T06:34:00.000Z',
      last_run_status: 'completed',
    }));

    await expect(runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
      processed_task_count: 1,
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lease_id: 'controller-default-stale-holder',
        holder_id: 'stale-holder',
        status: 'expired',
        released_at: '2026-03-29T06:41:00.000Z',
        release_reason: 'stale_leader_reclaimed',
      }),
      expect.objectContaining({
        holder_id: 'replacement-holder',
        status: 'released',
        heartbeat_at: '2026-03-29T06:41:00.000Z',
        last_run_status: 'completed',
      }),
    ]));
  });

  it('keeps leadership active across continuous passes and releases it on shutdown', async () => {
    process.env.AO_SESSION_NAME = 'continuous-holder';
    process.env.AO_CALLER_TYPE = 'session';

    const repository = createStateRepository({
      repoRoot: createTempRepo(),
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    const timestamps = [
      '2026-03-29T06:41:00.000Z',
      '2026-03-29T06:41:02.000Z',
      '2026-03-29T06:41:04.000Z',
    ];
    const betweenPassStatuses = [];

    const result = await runControllerLoop({
      repoRoot: repository.getSnapshot().paths.repoRoot,
      cwd: repository.getSnapshot().paths.repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      continuous: true,
      pollIntervalMs: 2000,
      shutdownTimeoutMs: 5000,
      maxPasses: 2,
      now: () => timestamps.shift() ?? '2026-03-29T06:41:04.000Z',
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => ({
          observed_at: now,
          prs: [],
        }),
        wait: async () => {
          const activeLease = repository.getSnapshot().state.controller_leases.find((lease) => lease.status === 'active');
          betweenPassStatuses.push({
            status: activeLease?.status ?? null,
            heartbeat_at: activeLease?.heartbeat_at ?? null,
            runtime_kind: activeLease?.runtime_kind ?? null,
          });
        },
      },
    });

    expect(result).toMatchObject({
      controller_id: 'default',
      mode: 'observe',
      processed_task_count: 2,
      pass_count: 2,
      runtime_kind: 'continuous',
      stop_reason: 'max_passes',
    });
    expect(betweenPassStatuses).toEqual([
      expect.objectContaining({
        status: 'active',
        runtime_kind: 'continuous',
      }),
    ]);
    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        holder_id: 'continuous-holder',
        status: 'released',
        acquired_at: '2026-03-29T06:41:00.000Z',
        heartbeat_at: '2026-03-29T06:41:04.000Z',
        runtime_kind: 'continuous',
        poll_interval_ms: 2000,
        shutdown_timeout_ms: 5000,
        last_run_started_at: '2026-03-29T06:41:04.000Z',
        last_run_completed_at: '2026-03-29T06:41:04.000Z',
        last_run_status: 'completed',
        release_reason: 'controller_runtime_max_passes',
      }),
    ]);
  });

  it('renews heartbeat during a long-running pass so another holder cannot reclaim leadership', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const finishGithubObservation = createDeferred();
    const firstRun = runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-primary',
      leaseTimeoutMs: 60,
      heartbeatIntervalMs: 15,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => {
          await finishGithubObservation.promise;
          return {
            observed_at: now,
            prs: [],
          };
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 90);
    });

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-secondary',
      leaseTimeoutMs: 60,
      heartbeatIntervalMs: 15,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => ({
          observed_at: now,
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);

    finishGithubObservation.resolve();
    await firstRun;

    const primaryLease = repository.getSnapshot().state.controller_leases.find((lease) => (
      lease.holder_id === 'manual-primary'
    ));
    expect(primaryLease).toEqual(expect.objectContaining({
      status: 'released',
    }));
    expect(new Date(primaryLease.heartbeat_at).getTime()).toBeGreaterThan(
      new Date(primaryLease.acquired_at).getTime(),
    );
  });

  it('blocks a concurrent same-holder incarnation from joining a live lease', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const finishGithubObservation = createDeferred();
    const firstRun = runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-same-holder',
      leaseIncarnationId: 'incarnation-a',
      leaseTimeoutMs: 200,
      heartbeatIntervalMs: 50,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => {
          await finishGithubObservation.promise;
          return {
            observed_at: now,
            prs: [],
          };
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-same-holder',
      leaseIncarnationId: 'incarnation-b',
      leaseTimeoutMs: 200,
      heartbeatIntervalMs: 50,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => ({
          observed_at: now,
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);

    finishGithubObservation.resolve();
    await firstRun;

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        holder_id: 'manual-same-holder',
        incarnation_id: 'incarnation-a',
        status: 'released',
      }),
    ]);
  });

  it('blocks a concurrent same-holder re-entry for a live legacy tokenless lease', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const finishGithubObservation = createDeferred();
    const firstRun = runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-legacy-same-holder',
      leaseIncarnationId: 'incarnation-a',
      leaseTimeoutMs: 200,
      heartbeatIntervalMs: 250,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => {
          await finishGithubObservation.promise;
          return {
            observed_at: now,
            prs: [],
          };
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });

    const activeLease = repository.getSnapshot().state.controller_leases.find((lease) => (
      lease.status === 'active'
    ));
    expect(activeLease).toBeDefined();

    const legacyMetadata = {
      ...(activeLease.metadata ?? {}),
    };
    delete legacyMetadata.process_start_token;
    repository.upsertControllerLease(createControllerLease({
      ...activeLease,
      metadata: legacyMetadata,
    }));

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-legacy-same-holder',
      leaseIncarnationId: 'incarnation-b',
      leaseTimeoutMs: 200,
      heartbeatIntervalMs: 250,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => ({
          observed_at: now,
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);

    finishGithubObservation.resolve();
    await expect(firstRun).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        holder_id: 'manual-legacy-same-holder',
        incarnation_id: 'incarnation-a',
        status: 'released',
      }),
    ]);
  });

  it('fences stale same-holder supersession so the old incarnation cannot release the newer lease', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');

    const finishFirstRun = createDeferred();
    const firstRun = runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-fenced-holder',
      leaseIncarnationId: 'incarnation-a',
      leaseTimeoutMs: 40,
      heartbeatIntervalMs: 250,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => {
          await finishFirstRun.promise;
          return {
            observed_at: now,
            prs: [],
          };
        },
      },
    });

    await new Promise((resolve) => {
      setTimeout(resolve, 80);
    });

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-fenced-holder',
      leaseIncarnationId: 'incarnation-b',
      leaseTimeoutMs: 40,
      heartbeatIntervalMs: 250,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async ({ now }) => ({
          observed_at: now,
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
    });

    finishFirstRun.resolve();
    await expect(firstRun).rejects.toThrow(/no longer active/i);

    expect(repository.getSnapshot().state.controller_leases).toEqual(expect.arrayContaining([
      expect.objectContaining({
        holder_id: 'manual-fenced-holder',
        incarnation_id: 'incarnation-a',
        status: 'expired',
        release_reason: 'stale_leader_reclaimed',
      }),
      expect.objectContaining({
        holder_id: 'manual-fenced-holder',
        incarnation_id: 'incarnation-b',
        status: 'released',
        release_reason: 'controller_loop_complete',
      }),
    ]));
  });

  it('recovers same-holder leadership when a reused pid has a mismatched process identity token', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-manual-reused-holder-recovered-incarnation',
      controller_id: 'default',
      holder_id: 'manual-reused-holder',
      holder_type: 'manual',
      incarnation_id: 'recovered-incarnation',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      heartbeat_at: '2026-03-29T06:40:45.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
      poll_interval_ms: 30000,
      shutdown_timeout_ms: 10000,
      metadata: {
        process_pid: process.pid,
        process_started_at: '2026-03-29T06:40:30.000Z',
        process_start_token: 'stale-process-token',
      },
    }));

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-reused-holder',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-manual-reused-holder-recovered-incarnation',
        holder_id: 'manual-reused-holder',
        incarnation_id: 'recovered-incarnation',
        status: 'released',
        metadata: expect.objectContaining({
          process_pid: process.pid,
        }),
      }),
    ]);
    expect(
      repository.getSnapshot().state.controller_leases[0].metadata.process_start_token,
    ).not.toBe('stale-process-token');
  });

  it('recovers same-holder leadership for a legacy tokenless lease after the pid-reuse compatibility fallback', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-manual-legacy-holder-legacy-incarnation',
      controller_id: 'default',
      holder_id: 'manual-legacy-holder',
      holder_type: 'manual',
      incarnation_id: 'legacy-incarnation',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      heartbeat_at: '2026-03-29T06:40:45.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
      poll_interval_ms: 30000,
      shutdown_timeout_ms: 10000,
      metadata: {
        process_pid: process.pid,
        process_started_at: '2026-03-29T06:40:30.000Z',
      },
    }));

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-legacy-holder',
      now: '2026-03-29T06:41:20.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:20.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:20.000Z',
          prs: [],
        }),
      },
    })).resolves.toMatchObject({
      controller_id: 'default',
      mode: 'observe',
    });

    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        lease_id: 'controller-default-manual-legacy-holder-legacy-incarnation',
        holder_id: 'manual-legacy-holder',
        incarnation_id: 'legacy-incarnation',
        status: 'released',
        metadata: expect.objectContaining({
          process_pid: process.pid,
        }),
      }),
    ]);
  });

  it('does not recover same-holder leadership when the prior lease lacks recoverable process identity metadata', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    repository.upsertControllerLease(createControllerLease({
      lease_id: 'controller-default-manual-missing-identity-current-incarnation',
      controller_id: 'default',
      holder_id: 'manual-missing-identity',
      holder_type: 'manual',
      incarnation_id: 'current-incarnation',
      status: 'active',
      acquired_at: '2026-03-29T06:40:30.000Z',
      heartbeat_at: '2026-03-29T06:40:45.000Z',
      expires_at: '2026-03-29T06:45:30.000Z',
      lease_timeout_ms: 300000,
      runtime_kind: 'continuous',
      poll_interval_ms: 30000,
      shutdown_timeout_ms: 10000,
      metadata: {},
    }));

    await expect(runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-missing-identity',
      now: '2026-03-29T06:41:00.000Z',
      deps: {
        loadAoProjectObservation: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          workers: [],
        }),
        loadGitHubObservationSet: async () => ({
          observed_at: '2026-03-29T06:41:00.000Z',
          prs: [],
        }),
      },
    })).rejects.toThrow(/active lease/i);
  });

  it('applies bounded shutdown semantics to an in-flight pass', async () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
    });
    seedActiveTask(repository, 'observe');
    const stopSignal = {
      aborted: false,
      requested_at: null,
    };
    const neverResolves = createDeferred();
    const startedAt = Date.now();

    setTimeout(() => {
      stopSignal.aborted = true;
      stopSignal.requested_at = new Date().toISOString();
    }, 10);

    const result = await runControllerLoop({
      repoRoot,
      cwd: repoRoot,
      projectId: PROJECT_ID,
      controllerId: 'default',
      holderId: 'manual-shutdown',
      continuous: true,
      shutdownTimeoutMs: 30,
      leaseTimeoutMs: 120,
      heartbeatIntervalMs: 15,
      stopSignal,
      now: () => new Date().toISOString(),
      deps: {
        loadAoProjectObservation: async ({ now }) => ({
          observed_at: now,
          workers: [],
        }),
        loadGitHubObservationSet: async () => neverResolves.promise,
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({
      controller_id: 'default',
      stop_reason: 'shutdown_timeout',
      pass_count: 0,
    });
    expect(repository.getSnapshot().state.controller_leases).toEqual([
      expect.objectContaining({
        holder_id: 'manual-shutdown',
        status: 'released',
        release_reason: 'controller_runtime_shutdown_timeout',
        last_run_status: 'stopping',
      }),
    ]);
  });
});
