import * as fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  createRuntimePreflightCheck,
  createRuntimePreflightSnapshot,
} from './runtime-contracts.js';
import { getRuntimeProviderContract } from './runtime-providers/index.js';
import {
  buildRepoKnowledgeRef,
  listRepoKnowledgeCommands,
} from './repo-knowledge.js';

function resolveNow(now) {
  if (typeof now === 'function') return resolveNow(now());
  if (typeof now === 'string' && now.trim() !== '') return now.trim();
  return new Date().toISOString();
}

function defaultCommandExists(command) {
  const result = spawnSync('bash', ['-lc', `command -v ${JSON.stringify(String(command))}`], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function defaultPathExists(targetPath) {
  return fs.existsSync(targetPath);
}

function hasWritableAccess(cwd) {
  try {
    fs.accessSync(cwd, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasGitHubAuth(env) {
  if (env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_AUTH_TOKEN) return true;
  const result = spawnSync('gh', ['auth', 'status'], {
    stdio: 'ignore',
    env,
  });
  return result.status === 0;
}

function defaultCapability(capability, context) {
  const env = context?.env ?? process.env;

  switch (capability) {
    case 'network.github_api':
      return env.AO_RUNTIME_NETWORK_POSTURE !== 'offline' && env.AO_NETWORK_DISABLED !== '1';
    case 'filesystem.workspace_write':
      return hasWritableAccess(context?.cwd ?? process.cwd());
    case 'secret.github_auth':
      return hasGitHubAuth(env);
    default:
      return false;
  }
}

function normalizeCapabilityProbeResult(result) {
  if (result === true) {
    return {
      status: 'satisfied',
      details: [],
    };
  }

  if (result === false || result == null) {
    return {
      status: 'missing',
      details: [],
    };
  }

  if (typeof result === 'string' && result.trim() === 'unsupported') {
    return {
      status: 'unsupported',
      details: [],
    };
  }

  if (result != null && typeof result === 'object') {
    const status = result.status === 'unsupported' ? 'unsupported' : (
      result.status === 'missing' ? 'missing' : 'satisfied'
    );
    return {
      status,
      details: Array.isArray(result.details) ? result.details.map((value) => String(value)) : [],
    };
  }

  return {
    status: 'missing',
    details: [],
  };
}

function evaluateRequirement(requirement, context, probes) {
  if (requirement.probe.kind === 'command') {
    const commandExists = probes.commandExists(requirement.probe.command, context);
    return createRuntimePreflightCheck({
      requirement_id: requirement.requirement_id,
      requirement_kind: requirement.requirement_kind,
      status: commandExists ? 'satisfied' : 'missing',
      summary: requirement.summary,
      details: [`command: ${requirement.probe.command}`],
      setup_steps: requirement.setup_steps,
    });
  }

  if (requirement.probe.kind === 'path') {
    const targetPath = path.resolve(context.cwd, requirement.probe.path);
    const pathExists = probes.pathExists(targetPath, context);
    return createRuntimePreflightCheck({
      requirement_id: requirement.requirement_id,
      requirement_kind: requirement.requirement_kind,
      status: pathExists ? 'satisfied' : 'missing',
      summary: requirement.summary,
      details: [`path: ${targetPath}`],
      setup_steps: requirement.setup_steps,
    });
  }

  const capabilityResult = normalizeCapabilityProbeResult(
    probes.capability(requirement.probe.capability, context),
  );
  return createRuntimePreflightCheck({
    requirement_id: requirement.requirement_id,
    requirement_kind: requirement.requirement_kind,
    status: capabilityResult.status,
    summary: requirement.summary,
    details: [
      `capability: ${requirement.probe.capability}`,
      ...capabilityResult.details,
    ],
    setup_steps: requirement.setup_steps,
  });
}

function deriveOverallStatus(checks) {
  if (checks.some((item) => item.status === 'unsupported')) {
    return 'unsupported_provider';
  }

  if (checks.some((item) => item.status === 'missing')) {
    return 'missing_dependency';
  }

  return 'clean';
}

function buildRepoKnowledgeVerifyCheck(repoKnowledge) {
  const repoKnowledgeRef = buildRepoKnowledgeRef(repoKnowledge);
  if (!repoKnowledgeRef) return null;

  const verifyCommands = listRepoKnowledgeCommands(repoKnowledge, 'verify');
  const missingVerifySurface = repoKnowledgeRef.lint_status !== 'pass' || verifyCommands.length === 0;

  return createRuntimePreflightCheck({
    requirement_id: 'setup_step.canonical_verify_command',
    requirement_kind: 'setup_step',
    status: missingVerifySurface ? 'missing' : 'satisfied',
    summary: 'Repo knowledge declares a canonical verification command for this repository.',
    details: [
      `project_id: ${repoKnowledgeRef.project_id}`,
      `profile_version: ${repoKnowledgeRef.profile_version}`,
      ...verifyCommands.map((command) => `command: ${command.command}`),
    ],
    setup_steps: missingVerifySurface
      ? ['Declare a canonical verify command in docs/setup/AO_REPO_KNOWLEDGE.md and materialize repo knowledge.']
      : [],
  });
}

export function runRuntimeBootstrapPreflight({
  runtimeRef,
  cwd = process.cwd(),
  now = new Date().toISOString(),
  resolveRuntimeProvider = getRuntimeProviderContract,
  probes = {},
  env = process.env,
  repoKnowledge = null,
} = {}) {
  const timestamp = resolveNow(now);
  const runtimeProvider = resolveRuntimeProvider(runtimeRef);
  if (!runtimeProvider) {
    return createRuntimePreflightSnapshot({
      runtime_ref: String(runtimeRef),
      provider_id: null,
      observed_at: timestamp,
      status: 'unsupported_provider',
      contract: null,
      checks: [
        {
          requirement_id: `provider.${String(runtimeRef)}`,
          requirement_kind: 'runtime_provider',
          status: 'unsupported',
          summary: 'Runtime provider is not supported by the current AO runtime registry.',
          details: [`runtime_ref: ${String(runtimeRef)}`],
          setup_steps: [],
        },
      ],
    });
  }

  const context = {
    cwd,
    env,
    runtime_ref: runtimeProvider.runtime_ref,
    provider_id: runtimeProvider.provider_id,
  };
  const effectiveProbes = {
    commandExists: probes.commandExists ?? defaultCommandExists,
    pathExists: probes.pathExists ?? defaultPathExists,
    capability: probes.capability ?? defaultCapability,
  };
  const checks = runtimeProvider.bootstrap_requirements.map((requirement) => (
    evaluateRequirement(requirement, context, effectiveProbes)
  ));
  const repoKnowledgeCheck = buildRepoKnowledgeVerifyCheck(repoKnowledge);
  if (repoKnowledgeCheck) {
    checks.push(repoKnowledgeCheck);
  }

  return createRuntimePreflightSnapshot({
    runtime_ref: runtimeProvider.runtime_ref,
    provider_id: runtimeProvider.provider_id,
    observed_at: timestamp,
    status: deriveOverallStatus(checks),
    contract: runtimeProvider,
    checks,
  });
}
