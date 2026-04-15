import { describe, expect, it } from '@jest/globals';

import { createDefaultPolicyRules } from '../../scripts/ao/lib/policy-rules.js';
import {
  createRepoKnowledgeProfile,
  lintRepoKnowledge,
} from '../../scripts/ao/lib/repo-knowledge-lint.js';

const NOW = '2026-03-31T10:20:00.000Z';

function buildProfile(overrides = {}) {
  return createRepoKnowledgeProfile({
    project_id: 'my-project',
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
      {
        surface_id: 'infra.terraform',
        kind: 'infra',
        match_type: 'prefix',
        pattern: 'terraform/',
      },
      {
        surface_id: 'secret.env_files',
        kind: 'secret',
        match_type: 'prefix',
        pattern: '.env',
      },
    ],
    runtime_hints: {
      runtime_ref: 'runtime.github_local',
      policy_ref: 'policy.operator_gated',
      node_engine: '>=18.0.0',
      package_manager: 'npm',
      test_runner: 'jest',
    },
    ...overrides,
  });
}

function buildPackageJson(overrides = {}) {
  return {
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
}

describe('repo knowledge lint', () => {
  it('fails closed when the canonical verification surface is missing', () => {
    const profile = buildProfile({
      canonical_commands: {
        ...buildProfile().canonical_commands,
        verify: [],
      },
    });

    const result = lintRepoKnowledge({
      profile,
      packageJson: buildPackageJson(),
      documentationContract: profile,
      policyRules: createDefaultPolicyRules(),
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'fail_closed',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_canonical_verify_command',
          severity: 'error',
        }),
      ]),
    });
  });

  it('surfaces contradictory documentation contracts as explicit lint findings', () => {
    const profile = buildProfile();
    const documentationContract = {
      ...profile,
      canonical_commands: {
        ...profile.canonical_commands,
        verify: [
          {
            command_id: 'verify.test_run_in_band',
            command: 'npm run lint',
            source_ref: 'docs/setup/AO_REPO_KNOWLEDGE.md',
          },
        ],
      },
    };

    const result = lintRepoKnowledge({
      profile,
      packageJson: buildPackageJson(),
      documentationContract,
      policyRules: createDefaultPolicyRules(),
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'fail_closed',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'contradictory_doc_contract',
          severity: 'error',
        }),
      ]),
    });
  });

  it('fails closed when policy-risky surfaces are not labeled in the repo-knowledge profile', () => {
    const profile = buildProfile({
      risky_surfaces: [
        {
          surface_id: 'secret.env_files',
          kind: 'secret',
          match_type: 'prefix',
          pattern: '.env',
        },
      ],
    });

    const result = lintRepoKnowledge({
      profile,
      packageJson: buildPackageJson(),
      documentationContract: profile,
      policyRules: createDefaultPolicyRules(),
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'fail_closed',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown_risky_surface',
          severity: 'error',
          value: '.github/workflows/',
        }),
      ]),
    });
  });

  it('fails closed on unsafe canonical command defaults', () => {
    const profile = buildProfile({
      canonical_commands: {
        ...buildProfile().canonical_commands,
        setup: [
          {
            command_id: 'setup.install_dependencies',
            command: 'git push --force origin main',
            source_ref: 'docs/setup/AO_REPO_KNOWLEDGE.md',
          },
        ],
      },
    });

    const result = lintRepoKnowledge({
      profile,
      packageJson: buildPackageJson(),
      documentationContract: profile,
      policyRules: createDefaultPolicyRules(),
      now: NOW,
    });

    expect(result).toMatchObject({
      status: 'fail_closed',
      findings: expect.arrayContaining([
        expect.objectContaining({
          code: 'unsafe_canonical_command',
          severity: 'error',
          value: 'git push --force origin main',
        }),
      ]),
    });
  });
});
