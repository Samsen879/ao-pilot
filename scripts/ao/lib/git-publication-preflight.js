import fs from 'node:fs';
import path from 'node:path';

import { LOCAL_COMMAND_RUNNER } from './providers/command-runner.js';

export const GIT_PUBLICATION_PREFLIGHT_SCHEMA_VERSION =
  'ao.git-publication-preflight.v1';

export const GIT_PUBLICATION_PREFLIGHT_EXIT_CODES = Object.freeze({
  passed: 0,
  blocked: 2,
  invalid_usage: 4,
});

export class GitPublicationPreflightUsageError extends Error {}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PRINCIPAL_PATTERN = /^[A-Za-z0-9-]+$/;
const REMOTE_PATTERN = /^[A-Za-z0-9._-]+$/;
const OID_PATTERN = /^[0-9a-f]{40}$/i;

function cleanLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0].trim();
}

function successful(result) {
  return result?.status === 0 && result?.signal == null && result?.error == null;
}

function run(runner, command, args, cwd, env = {}) {
  return runner.run(command, args, {
    cwd,
    env,
  });
}

function splitFirstCommandToken(value) {
  const input = value.trim();
  if (input === '') return null;
  const match = input.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function helperExecutable(helper) {
  const trimmed = helper.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('!')) {
    return splitFirstCommandToken(trimmed.slice(1));
  }
  const token = splitFirstCommandToken(trimmed);
  if (token == null) return null;
  if (token.includes('/') || token.includes('\\')) return token;
  return `git-credential-${token}`;
}

