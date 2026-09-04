import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCAL_COMMAND_RUNNER } from './providers/command-runner.js';

export const GIT_PUBLICATION_PREFLIGHT_SCHEMA_VERSION = 'ao.git-publication-preflight.v1';
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
const READONLY_HELPER_PATH = fileURLToPath(new URL('../git-credential-readonly.js', import.meta.url));

function cleanLine(value) {
  return String(value ?? '').trim().split(/\r?\n/, 1)[0].trim();
}

function successful(result) {
  return result?.status === 0 && result?.signal == null && result?.error == null;
}

function run(runner, command, args, cwd, options = {}) {
  return runner.run(command, args, {
    cwd,
    ...options,
    env: { ...(options.env ?? {}) },
  });
}

function firstCommandToken(value) {
  const match = value.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function helperExecutable(helper) {
  const trimmed = helper.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('!')) return firstCommandToken(trimmed.slice(1));
  const token = firstCommandToken(trimmed);
  if (token == null) return null;
  return token.includes('/') || token.includes('\\') ? token : `git-credential-${token}`;
}

export function resolveExecutableOnPath(executable, {
  env = process.env,
  access = fs.accessSync,
  extraDirectories = [],
} = {}) {
  if (typeof executable !== 'string' || executable.trim() === '') return false;
  const candidate = executable.trim();
  const candidates = path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')
    ? [candidate]
    : [
        ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean),
        ...extraDirectories.filter(Boolean),
      ].map((directory) => path.join(directory, candidate));
  return candidates.some((resolved) => {
    try {
      access(resolved, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function inspectHelper(helper, resolveExecutable, gitExecPath) {
  const executable = helperExecutable(helper);
  return {
    kind: helper.trim().startsWith('!') ? 'shell_command' : 'git_credential_helper',
    executable_shape: executable == null
      ? 'missing'
      : path.isAbsolute(executable) ? 'absolute_path' : 'path_lookup',
    available: executable != null && resolveExecutable(executable, { gitExecPath }),
    value_redacted: true,
  };
}

export function parseGitHubRepository(remoteUrl) {
  const value = cleanLine(remoteUrl);
  let match = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (match) {
    const repository = `${match[1]}/${match[2]}`;
    return REPOSITORY_PATTERN.test(repository) ? { repository, transport: 'https' } : null;
  }
  match = value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  if (match) {
    const repository = `${match[1]}/${match[2]}`;
    return REPOSITORY_PATTERN.test(repository) ? { repository, transport: 'ssh' } : null;
  }
  return null;
}

function classifyEmail(email, principal) {
  const normalized = cleanLine(email).toLowerCase();
  const login = principal.toLowerCase();
  if (normalized === '') return { present: false, shape: 'missing', privacy_compatible: false };
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) {
    return { present: true, shape: 'invalid', privacy_compatible: false };
  }
  const escapedLogin = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compatible = normalized === `${login}@users.noreply.github.com`
    || new RegExp(`^[0-9]+\\+${escapedLogin}@users\\.noreply\\.github\\.com$`, 'i')
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

function configuredIdentity({ runner, cwd, env, principal, role }) {
  const prefix = role === 'author' ? 'GIT_AUTHOR' : 'GIT_COMMITTER';
  const name = env[`${prefix}_NAME`] ?? configValue(runner, cwd, 'user.name');
  const email = env[`${prefix}_EMAIL`] ?? configValue(runner, cwd, 'user.email');
  return {
    name_present: cleanLine(name) !== '',
    email: classifyEmail(email, principal),
    values_redacted: true,
  };
}

function finding(code, summary, evidence = {}) {
  return { code, severity: 'blocker', summary, evidence };
}

function configLines(result) {
  if (result?.status === 1 && result?.signal == null && result?.error == null) return [];
  if (!successful(result)) return null;
  const values = String(result.stdout ?? '').split(/\r?\n/);
  if (values.at(-1) === '') values.pop();
  return values;
}

function applyHelperResets(values) {
  return values.reduce((effective, value) => {
    const helper = value.trim();
    if (helper === '') return [];
    effective.push(helper);
    return effective;
  }, []);
}

function readConfiguredHelpers(runner, cwd, expectedRepository) {
  const generic = configLines(run(
    runner, 'git', ['config', '--get-all', 'credential.helper'], cwd,
  ));
  const scoped = configLines(run(runner, 'git', [
    'config', '--get-urlmatch', 'credential.helper', `https://github.com/${expectedRepository}`,
  ], cwd));
  if (generic == null || scoped == null) return null;
  return applyHelperResets([...generic, ...scoped]);
}

function parseCredentialOutput(output) {
  const values = {};
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (cleanLine(values.username) === '' || cleanLine(values.password) === '') return null;
  return { username: values.username, password: values.password };
}

function outgoingCommitIdentities(runner, cwd, remote, principal) {
  const result = run(runner, 'git', [
    'log', '--format=%H%x1f%an%x1f%ae%x1f%cn%x1f%ce', 'HEAD', '--not', `--remotes=${remote}`,
  ], cwd);
  if (!successful(result)) return null;
  const records = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean);
  let authorIncompatible = 0;
  let committerIncompatible = 0;
  let malformed = 0;
  for (const record of records) {
    const [oid, authorName, authorEmail, committerName, committerEmail, ...extra] = record.split('\x1f');
    if (!OID_PATTERN.test(oid ?? '') || !cleanLine(authorName) || !cleanLine(committerName) || extra.length) {
      malformed += 1;
      continue;
    }
    if (!classifyEmail(authorEmail, principal).privacy_compatible) authorIncompatible += 1;
    if (!classifyEmail(committerEmail, principal).privacy_compatible) committerIncompatible += 1;
  }
  return {
    verified: authorIncompatible === 0 && committerIncompatible === 0 && malformed === 0,
    count: records.length,
    author_incompatible_count: authorIncompatible,
    committer_incompatible_count: committerIncompatible,
    malformed_count: malformed,
    values_redacted: true,
  };
}

function validateInput({ expectedRepository, expectedPrincipal, workerPrincipal, remote }) {
  if (!REPOSITORY_PATTERN.test(expectedRepository ?? '')) {
    throw new GitPublicationPreflightUsageError('Expected repository must use owner/name form');
  }
  for (const [label, value] of [['Expected principal', expectedPrincipal], ['Worker principal', workerPrincipal]]) {
    if (!PRINCIPAL_PATTERN.test(value ?? '')) {
      throw new GitPublicationPreflightUsageError(`${label} is required and must be a GitHub login`);
    }
  }
  if (!REMOTE_PATTERN.test(remote ?? '')) {
    throw new GitPublicationPreflightUsageError('Remote name is invalid');
  }
}

function helperArgs(helper) {
  return helper == null ? [] : ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`];
}

function parseJson(result) {
  if (!successful(result)) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function sshPrincipal(runner, cwd) {
  const result = run(runner, 'ssh', [
    '-o', 'BatchMode=yes',
    '-o', `UserKnownHostsFile=${os.devNull}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-T', 'git@github.com',
  ], cwd);
  const match = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
    .match(/Hi ([A-Za-z0-9-]+)! You've successfully authenticated/i);
  return match?.[1] ?? '';
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
  resolveExecutable,
} = {}) {
  validateInput({ expectedRepository, expectedPrincipal, workerPrincipal, remote });
  if (commandScopedCredentialHelper != null && (
    typeof commandScopedCredentialHelper !== 'string'
      || commandScopedCredentialHelper.trim() === ''
      || /[\r\n\0]/.test(commandScopedCredentialHelper)
  )) {
    throw new GitPublicationPreflightUsageError('Command-scoped credential helper is invalid');
  }

  const findings = [];
  const remoteResult = run(runner, 'git', ['remote', 'get-url', '--push', remote], cwd);
  const pushUrl = successful(remoteResult) ? cleanLine(remoteResult.stdout) : '';
  const parsedRemote = parseGitHubRepository(pushUrl);
  const repositoryMatches = parsedRemote?.repository.toLowerCase() === expectedRepository.toLowerCase();
  if (parsedRemote == null) {
    findings.push(finding('publication_remote_unverified', 'The publication remote is not a canonical GitHub transport.', { remote_name: remote }));
  } else if (!repositoryMatches) {
    findings.push(finding('publication_repository_mismatch', 'The publication remote does not match the admitted repository.', {
      remote_name: remote,
      observed_repository: parsedRemote.repository,
    }));
  }

  const author = configuredIdentity({ runner, cwd, env, principal: expectedPrincipal, role: 'author' });
  const committer = configuredIdentity({ runner, cwd, env, principal: expectedPrincipal, role: 'committer' });
  for (const [role, identity] of [['author', author], ['committer', committer]]) {
    if (!identity.name_present) findings.push(finding(`git_${role}_name_missing`, `The effective Git ${role} name is missing.`));
    if (!identity.email.privacy_compatible) {
      findings.push(finding(`git_${role}_email_privacy_incompatible`, `The effective Git ${role} email is not a GitHub noreply form for the admitted principal.`, {
        email_shape: identity.email.shape,
        value_redacted: true,
      }));
    }
  }

  const outgoing = outgoingCommitIdentities(runner, cwd, remote, expectedPrincipal);
  if (outgoing == null) {
    findings.push(finding('outgoing_commit_identity_unreadable', 'Outgoing commit identities could not be inspected.'));
  } else if (!outgoing.verified) {
    findings.push(finding('outgoing_commit_identity_privacy_incompatible', 'At least one outgoing commit has an incompatible or malformed identity.', {
      commit_count: outgoing.count,
      author_incompatible_count: outgoing.author_incompatible_count,
      committer_incompatible_count: outgoing.committer_incompatible_count,
      malformed_count: outgoing.malformed_count,
      values_redacted: true,
    }));
  }

  const execPathResult = run(runner, 'git', ['--exec-path'], cwd);
  const gitExecPath = successful(execPathResult) ? cleanLine(execPathResult.stdout) : '';
  const executableResolver = resolveExecutable ?? ((executable) => resolveExecutableOnPath(executable, {
    env,
    extraDirectories: [gitExecPath],
  }));
  const helpersApplicable = parsedRemote?.transport === 'https';
  const configuredHelpers = helpersApplicable ? readConfiguredHelpers(runner, cwd, expectedRepository) : [];
  const effectiveHelpers = commandScopedCredentialHelper == null ? configuredHelpers : [commandScopedCredentialHelper];
  const helperEvidence = effectiveHelpers == null ? [] : effectiveHelpers.map(
    (helper) => inspectHelper(helper, executableResolver, gitExecPath),
  );
  const helpersVerified = !helpersApplicable || (
    effectiveHelpers != null && helperEvidence.length > 0 && helperEvidence.every(({ available }) => available)
  );
  if (!helpersVerified) {
    const code = effectiveHelpers == null
      ? 'credential_helper_config_unreadable'
      : helperEvidence.length === 0 ? 'credential_helper_missing' : 'credential_helper_executable_missing';
    findings.push(finding(code, 'The effective credential-helper chain cannot be verified as executable.', {
      helper_count: helperEvidence.length,
    }));
  }

  const prerequisitesVerified = repositoryMatches
    && author.name_present && author.email.privacy_compatible
    && committer.name_present && committer.email.privacy_compatible
    && outgoing?.verified === true && helpersVerified;
  let authenticatedPrincipal = '';
  let authenticationSource = null;
  let repositoryPermissionVerified = false;
  let publicationCredentialVerified = false;
  let overrideApplied = false;
  let credential = null;

  if (prerequisitesVerified && parsedRemote.transport === 'https') {
    overrideApplied = commandScopedCredentialHelper != null;
    const credentialResult = run(runner, 'git', [
      '-c', 'credential.interactive=never',
      ...helperArgs(commandScopedCredentialHelper),
      'credential', 'fill',
    ], cwd, {
      env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      input: `url=${pushUrl}\n\n`,
    });
    credential = successful(credentialResult) ? parseCredentialOutput(credentialResult.stdout) : null;
    publicationCredentialVerified = credential != null;
    if (!publicationCredentialVerified) {
      findings.push(finding('publication_credential_unavailable', 'The publication credential could not be obtained non-interactively.'));
    } else {
      const authEnv = {
        GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1', GH_TOKEN: credential.password, GITHUB_TOKEN: '',
      };
      const authResult = run(runner, 'gh', ['api', 'user', '--jq', '.login'], cwd, { env: authEnv });
      authenticatedPrincipal = successful(authResult) ? cleanLine(authResult.stdout) : '';
      authenticationSource = 'publication_https_credential';
      const permission = parseJson(run(runner, 'gh', [
        'api', `repos/${expectedRepository}`, '--jq', '{repository: .full_name, push: .permissions.push}',
      ], cwd, { env: authEnv }));
      repositoryPermissionVerified = permission?.repository?.toLowerCase() === expectedRepository.toLowerCase()
        && permission?.push === true;
      if (!repositoryPermissionVerified) {
        findings.push(finding('publication_write_permission_unverified', 'The publication credential does not establish push permission for the admitted repository.'));
      }
    }
  } else if (prerequisitesVerified && parsedRemote.transport === 'ssh') {
    authenticatedPrincipal = sshPrincipal(runner, cwd);
    authenticationSource = 'publication_ssh_credential';
    publicationCredentialVerified = PRINCIPAL_PATTERN.test(authenticatedPrincipal);
    if (!publicationCredentialVerified) {
      findings.push(finding('publication_ssh_identity_unverified', 'The GitHub principal for the SSH publication credential could not be verified.'));
    }
  }

  const authenticationVerified = PRINCIPAL_PATTERN.test(authenticatedPrincipal);
  if (prerequisitesVerified && !authenticationVerified) {
    findings.push(finding('github_authentication_unavailable', 'The publication credential principal could not be verified non-interactively.'));
  } else if (authenticationVerified && authenticatedPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
    findings.push(finding('github_principal_mismatch', 'The publication credential principal does not match the admitted principal.', {
      observed_principal: authenticatedPrincipal,
    }));
  }
  if (workerPrincipal.toLowerCase() !== expectedPrincipal.toLowerCase()) {
    findings.push(finding('worker_principal_mismatch', 'The Worker and Orchestrator publication principals do not agree.', {
      worker_principal: workerPrincipal,
    }));
  }

  const principalAgreement = authenticationVerified
    && authenticatedPrincipal.toLowerCase() === expectedPrincipal.toLowerCase()
    && workerPrincipal.toLowerCase() === expectedPrincipal.toLowerCase();
  const eligibleForProbe = prerequisitesVerified && publicationCredentialVerified && principalAgreement
    && (parsedRemote.transport === 'ssh' || repositoryPermissionVerified);
  let probe = {
    attempted: false,
    status: 'skipped_blocked',
    kind: 'git_push_dry_run',
    push_url_targeted: false,
    write_permission_verified: false,
    credential_store_suppressed: false,
    remote_mutation: false,
  };
  if (eligibleForProbe) {
    const headResult = run(runner, 'git', ['rev-parse', 'HEAD'], cwd);
    const headOid = successful(headResult) ? cleanLine(headResult.stdout) : '';
    if (!OID_PATTERN.test(headOid)) {
      findings.push(finding('candidate_head_unverified', 'The candidate HEAD could not be verified.'));
    } else {
      const isolatedHelper = `!${shellQuote(process.execPath)} ${shellQuote(READONLY_HELPER_PATH)}`;
      const isolatedHelperArgs = parsedRemote.transport === 'https'
        ? ['-c', 'credential.helper=', '-c', `credential.helper=${isolatedHelper}`]
        : [];
      const probeEnv = parsedRemote.transport === 'https'
        ? {
            AO_GIT_PUBLICATION_CREDENTIAL_USERNAME: credential.username,
            AO_GIT_PUBLICATION_CREDENTIAL_PASSWORD: credential.password,
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'Never',
          }
        : {
            GIT_TERMINAL_PROMPT: '0',
            GIT_SSH_COMMAND: `ssh -o BatchMode=yes -o UserKnownHostsFile=${os.devNull} -o StrictHostKeyChecking=accept-new`,
          };
      const probeResult = run(runner, 'git', [
        '-c', 'credential.interactive=never',
        '-c', `core.hooksPath=${os.devNull}`,
        ...isolatedHelperArgs,
        'push', '--dry-run', '--porcelain', pushUrl,
        `HEAD:refs/heads/__ao_publication_preflight__/${headOid}`,
      ], cwd, { env: probeEnv });
      const probePassed = successful(probeResult);
      repositoryPermissionVerified ||= parsedRemote.transport === 'ssh' && probePassed;
      probe = {
        attempted: true,
        status: probePassed ? 'passed' : 'blocked',
        kind: 'git_push_dry_run',
        push_url_targeted: true,
        write_permission_verified: probePassed && repositoryPermissionVerified,
        credential_store_suppressed: parsedRemote.transport === 'https',
        remote_mutation: false,
      };
      if (!probePassed) findings.push(finding('publication_dry_run_failed', 'The non-interactive dry-run publication probe failed.'));
    }
  }

  if (credential != null) {
    credential.username = '';
    credential.password = '';
  }
  const status = findings.length === 0 ? 'passed' : 'blocked';
  return {
    schema_version: GIT_PUBLICATION_PREFLIGHT_SCHEMA_VERSION,
    generated_at: now(),
    status,
    risk: {
      tier: 'R2',
      boundary: 'diagnostic_git_publication_preflight',
      forbidden_mutations: ['global_git_configuration', 'credential_provisioning', 'account_switching', 'remote_probe_mutation'],
    },
    scope: { expected_repository: expectedRepository, expected_principal: expectedPrincipal, worker_principal: workerPrincipal, remote_name: remote },
    checks: {
      remote: {
        verified: repositoryMatches,
        repository: parsedRemote?.repository ?? null,
        transport: parsedRemote?.transport ?? null,
        push_url_redacted: true,
      },
      authentication: {
        verified: authenticationVerified,
        principal: authenticationVerified ? authenticatedPrincipal : null,
        source: authenticationSource,
        publication_credential_verified: publicationCredentialVerified,
        secrets_observed_but_not_emitted: parsedRemote?.transport === 'https' && publicationCredentialVerified,
      },
      principal_agreement: { verified: principalAgreement },
      repository_permission: { verified: repositoryPermissionVerified, push: repositoryPermissionVerified },
      credential_helpers: {
        applicable: helpersApplicable,
        verified: helpersVerified,
        source: !helpersApplicable ? 'not_applicable_ssh'
          : commandScopedCredentialHelper == null ? 'effective_git_config' : 'command_scoped_override',
        count: helperEvidence.length,
        git_exec_path_considered: gitExecPath !== '',
        helpers: helperEvidence,
      },
      configured_identity: { author, committer },
      outgoing_commits: outgoing ?? { verified: false, count: null, values_redacted: true },
      remote_probe: probe,
    },
    remediation: {
      performed: overrideApplied,
      performed_kind: overrideApplied ? 'command_scoped_credential_helper_override' : null,
      allowed: ['command_scoped_credential_helper_override', 'repository_local_verified_github_noreply_identity'],
      requires_explicit_task_authority: true,
    },
    redaction: { credential_values_emitted: false, email_values_emitted: false, subprocess_output_emitted: false },
    findings,
  };
}
