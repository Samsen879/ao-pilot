import { describe, expect, it } from '@jest/globals';

const {
  BOOTSTRAP_PROBE_KINDS,
  BOOTSTRAP_REQUIREMENT_KINDS,
  RUNTIME_PREFLIGHT_CHECK_STATUSES,
  RUNTIME_PREFLIGHT_FORMAT,
  RUNTIME_PREFLIGHT_SCHEMA_VERSION,
  RUNTIME_PREFLIGHT_STATUSES,
  RUNTIME_PROVIDER_KINDS,
  RUNTIME_PROVIDER_SCHEMA_VERSION,
  createBootstrapRequirement,
  createRuntimePreflightSnapshot,
  createRuntimeProviderContract,
} = await import('../../scripts/ao/lib/runtime-contracts.js');
const {
  getRuntimeProviderContract,
} = await import('../../scripts/ao/lib/runtime-providers/index.js');

const NOW = '2026-03-30T10:00:00.000Z';

describe('runtime contracts', () => {
  it('freezes typed runtime-provider bootstrap enums', () => {
    expect(RUNTIME_PROVIDER_SCHEMA_VERSION).toBe('ao.runtime-provider.v1alpha1');
    expect(RUNTIME_PROVIDER_KINDS).toEqual(['github_local']);
    expect(BOOTSTRAP_REQUIREMENT_KINDS).toEqual([
      'language_runtime',
      'package_manager',
      'setup_step',
      'network_posture',
      'filesystem_posture',
      'secret_posture',
    ]);
    expect(BOOTSTRAP_PROBE_KINDS).toEqual(['command', 'path', 'capability']);
    expect(RUNTIME_PREFLIGHT_SCHEMA_VERSION).toBe('ao.runtime-preflight.v1alpha1');
    expect(RUNTIME_PREFLIGHT_FORMAT).toBe('ao_runtime_preflight');
    expect(RUNTIME_PREFLIGHT_CHECK_STATUSES).toEqual(['satisfied', 'missing', 'unsupported']);
    expect(RUNTIME_PREFLIGHT_STATUSES).toEqual([
      'clean',
      'missing_dependency',
      'unsupported_provider',
    ]);
  });

  it('normalizes bootstrap requirements and provider contracts', () => {
    expect(createBootstrapRequirement({
      requirement_id: 'language_runtime.node',
      requirement_kind: 'language_runtime',
      summary: 'Node.js runtime is available for AO scripts.',
      probe: {
        kind: 'command',
        command: 'node',
      },
      setup_steps: [
        'Install a supported Node.js runtime.',
      ],
      metadata: {
        minimum_major: 20,
      },
    })).toEqual({
      requirement_id: 'language_runtime.node',
      requirement_kind: 'language_runtime',
      summary: 'Node.js runtime is available for AO scripts.',
      probe: {
        kind: 'command',
        command: 'node',
      },
      setup_steps: [
        'Install a supported Node.js runtime.',
      ],
      metadata: {
        minimum_major: 20,
      },
    });

    expect(createRuntimeProviderContract({
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      provider_kind: 'github_local',
      display_name: 'GitHub local workspace',
      bootstrap_requirements: [
        {
          requirement_id: 'language_runtime.node',
          requirement_kind: 'language_runtime',
          summary: 'Node.js runtime is available for AO scripts.',
          probe: {
            kind: 'command',
            command: 'node',
          },
          setup_steps: ['Install Node.js.'],
        },
      ],
      metadata: {
        executor: 'local_workspace',
      },
    })).toEqual({
      schema_version: RUNTIME_PROVIDER_SCHEMA_VERSION,
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      provider_kind: 'github_local',
      display_name: 'GitHub local workspace',
      bootstrap_requirements: [
        {
          requirement_id: 'language_runtime.node',
          requirement_kind: 'language_runtime',
          summary: 'Node.js runtime is available for AO scripts.',
          probe: {
            kind: 'command',
            command: 'node',
          },
          setup_steps: ['Install Node.js.'],
          metadata: {},
        },
      ],
      metadata: {
        executor: 'local_workspace',
      },
    });
  });

  it('defines the GitHub local runtime contract with explicit bootstrap requirements', () => {
    const contract = getRuntimeProviderContract('runtime.github_local');

    expect(contract).toMatchObject({
      schema_version: RUNTIME_PROVIDER_SCHEMA_VERSION,
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      provider_kind: 'github_local',
      display_name: 'GitHub local workspace',
    });
    expect(contract.bootstrap_requirements.map((item) => item.requirement_kind)).toEqual([
      'language_runtime',
      'package_manager',
      'setup_step',
      'network_posture',
      'filesystem_posture',
      'secret_posture',
    ]);
    expect(contract.bootstrap_requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        requirement_id: 'language_runtime.node',
        requirement_kind: 'language_runtime',
        probe: {
          kind: 'command',
          command: 'node',
        },
      }),
      expect.objectContaining({
        requirement_id: 'package_manager.npm',
        requirement_kind: 'package_manager',
        probe: {
          kind: 'command',
          command: 'npm',
        },
      }),
      expect.objectContaining({
        requirement_id: 'setup_step.install_dependencies',
        requirement_kind: 'setup_step',
        probe: {
          kind: 'path',
          path: 'node_modules',
        },
        setup_steps: ['Run npm install.'],
      }),
      expect.objectContaining({
        requirement_id: 'network_posture.github_api',
        requirement_kind: 'network_posture',
        probe: {
          kind: 'capability',
          capability: 'network.github_api',
        },
      }),
      expect.objectContaining({
        requirement_id: 'filesystem_posture.workspace_write',
        requirement_kind: 'filesystem_posture',
        probe: {
          kind: 'capability',
          capability: 'filesystem.workspace_write',
        },
      }),
      expect.objectContaining({
        requirement_id: 'secret_posture.github_auth',
        requirement_kind: 'secret_posture',
        probe: {
          kind: 'capability',
          capability: 'secret.github_auth',
        },
      }),
    ]));
  });

  it('creates versioned runtime preflight snapshots with stable replay keys', () => {
    const first = createRuntimePreflightSnapshot({
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      observed_at: NOW,
      status: 'clean',
      contract: getRuntimeProviderContract('runtime.github_local'),
      checks: [
        {
          requirement_id: 'language_runtime.node',
          requirement_kind: 'language_runtime',
          status: 'satisfied',
          summary: 'Node.js runtime is available for AO scripts.',
          details: ['command: node'],
          setup_steps: ['Install Node.js.'],
        },
      ],
    });
    const second = createRuntimePreflightSnapshot({
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      observed_at: NOW,
      status: 'clean',
      contract: getRuntimeProviderContract('runtime.github_local'),
      checks: [
        {
          requirement_id: 'language_runtime.node',
          requirement_kind: 'language_runtime',
          status: 'satisfied',
          summary: 'Node.js runtime is available for AO scripts.',
          details: ['command: node'],
          setup_steps: ['Install Node.js.'],
        },
      ],
    });

    expect(first).toEqual(second);
    expect(first).toEqual({
      schema_version: RUNTIME_PREFLIGHT_SCHEMA_VERSION,
      format: RUNTIME_PREFLIGHT_FORMAT,
      runtime_ref: 'runtime.github_local',
      provider_id: 'github_local',
      status: 'clean',
      observed_at: NOW,
      replay_key: expect.stringMatching(/^runtime_preflight:/),
      contract: getRuntimeProviderContract('runtime.github_local'),
      checks: [
        {
          requirement_id: 'language_runtime.node',
          requirement_kind: 'language_runtime',
          status: 'satisfied',
          summary: 'Node.js runtime is available for AO scripts.',
          details: ['command: node'],
          setup_steps: ['Install Node.js.'],
        },
      ],
    });
  });
});
