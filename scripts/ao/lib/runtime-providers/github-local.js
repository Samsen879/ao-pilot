import { createRuntimeProviderContract } from '../runtime-contracts.js';

export const GITHUB_LOCAL_RUNTIME_PROVIDER = createRuntimeProviderContract({
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
    {
      requirement_id: 'package_manager.npm',
      requirement_kind: 'package_manager',
      summary: 'npm is available to bootstrap the repo-local workspace.',
      probe: {
        kind: 'command',
        command: 'npm',
      },
      setup_steps: ['Install npm.'],
    },
    {
      requirement_id: 'setup_step.install_dependencies',
      requirement_kind: 'setup_step',
      summary: 'Repo dependencies are installed in node_modules.',
      probe: {
        kind: 'path',
        path: 'node_modules',
      },
      setup_steps: ['Run npm install.'],
    },
    {
      requirement_id: 'network_posture.github_api',
      requirement_kind: 'network_posture',
      summary: 'GitHub API network access is available for AO coordination.',
      probe: {
        kind: 'capability',
        capability: 'network.github_api',
      },
      setup_steps: ['Allow outbound access to github.com and api.github.com.'],
    },
    {
      requirement_id: 'filesystem_posture.workspace_write',
      requirement_kind: 'filesystem_posture',
      summary: 'The repository worktree is writable for AO-managed edits.',
      probe: {
        kind: 'capability',
        capability: 'filesystem.workspace_write',
      },
      setup_steps: ['Grant write access to the repository worktree.'],
    },
    {
      requirement_id: 'secret_posture.github_auth',
      requirement_kind: 'secret_posture',
      summary: 'GitHub authentication is available for AO GitHub operations.',
      probe: {
        kind: 'capability',
        capability: 'secret.github_auth',
      },
      setup_steps: ['Authenticate gh CLI or export GITHUB_TOKEN.'],
    },
  ],
  metadata: {
    executor: 'local_workspace',
  },
});
