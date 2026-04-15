import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

const {
  inspectRepoKnowledgeRecordState,
  materializeRepoKnowledge,
  renderRepoKnowledgeDocContract,
} = await import('../../scripts/ao/lib/repo-knowledge.js');
const {
  createStateRepository,
} = await import('../../scripts/ao/lib/state-repository.js');

const PROJECT_ID = 'my-project';
const NOW = '2026-03-31T10:10:00.000Z';
const tempDirs = [];

function createTempRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-repo-knowledge-'));
  tempDirs.push(repoRoot);
  fs.mkdirSync(path.join(repoRoot, 'docs', 'setup'), { recursive: true });
  return repoRoot;
}

function writePackageJson(repoRoot, overrides = {}) {
  const packageJson = {
    name: 'ao-copilot',
    private: true,
    type: 'module',
    scripts: {
      test: 'node --experimental-vm-modules node_modules/jest/bin/jest.js',
      build: 'vite build',
    },
    engines: {
      node: '>=18.0.0',
      npm: '>=9.0.0',
    },
    ...overrides,
  };
  fs.writeFileSync(
    path.join(repoRoot, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  );
  return packageJson;
}

function writeRepoKnowledgeDoc(repoRoot, contract) {
  fs.writeFileSync(
    path.join(repoRoot, 'docs', 'setup', 'AO_REPO_KNOWLEDGE.md'),
    [
      '# AO Repo Knowledge',
      '',
      'This file mirrors the AO repo-knowledge contract for this repository.',
      '',
      renderRepoKnowledgeDocContract(contract),
      '',
    ].join('\n'),
    'utf8',
  );
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('repo knowledge', () => {
  it('materializes a versioned repo-knowledge snapshot with canonical commands, risky surfaces, and runtime hints', () => {
    const repoRoot = createTempRepo();
    writePackageJson(repoRoot);

    const firstPass = materializeRepoKnowledge({
      repoRoot,
      projectId: PROJECT_ID,
      now: NOW,
    });
    writeRepoKnowledgeDoc(repoRoot, firstPass.profile);

    const snapshot = materializeRepoKnowledge({
      repoRoot,
      projectId: PROJECT_ID,
      now: NOW,
    });

    expect(snapshot).toMatchObject({
      schema_version: 'ao.repo-knowledge.v1alpha1',
      format: 'ao_repo_knowledge',
      project_id: PROJECT_ID,
      profile_version: 1,
      observed_at: NOW,
      lint: {
        status: 'pass',
      },
      profile: {
        schema_version: 'ao.repo-knowledge-profile.v1alpha1',
        canonical_commands: {
          setup: [
            expect.objectContaining({
              command_id: 'setup.install_dependencies',
              command: 'npm install',
            }),
          ],
          verify: [
            expect.objectContaining({
              command_id: 'verify.test_run_in_band',
              command: 'npm test -- --runInBand',
            }),
          ],
          build: [
            expect.objectContaining({
              command_id: 'build.production_bundle',
              command: 'npm run build',
            }),
          ],
        },
        risky_surfaces: expect.arrayContaining([
          expect.objectContaining({
            surface_id: 'workflow.github_workflows',
            kind: 'workflow',
          }),
          expect.objectContaining({
            surface_id: 'secret.env_files',
            kind: 'secret',
          }),
        ]),
        runtime_hints: {
          runtime_ref: 'runtime.github_local',
          policy_ref: 'policy.operator_gated',
          node_engine: '>=18.0.0',
          package_manager: 'npm',
          test_runner: 'jest',
        },
      },
    });
    expect(snapshot.replay_key).toMatch(/^repo_knowledge:/);
  });

  it('persists repo-knowledge state durably and skips replay-identical rewrites', () => {
    const repoRoot = createTempRepo();
    writePackageJson(repoRoot);
    const firstPass = materializeRepoKnowledge({
      repoRoot,
      projectId: PROJECT_ID,
      now: NOW,
    });
    writeRepoKnowledgeDoc(repoRoot, firstPass.profile);

    const repository = createStateRepository({
      repoRoot,
      projectId: PROJECT_ID,
      clock: () => NOW,
    });

    const first = repository.ensureRepoKnowledge({
      now: NOW,
    });
    const second = repository.ensureRepoKnowledge({
      now: '2026-03-31T10:11:00.000Z',
    });

    expect(first.replay_key).toBe(second.replay_key);
    expect(repository.getSnapshot().state.repo_knowledge).toEqual([
      expect.objectContaining({
        project_id: PROJECT_ID,
        profile_version: 1,
        lint_status: 'pass',
        replay_key: first.replay_key,
      }),
    ]);
    expect(repository.listAuditEntries().filter((entry) => entry.entity_kind === 'repo_knowledge')).toEqual([
      expect.objectContaining({
        entity_kind: 'repo_knowledge',
        entity_id: PROJECT_ID,
        operation: 'upsert',
      }),
    ]);
  });

  it('detects stale and mixed-version repo-knowledge state', () => {
    const repoRoot = createTempRepo();
    writePackageJson(repoRoot);
    const firstPass = materializeRepoKnowledge({
      repoRoot,
      projectId: PROJECT_ID,
      now: NOW,
    });
    writeRepoKnowledgeDoc(repoRoot, firstPass.profile);
    const snapshot = materializeRepoKnowledge({
      repoRoot,
      projectId: PROJECT_ID,
      now: NOW,
    });

    expect(inspectRepoKnowledgeRecordState({
      project_id: PROJECT_ID,
      profile_version: snapshot.profile_version,
      lint_status: snapshot.lint.status,
      snapshot,
    })).toMatchObject({
      status: 'current',
      findings: [],
    });

    expect(inspectRepoKnowledgeRecordState({
      project_id: PROJECT_ID,
      profile_version: 0,
      lint_status: snapshot.lint.status,
      snapshot: {
        ...snapshot,
        profile_version: 0,
      },
    })).toMatchObject({
      status: 'stale',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'stale_repo_knowledge_profile',
        }),
      ]),
    });

    expect(inspectRepoKnowledgeRecordState({
      project_id: PROJECT_ID,
      profile_version: snapshot.profile_version,
      lint_status: snapshot.lint.status,
      snapshot: {
        ...snapshot,
        schema_version: 'ao.repo-knowledge.v0alpha1',
      },
    })).toMatchObject({
      status: 'mixed_version',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'mixed_repo_knowledge_schema_version',
        }),
      ]),
    });
  });
});
