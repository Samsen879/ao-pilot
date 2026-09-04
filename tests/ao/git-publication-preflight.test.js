import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';

import {
  parseGitHubRepository,
  resolveExecutableOnPath,
  runGitPublicationPreflight,
} from '../../scripts/ao/lib/git-publication-preflight.js';

const fixturePack = JSON.parse(fs.readFileSync(path.join(
  process.cwd(), 'tests/ao/fixtures/git-publication-preflight/pack.v1.json',
), 'utf8'));
const HEAD = '0918e609978553d944f6a6c4798c54691ae90775';

function result(status, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, error: null };
}

function fixtureRunner(fixture) {
  const calls = [];
  return {
    calls,
    run(command, args, options = {}) {
      calls.push({ command, args, options });
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation === 'git remote get-url --push origin') return result(0, `${fixture.remote_url}\n`);
      if (invocation === 'git config --get user.name') return result(0, `${fixture.name}\n`);
      if (invocation === 'git config --get user.email') return result(0, `${fixture.email}\n`);
      if (args[0] === 'log') {
        const outgoingEmail = fixture.outgoing_email ?? fixture.email;
        return result(0, `${HEAD}\x1f${fixture.name}\x1f${outgoingEmail}\x1f${fixture.name}\x1f${outgoingEmail}\n`);
      }
      if (invocation === 'git --exec-path') return result(0, '/git-core\n');
      if (invocation === 'git config --get-all credential.helper') {
        const helpers = fixture.generic_helpers ?? fixture.helpers;
        return helpers.length ? result(0, `${helpers.join('\n')}\n`) : result(1);
      }
      if (invocation === 'git config --get-urlmatch credential.helper https://github.com/Samsen879/ao-pilot') {
        const helpers = fixture.scoped_helpers ?? [];
        return helpers.length ? result(0, `${helpers.join('\n')}\n`) : result(1);
      }
      if (command === 'git' && args.includes('credential') && args.includes('fill')) {
        return fixture.credential_available === false
          ? result(1, '', 'ghp_forbidden')
          : result(0, 'protocol=https\nhost=github.com\nusername=worker\npassword=ghp_fixture_secret\n\n');
      }
      if (invocation === 'gh api user --jq .login') {
        return fixture.authenticated_principal == null
          ? result(1, '', 'ghp_forbidden')
          : result(0, `${fixture.authenticated_principal}\n`);
      }
      if (command === 'gh' && args[0] === 'api' && args[1] === 'repos/Samsen879/ao-pilot') {
        return fixture.push_permission === false
          ? result(0, '{"repository":"Samsen879/ao-pilot","push":false}\n')
          : result(0, '{"repository":"Samsen879/ao-pilot","push":true}\n');
      }
      if (command === 'ssh') {
        return fixture.authenticated_principal == null
          ? result(255, '', 'Permission denied')
          : result(1, '', `Hi ${fixture.authenticated_principal}! You've successfully authenticated, but GitHub does not provide shell access.\n`);
      }
      if (invocation === 'git rev-parse HEAD') return result(0, `${HEAD}\n`);
      if (command === 'git' && args.includes('push') && args.includes('--dry-run')) {
        return fixture.dry_run_fails ? result(1, '', 'denied') : result(0, 'Done\n');
      }
      throw new Error(`Unexpected fixture command: ${invocation}`);
    },
  };
}

function runFixture(fixture, runner = fixtureRunner(fixture)) {
  return {
    runner,
    receipt: runGitPublicationPreflight({
      cwd: '/governed/worktree',
      expectedRepository: 'Samsen879/ao-pilot',
      expectedPrincipal: 'Samsen879',
      workerPrincipal: 'Samsen879',
      commandScopedCredentialHelper: fixture.command_scoped_helper ?? null,
      runner,
      env: {},
      now: () => '2026-09-04T00:00:00.000Z',
      resolveExecutable: (executable) => fixture.available_executables.includes(executable),
    }),
  };
}

