export const AO_POLICY_VERSION = 'ao.policy.v1';

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function createDefaultPolicyRules() {
  return cloneJsonValue({
    policy_version: AO_POLICY_VERSION,
    allowed_tools: [
      'ao',
      'bash',
      'gh',
      'git',
      'jest',
      'node',
      'npm',
      'npx',
      'sh',
    ],
    allowed_mcp_servers: [
      'github',
    ],
    allowed_network_targets: [
      'api.github.com',
      'github.com',
    ],
    credential_source_allowlist: {
      github_token: ['ao_managed', 'gh_cli_auth', 'operator_env'],
      openai_api_key: ['ao_managed', 'operator_env'],
    },
    workflow_prefixes: [
      '.github/workflows/',
    ],
    infra_prefixes: [
      '.github/actions/',
      'infra/',
      'pulumi/',
      'terraform/',
    ],
    infra_suffixes: [
      '.tf',
      '.tfvars',
    ],
    secret_prefixes: [
      '.env',
      '.env.',
    ],
    secret_suffixes: [
      '.pem',
      '.p12',
      '.pfx',
      '.key',
    ],
  });
}