export function resolveExecutableOnPath(executable, {
  env = process.env,
  access = fs.accessSync,
} = {}) {
  if (typeof executable !== 'string' || executable.trim() === '') return false;
  const candidate = executable.trim();
  const candidates = path.isAbsolute(candidate) || candidate.includes(path.sep)
    ? [candidate]
    : String(env.PATH ?? '').split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, candidate));
  return candidates.some((resolved) => {
    try {
      access(resolved, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function inspectHelper(helper, resolveExecutable) {
  const executable = helperExecutable(helper);
  const shellForm = helper.trim().startsWith('!');
  return {
    kind: shellForm ? 'shell_command' : 'git_credential_helper',
    executable_shape: executable == null
      ? 'missing'
      : path.isAbsolute(executable)
        ? 'absolute_path'
        : 'path_lookup',
    available: executable != null && resolveExecutable(executable),
    value_redacted: true,
  };
}

export function parseGitHubRepository(remoteUrl) {
  const value = cleanLine(remoteUrl);
  let match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (match) {
    const repository = `${match[1]}/${match[2]}`;
    return REPOSITORY_PATTERN.test(repository) ? {
      repository,
      transport: 'https',
    } : null;
  }
  match = value.match(/^(?:ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (match) {
    const repository = `${match[1]}/${match[2]}`;
    return REPOSITORY_PATTERN.test(repository) ? {
      repository,
      transport: 'ssh',
    } : null;
  }
  return null;
}

function classifyEmail(email, principal) {
  const normalized = cleanLine(email).toLowerCase();
  const login = principal.toLowerCase();
  if (normalized === '') {
    return { present: false, shape: 'missing', privacy_compatible: false };
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    return { present: true, shape: 'invalid', privacy_compatible: false };
  }
  const compatible = normalized === `${login}@users.noreply.github.com`
    || new RegExp(`^[0-9]+\\+${login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}@users\\.noreply\\.github\\.com$`, 'i')
      .test(normalized);
  return {
    present: true,
    shape: compatible ? 'github_noreply' : 'non_noreply',
    privacy_compatible: compatible,
  };
}

function configValue(runner, cwd, key) {
  const result = run(runner, 'git', ['config', '--get', key], cwd);
  return successful(result) ? cleanLine(result.stdout) : '';
}

function identityEvidence({ runner, cwd, env, principal, role }) {
  const prefix = role === 'author' ? 'GIT_AUTHOR' : 'GIT_COMMITTER';
  const configuredName = env[`${prefix}_NAME`] ?? configValue(runner, cwd, 'user.name');
  const configuredEmail = env[`${prefix}_EMAIL`] ?? configValue(runner, cwd, 'user.email');
  return {
    name_present: cleanLine(configuredName) !== '',
    email: classifyEmail(configuredEmail, principal),
    values_redacted: true,
  };
}

function finding(code, summary, evidence = {}) {
  return {
    code,
    severity: 'blocker',
    summary,
    evidence,
  };
}

function readConfiguredHelpers(runner, cwd, expectedRepository) {
  const result = run(runner, 'git', [
    'config',
    '--get-urlmatch',
    'credential.helper',
    `https://github.com/${expectedRepository}`,
  ], cwd);
  if (result?.status === 1 && result?.signal == null && result?.error == null) return [];
  if (!successful(result)) return null;
  const values = String(result.stdout ?? '').split(/\r?\n/);
  if (values.at(-1) === '') values.pop();
  return values.reduce((effective, value) => {
    const helper = value.trim();
    if (helper === '') return [];
    effective.push(helper);
    return effective;
  }, []);
}

function validateInput({ expectedRepository, expectedPrincipal, workerPrincipal, remote }) {
  if (!REPOSITORY_PATTERN.test(expectedRepository ?? '')) {
    throw new GitPublicationPreflightUsageError('Expected repository must use owner/name form');
  }
  for (const [label, value] of [
    ['Expected principal', expectedPrincipal],
    ['Worker principal', workerPrincipal],
  ]) {
    if (!PRINCIPAL_PATTERN.test(value ?? '')) {
      throw new GitPublicationPreflightUsageError(`${label} is required and must be a GitHub login`);
    }
  }
  if (!REMOTE_PATTERN.test(remote ?? '')) {
    throw new GitPublicationPreflightUsageError('Remote name is invalid');
  }
}

export function runGitPublicationPreflight({
  cwd = process.cwd(),
  expectedRepository,
  expectedPrincipal,
  workerPrincipal,
  remote = 'origin',
  commandScopedCredentialHelper = null,
  runner = LOCAL_COMMAND_RUNNER,
  env = process.env,
  now = () => new Date().toISOString(),
  resolveExecutable = (executable) => resolveExecutableOnPath(executable, { env }),
} = {}) {
  validateInput({ expectedRepository, expectedPrincipal, workerPrincipal, remote });
  if (
    commandScopedCredentialHelper != null
      && (
        typeof commandScopedCredentialHelper !== 'string'
          || commandScopedCredentialHelper.trim() === ''
          || /[\r\n\0]/.test(commandScopedCredentialHelper)
      )
  ) {
    throw new GitPublicationPreflightUsageError('Command-scoped credential helper is invalid');
  }

  const findings = [];
  const remoteResult = run(runner, 'git', ['remote', 'get-url', '--push', remote], cwd);
  const parsedRemote = successful(remoteResult)
    ? parseGitHubRepository(remoteResult.stdout)
    : null;
  const repositoryMatches = parsedRemote?.repository.toLowerCase()
    === expectedRepository.toLowerCase();
  if (parsedRemote == null) {
    findings.push(finding(
      'publication_remote_unverified',
      'The publication remote is missing or is not a canonical GitHub transport.',
      { remote_name: remote },
    ));
  } else if (!repositoryMatches) {
    findings.push(finding(
      'publication_repository_mismatch',
      'The publication remote does not match the admitted repository.',
      { remote_name: remote, observed_repository: parsedRemote.repository },
    ));
  }

  const authResult = run(runner, 'gh', ['api', 'user', '--jq', '.login'], cwd, {
    GH_PROMPT_DISABLED: '1',
  });
  const authenticatedPrincipal = successful(authResult) ? cleanLine(authResult.stdout) : '';
  const authenticationVerified = PRINCIPAL_PATTERN.test(authenticatedPrincipal);
  if (!authenticationVerified) {
    findings.push(finding(
      'github_authentication_unavailable',
      'The authenticated GitHub principal could not be verified non-interactively.',
    ));
  } else if (authenticatedPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
    findings.push(finding(
      'github_principal_mismatch',
      'The authenticated GitHub principal does not match the admitted principal.',
      { observed_principal: authenticatedPrincipal },
    ));
  }
  if (workerPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
    findings.push(finding(
      'worker_principal_mismatch',
      'The Worker and Orchestrator publication principals do not agree.',
      { worker_principal: workerPrincipal },
    ));
  }

  const configuredHelpers = readConfiguredHelpers(runner, cwd, expectedRepository);
  const effectiveHelperValues = commandScopedCredentialHelper == null
    ? configuredHelpers
    : [commandScopedCredentialHelper];
  const helperEvidence = effectiveHelperValues == null
    ? []
    : effectiveHelperValues.map((helper) => inspectHelper(helper, resolveExecutable));
  const helpersVerified = effectiveHelperValues != null
    && helperEvidence.length > 0
    && helperEvidence.every((helper) => helper.available);
  if (!helpersVerified) {
    findings.push(finding(
      effectiveHelperValues == null
        ? 'credential_helper_config_unreadable'
        : helperEvidence.length === 0
          ? 'credential_helper_missing'
          : 'credential_helper_executable_missing',
      'The effective credential helper cannot be verified as executable.',
      { helper_count: helperEvidence.length },
    ));
  }

  const author = identityEvidence({
    runner,
    cwd,
    env,
    principal: expectedPrincipal,
    role: 'author',
  });
  const committer = identityEvidence({
    runner,
    cwd,
    env,
    principal: expectedPrincipal,
    role: 'committer',
  });
  for (const [role, identity] of [['author', author], ['committer', committer]]) {
    if (!identity.name_present) {
      findings.push(finding(
        `git_${role}_name_missing`,
        `The effective Git ${role} name is missing.`,
      ));
    }
    if (!identity.email.privacy_compatible) {
      findings.push(finding(
        `git_${role}_email_privacy_incompatible`,
        `The effective Git ${role} email is not the verified principal's GitHub noreply form.`,
        { email_shape: identity.email.shape, value_redacted: true },
      ));
    }
  }

  const eligibleForProbe = repositoryMatches
    && authenticationVerified
    && authenticatedPrincipal.toLowerCase() === expectedPrincipal.toLowerCase()
    && workerPrincipal.toLowerCase() === expectedPrincipal.toLowerCase()
    && helpersVerified
    && author.name_present
    && author.email.privacy_compatible
    && committer.name_present
    && committer.email.privacy_compatible;
  let probe = {
    attempted: false,
    status: 'skipped_blocked',
    head_oid_shape_valid: false,
    remote_mutation: false,
  };
  if (eligibleForProbe) {
    const helperArgs = commandScopedCredentialHelper == null
      ? []
      : [
          '-c',
          'credential.helper=',
          '-c',
          `credential.helper=${commandScopedCredentialHelper}`,
        ];
    const probeResult = run(runner, 'git', [
      '-c',
      'credential.interactive=never',
      ...helperArgs,
      'ls-remote',
      '--exit-code',
      remote,
      'HEAD',
    ], cwd, {
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
    });
    const [headOid, headRef, ...extra] = String(probeResult.stdout ?? '').trim().split(/\s+/);
    const validHead = successful(probeResult)
      && OID_PATTERN.test(headOid ?? '')
      && headRef === 'HEAD'
      && extra.length === 0;
    probe = {
      attempted: true,
      status: validHead ? 'passed' : 'blocked',
      head_oid_shape_valid: validHead,
      remote_mutation: false,
    };
    if (!validHead) {
      findings.push(finding(
        'readonly_remote_probe_failed',
        'The non-interactive read-only remote HEAD probe failed.',
      ));
    }
  }

  const status = findings.length === 0 ? 'passed' : 'blocked';
  return {
    schema_version: GIT_PUBLICATION_PREFLIGHT_SCHEMA_VERSION,
    generated_at: now(),
    status,
    risk: {
      tier: 'R2',
      boundary: 'diagnostic_git_publication_preflight',
      forbidden_mutations: [
        'global_git_configuration',
        'credential_provisioning',
        'account_switching',
        'remote_probe_mutation',
      ],
    },
    scope: {
      expected_repository: expectedRepository,
      expected_principal: expectedPrincipal,
      worker_principal: workerPrincipal,
      remote_name: remote,
    },
    checks: {
      remote: {
        verified: repositoryMatches,
        repository: parsedRemote?.repository ?? null,
        transport: parsedRemote?.transport ?? null,
        url_redacted: true,
      },
      authentication: {
        verified: authenticationVerified,
        principal: authenticationVerified ? authenticatedPrincipal : null,
        secrets_observed: false,
      },
      principal_agreement: {
        verified: authenticationVerified
          && authenticatedPrincipal.toLowerCase() === expectedPrincipal.toLowerCase()
          && workerPrincipal.toLowerCase() === expectedPrincipal.toLowerCase(),
      },
      credential_helpers: {
        verified: helpersVerified,
        source: commandScopedCredentialHelper == null
          ? 'effective_git_config'
          : 'command_scoped_override',
        count: helperEvidence.length,
        helpers: helperEvidence,
      },
      identity: {
        author,
        committer,
      },
      remote_probe: probe,
    },
    remediation: {
      performed: commandScopedCredentialHelper != null,
      performed_kind: commandScopedCredentialHelper == null
        ? null
        : 'command_scoped_credential_helper_override',
      allowed: [
        'command_scoped_credential_helper_override',
        'repository_local_verified_github_noreply_identity',
      ],
      requires_explicit_task_authority: true,
    },
    redaction: {
      credential_values_emitted: false,
      email_values_emitted: false,
      subprocess_output_emitted: false,
    },
    findings,
  };
}