describe('diagnostic Git publication preflight', () => {
  it.each(fixturePack.fixtures)('$id', (fixture) => {
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.status).toBe(fixture.expected_status);
    expect(receipt.checks.remote_probe).toMatchObject({
      attempted: fixture.probe_attempted,
      kind: 'git_push_dry_run',
      remote_mutation: false,
    });
    expect(receipt.redaction).toEqual({
      credential_values_emitted: false,
      email_values_emitted: false,
      subprocess_output_emitted: false,
    });
    if (fixture.expected_finding == null) expect(receipt.findings).toEqual([]);
    else expect(receipt.findings.map(({ code }) => code)).toContain(fixture.expected_finding);

    for (const call of runner.calls.filter(({ args }) => args.includes('push'))) {
      expect(call.args).toContain('--dry-run');
      expect(call.args).toContain(fixture.remote_url);
      expect(call.args.some((arg) => arg.startsWith('HEAD:refs/heads/__ao_publication_preflight__/'))).toBe(true);
    }
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(fixture.email);
    expect(serialized).not.toContain('ghp_fixture_secret');
    expect(serialized).not.toContain('ghp_forbidden');
  });

  it('uses publication credentials for principal and permission checks without emitting them', () => {
    const fixture = fixturePack.fixtures[0];
    const { receipt, runner } = runFixture(fixture);
    const authCalls = runner.calls.filter(({ command }) => command === 'gh');

    expect(receipt.checks.authentication).toMatchObject({
      verified: true,
      source: 'publication_https_credential',
      publication_credential_verified: true,
    });
    expect(receipt.checks.repository_permission).toEqual({ verified: true, push: true });
    expect(authCalls).toHaveLength(2);
    expect(authCalls.every(({ options }) => options.env.GH_TOKEN === 'ghp_fixture_secret')).toBe(true);
  });

  it('blocks when the publication credential lacks repository push permission', () => {
    const fixture = { ...fixturePack.fixtures[0], push_permission: false };
    const { receipt } = runFixture(fixture);
    expect(receipt.status).toBe('blocked');
    expect(receipt.findings.map(({ code }) => code)).toContain('publication_write_permission_unverified');
    expect(receipt.checks.remote_probe.attempted).toBe(false);
  });

  it('uses SSH identity and skips irrelevant credential-helper inspection', () => {
    const fixture = fixturePack.fixtures.find(({ id }) => id === 'ssh_publication');
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.checks.credential_helpers).toMatchObject({
      applicable: false,
      verified: true,
      source: 'not_applicable_ssh',
      count: 0,
    });
    expect(receipt.checks.authentication.source).toBe('publication_ssh_credential');
    expect(runner.calls.some(({ args }) => args.includes('credential.helper'))).toBe(false);
  });

  it('collects generic and URL-scoped helper chains with reset semantics', () => {
    const fixture = {
      ...fixturePack.fixtures[0],
      generic_helpers: ['store'],
      scoped_helpers: ['cache'],
      available_executables: ['git-credential-store', 'git-credential-cache'],
    };
    const { receipt } = runFixture(fixture);
    expect(receipt.checks.credential_helpers).toMatchObject({ verified: true, count: 2 });
  });

  it('finds Git helper subcommands in the Git exec path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-git-exec-path-'));
    const executable = path.join(root, 'git-credential-example');
    try {
      fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
      expect(resolveExecutableOnPath('git-credential-example', {
        env: { PATH: '' },
        extraDirectories: [root],
      })).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks an incompatible identity already embedded in an outgoing commit', () => {
    const fixture = { ...fixturePack.fixtures[0], outgoing_email: 'private@example.test' };
    const { receipt } = runFixture(fixture);
    expect(receipt.status).toBe('blocked');
    expect(receipt.findings.map(({ code }) => code)).toContain('outgoing_commit_identity_privacy_incompatible');
    expect(receipt.checks.outgoing_commits).toMatchObject({
      verified: false,
      author_incompatible_count: 1,
      committer_incompatible_count: 1,
      values_redacted: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('private@example.test');
  });

  it('does not claim command-scoped remediation when earlier checks prevent its use', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'command_scoped_remediation'),
      email: 'private@example.test',
    };
    const { receipt } = runFixture(fixture);
    expect(receipt.remediation).toMatchObject({ performed: false, performed_kind: null });
  });

  it('isolates the dry-run helper and suppresses credential store/erase', () => {
    const fixture = fixturePack.fixtures[0];
    const { receipt, runner } = runFixture(fixture);
    const probe = runner.calls.find(({ args }) => args.includes('push'));
    expect(receipt.checks.remote_probe).toMatchObject({
      credential_store_suppressed: true,
      write_permission_verified: true,
    });
    expect(probe.args).toContain('credential.helper=');
    expect(probe.args.some((arg) => arg.includes('git-credential-readonly.js'))).toBe(true);
    expect(probe.options.env).toMatchObject({
      AO_GIT_PUBLICATION_CREDENTIAL_PASSWORD: 'ghp_fixture_secret',
    });

    const helper = path.join(process.cwd(), 'scripts/ao/git-credential-readonly.js');
    const base = { env: { ...process.env, AO_GIT_PUBLICATION_CREDENTIAL_USERNAME: 'u', AO_GIT_PUBLICATION_CREDENTIAL_PASSWORD: 'p' }, encoding: 'utf8' };
    expect(spawnSync(process.execPath, [helper, 'store'], base).stdout).toBe('');
    expect(spawnSync(process.execPath, [helper, 'erase'], base).stdout).toBe('');
    expect(spawnSync(process.execPath, [helper, 'get'], base).stdout).toBe('username=u\npassword=p\n');
  });

  it('redacts credential-bearing remote URLs and private provider diagnostics', () => {
    const fixture = { ...fixturePack.fixtures[0], remote_url: 'https://oauth2:ghp_remote_secret@github.com/Samsen879/ao-pilot.git' };
    const { receipt } = runFixture(fixture);
    const serialized = JSON.stringify(receipt);
    expect(receipt.status).toBe('blocked');
    expect(serialized).not.toContain('ghp_remote_secret');
  });

  it('parses only canonical credential-free GitHub transports', () => {
    expect(parseGitHubRepository('https://github.com/Samsen879/ao-pilot.git')).toEqual({ repository: 'Samsen879/ao-pilot', transport: 'https' });
    expect(parseGitHubRepository('git@github.com:Samsen879/ao-pilot.git')).toEqual({ repository: 'Samsen879/ao-pilot', transport: 'ssh' });
    expect(parseGitHubRepository('other@github.com:Samsen879/ao-pilot.git')).toBeNull();
    expect(parseGitHubRepository('https://token@github.com/Samsen879/ao-pilot.git')).toBeNull();
  });
});
