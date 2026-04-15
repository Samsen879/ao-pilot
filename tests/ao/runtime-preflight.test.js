import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

const {
  runRuntimeBootstrapPreflight,
} = await import('../../scripts/ao/lib/runtime-preflight.js');
const {
  createRepoKnowledgeProfile,
} = await import('../../scripts/ao/lib/repo-knowledge-lint.js');
const {
  createManagedTask,
  createTaskSpecRecord,
} = await import('../../scripts/ao/lib/state-contracts.js');
const {
  createStateRepository,
} = await import('../../scripts/ao/lib/state-repository.js');

const PROJECT_ID = 'my-project';
const NOW = '2026-03-30T10:10:00.000Z';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-runtime-preflight-'));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createRepoKnowledge(overrides = {}) {
  const profile = createRepoKnowledgeProfile({
    project_id: PROJECT_ID,
    profile_version: 1,
    generated_at: NOW,
    canonical_commands: {
      setup: [
        {
          command_id: 'setup.install_dependencies',
          command: 'npm install',
          source_ref: 'package.json',
        },
      ],
      verify: [
        {
          command_id: 'verify.test_run_in_band',
          command: 'npm test -- --runInBand',
          source_ref: 'package.json#scripts.test',
        },
      ],
      build: [
        {
          command_id: 'build.production_bundle',
          command: 'npm run build',
          source_ref: 'package.json#scripts.build',
        },
      ],
    },
    risky_surfaces: [
      {
        surface_id: 'workflow.github_workflows',
        kind: 'workflow',
        match_type: 'prefix',
        pattern: '.github/workflows/',
      },
    ],
    runtime_hints: {
      runtime_ref: 'runtime.github_local',
      policy_ref: 'policy.operator_gated',
      node_engine: '>=18.0.0',
      package_manager: 'npm',
      test_runner: 'jest',
    },
  });

  return {
    schema_version: 'ao.repo-knowledge.v1alpha1',
    format: 'ao_repo_knowledge',
    project_id: PROJECT_ID,
    profile_version: 1,
    observed_at: NOW,
    replay_key: 'repo_knowledge:test',
    profile,
    lint: {
      schema_version: 'ao.repo-knowledge-lint.v1alpha1',
      format: 'ao_repo_knowledge_lint',
      status: 'pass',
      checked_at: NOW,
      findings: [],
    },
    ...overrides,
  };
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('runtime preflight', () => {
  it('classifies the GitHub local runtime as clean when every bootstrap requirement is satisfied', () => {
    const result = runRuntimeBootstrapPreflight({
      runtimeRef: 'runtime.github_local',
      cwd: '/tmp/my-project',
      now: NOW,
      probes: {
        commandExists: (command) => ['node', 'npm'].includes(command),
        pathExists: (filePath) => filePath.endsWith(`${path.sep}node_modules`),
        capability: (capability) => [
          'network.github_api',
          'filesystem.workspace_write',
          'secret.github_auth',
        ].includes(capability),
      },
    });

    expect(result).toMatchObject({
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      status: 'clean',
      observed_at: NOW,
      checks: [
        expect.objectContaining({
          requirement_id: 'language_runtime.node',
          status: 'satisfied',
        }),
        expect.objectContaining({
          requirement_id: 'package_manager.npm',
          status: 'satisfied',
        }),
        expect.objectContaining({
          requirement_id: 'setup_step.install_dependencies',
          status: 'satisfied',
        }),
        expect.objectContaining({
          requirement_id: 'network_posture.github_api',
          status: 'satisfied',
        }),
        expect.objectContaining({
          requirement_id: 'filesystem_posture.workspace_write',
          status: 'satisfied',
        }),
        expect.objectContaining({
          requirement_id: 'secret_posture.github_auth',
          status: 'satisfied',
        }),
      ],
    });
  });

  it('classifies missing bootstrap dependencies without collapsing them into an unsupported provider result', () => {
    const result = runRuntimeBootstrapPreflight({
      runtimeRef: 'runtime.github_local',
      cwd: '/tmp/my-project',
      now: NOW,
      probes: {
        commandExists: (command) => command === 'node',
        pathExists: () => false,
        capability: (capability) => capability === 'filesystem.workspace_write',
      },
    });

    expect(result.status).toBe('missing_dependency');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement_id: 'package_manager.npm',
        status: 'missing',
      }),
      expect.objectContaining({
        requirement_id: 'setup_step.install_dependencies',
        status: 'missing',
      }),
      expect.objectContaining({
        requirement_id: 'network_posture.github_api',
        status: 'missing',
      }),
      expect.objectContaining({
        requirement_id: 'secret_posture.github_auth',
        status: 'missing',
      }),
    ]));
  });

  it('classifies unknown runtime refs as unsupported providers', () => {
    const result = runRuntimeBootstrapPreflight({
      runtimeRef: 'runtime.unsupported_vm',
      cwd: '/tmp/my-project',
      now: NOW,
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });

    expect(result).toMatchObject({
      runtime_ref: 'runtime.unsupported_vm',
      provider_id: null,
      status: 'unsupported_provider',
      checks: [
        expect.objectContaining({
          requirement_id: 'provider.runtime.unsupported_vm',
          status: 'unsupported',
        }),
      ],
    });
  });

  it('fails closed when repo knowledge does not declare a canonical verification command', () => {
    const repoKnowledge = createRepoKnowledge({
      profile: createRepoKnowledgeProfile({
        ...createRepoKnowledge().profile,
        canonical_commands: {
          ...createRepoKnowledge().profile.canonical_commands,
          verify: [],
        },
      }),
      lint: {
        schema_version: 'ao.repo-knowledge-lint.v1alpha1',
        format: 'ao_repo_knowledge_lint',
        status: 'fail_closed',
        checked_at: NOW,
        findings: [
          {
            code: 'missing_canonical_verify_command',
            severity: 'error',
            surface: 'command_surface',
            value: 'verify',
            detail: null,
          },
        ],
      },
    });

    const result = runRuntimeBootstrapPreflight({
      runtimeRef: 'runtime.github_local',
      cwd: '/tmp/my-project',
      now: NOW,
      repoKnowledge,
      probes: {
        commandExists: () => true,
        pathExists: () => true,
        capability: () => true,
      },
    });

    expect(result.status).toBe('missing_dependency');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement_id: 'setup_step.canonical_verify_command',
        requirement_kind: 'setup_step',
        status: 'missing',
        details: expect.arrayContaining([
          'project_id: my-project',
          'profile_version: 1',
        ]),
      }),
    ]));
  });

  it('persists runtime preflight state durably and skips replay-identical rewrites', () => {
    const repoRoot = createTempRepo();
    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: () => NOW,
    });

    repository.upsertManagedTask(createManagedTask({
      task_id: 'issue-108',
      issue_number: 108,
      title: 'feat(ao): add runtime-provider contract and bootstrap preflight',
      branch_name: 'feat/108',
      worktree_path: repoRoot,
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    }));
    repository.upsertTaskSpec(createTaskSpecRecord({
      task_id: 'issue-108',
      source_kind: 'github_issue',
      source_issue_number: 108,
      created_at: NOW,
      updated_at: NOW,
      snapshot: {
        schema_version: 'ao.task-spec.v1alpha1',
        valid: true,
        findings: [],
        spec: {
          problem_type: 'issue_delivery',
          acceptance_contract: ['runtime preflight is durable'],
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          human_gates: ['operator_enroll'],
        },
      },
    }));

    const first = repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: NOW,
      probes: {
        commandExists: (command) => ['node', 'npm'].includes(command),
        pathExists: (filePath) => filePath.endsWith(`${path.sep}node_modules`),
        capability: () => true,
      },
    });
    const second = repository.ensureRuntimePreflights({
      cwd: repoRoot,
      now: NOW,
      probes: {
        commandExists: (command) => ['node', 'npm'].includes(command),
        pathExists: (filePath) => filePath.endsWith(`${path.sep}node_modules`),
        capability: () => true,
      },
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0].replay_key).toBe(first[0].replay_key);
    expect(repository.getSnapshot().state.runtime_preflights).toEqual([
      expect.objectContaining({
        runtime_ref: 'runtime.github_local',
        provider_id: 'github_local',
        status: 'clean',
        replay_key: first[0].replay_key,
      }),
    ]);
    expect(repository.listAuditEntries().filter((entry) => entry.entity_kind === 'runtime_preflight')).toEqual([
      expect.objectContaining({
        entity_kind: 'runtime_preflight',
        entity_id: 'runtime.github_local',
        operation: 'upsert',
      }),
    ]);
  });
});
