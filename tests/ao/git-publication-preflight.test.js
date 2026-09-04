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
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function result(status, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, error: null };
}

function fixtureRunner(fixture) {
  const calls = [];
  let headRead = 0;
  return {
    calls,
    run(command, args, options = {}) {
      calls.push({ command, args, options });
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation === 'git remote get-url --push --all origin') {
        return result(0, `${(fixture.remote_urls ?? [fixture.remote_url]).join('\n')}\n`);
      }
      if (invocation === 'git config --get user.name') return result(0, `${fixture.name}\n`);
      if (invocation === 'git config --get user.email') {
        return fixture.config_email_missing ? result(1) : result(0, `${fixture.email}\n`);
      }
      if (args.includes('rev-list')) return result(0, `${HEAD}\n${BASE}\n`);
      if (args.includes('log')) {
        const outgoingEmail = fixture.outgoing_email ?? fixture.email;
        return result(0, `${HEAD}\x1f${fixture.name}\x1f${outgoingEmail}\x1f${fixture.name}\x1f${outgoingEmail}\n`);
      }
      if (invocation === 'git --exec-path') return result(0, '/git-core\n');
      if (invocation === "git config --null --get-regexp ^credential(\\..*)?\\.helper$") {
        const entries = fixture.config_helpers ?? [
          ...(fixture.generic_helpers ?? fixture.helpers).map((value) => ['credential.helper', value]),
          ...(fixture.scoped_helpers ?? []).map((value) => [
            'credential.https://github.com/Samsen879/ao-pilot.git.helper', value,
          ]),
        ];
        return entries.length
          ? result(0, entries.map(([key, value]) => `${key}\n${value}\0`).join(''))
          : result(1);
      }
      if (invocation === 'git config --get core.sshCommand') {
        return fixture.ssh_command ? result(0, `${fixture.ssh_command}\n`) : result(1);
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
      if (command === 'sh' && args[0] === '-c') {
        return fixture.authenticated_principal == null
          ? result(255, '', 'Permission denied')
          : result(1, '', `Hi ${fixture.authenticated_principal}! You've successfully authenticated, but GitHub does not provide shell access.\n`);
      }
      if (command === 'sh' && args[0] === '-n') return result(fixture.shell_syntax_invalid ? 2 : 0);
      if (command === 'git' && args.includes('ls-remote')) {
        return fixture.refs_unreadable ? result(1, '', 'denied') : result(0, `${BASE}\trefs/heads/main\n`);
      }
      if (invocation === 'git rev-parse HEAD') {
        const oid = fixture.head_sequence?.[headRead] ?? HEAD;
        headRead += 1;
        return result(0, `${oid}\n`);
      }
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
      env: fixture.env ?? {},
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
      expect(call.args).toContain(`${HEAD}:refs/heads/__ao_publication_preflight__/${HEAD}`);
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
    const identity = runner.calls.find(({ command }) => command === 'ssh');
    expect(identity.options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    });
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

  it('collects every matching URL-scoped helper against the exact push URL', () => {
    const fixture = {
      ...fixturePack.fixtures[0],
      config_helpers: [
        ['credential.helper', 'store'],
        ['credential.https://github.com.helper', 'cache'],
        ['credential.https://github.com/Samsen879/ao-pilot.git.helper', '!f() { printf fixture; }; f'],
        ['credential.https://gist.github.com.helper', 'ignored'],
      ],
      available_executables: ['git-credential-store', 'git-credential-cache'],
    };
    const { receipt } = runFixture(fixture);
    expect(receipt.checks.credential_helpers).toMatchObject({ verified: true, count: 3 });
    expect(receipt.checks.credential_helpers.helpers.at(-1)).toMatchObject({
      kind: 'shell_snippet', validation: 'shell_syntax_and_credential_fill', available: true,
    });
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
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
    });
    expect(probe.args).toContain('core.askPass=');

    const fill = runner.calls.find(({ args }) => args.includes('credential') && args.includes('fill'));
    expect(fill.args).toContain('core.askPass=');
    expect(fill.options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_ASKPASS: '', SSH_ASKPASS: '',
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
    expect(parseGitHubRepository('http://github.com/Samsen879/ao-pilot.git')).toBeNull();
  });

  it('blocks plaintext HTTP before credential acquisition', () => {
    const fixture = { ...fixturePack.fixtures[0], remote_url: 'http://github.com/Samsen879/ao-pilot.git' };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('publication_remote_unverified');
    expect(runner.calls.some(({ args }) => args.includes('fill'))).toBe(false);
  });

  it('blocks multiple push URLs without probing or exposing their values', () => {
    const fixture = {
      ...fixturePack.fixtures[0],
      remote_urls: [fixturePack.fixtures[0].remote_url, 'https://github.com/Samsen879/second.git'],
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('multiple_publication_push_urls');
    expect(receipt.checks.remote.push_url_count).toBe(2);
    expect(runner.calls.some(({ args }) => args.includes('push'))).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('second.git');
  });

  it('binds the outgoing range to actual publication refs with large-output buffers', () => {
    const fixture = fixturePack.fixtures[0];
    const { runner } = runFixture(fixture);
    const refs = runner.calls.find(({ args }) => args.includes('ls-remote'));
    const revList = runner.calls.find(({ args }) => args.includes('rev-list'));
    const log = runner.calls.find(({ args }) => args.includes('log'));
    expect(refs.args).toContain(fixture.remote_url);
    expect(log.args).toEqual(expect.arrayContaining(['--not', BASE]));
    expect(log.args.some((arg) => arg.startsWith('--remotes='))).toBe(false);
    expect(revList.args[0]).toBe('--no-replace-objects');
    expect(log.args[0]).toBe('--no-replace-objects');
    expect(log.args).toContain(HEAD);
    expect(revList.options.maxBuffer).toBe(64 * 1024 * 1024);
    expect(log.options.maxBuffer).toBe(64 * 1024 * 1024);
  });

  it('honors a custom SSH command while enforcing strict existing-host verification', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: 'ssh -i /fixture/key',
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.status).toBe('passed');
    const auth = runner.calls.find(({ command }) => command === 'sh');
    expect(auth.args[1]).toContain('-i /fixture/key');
    expect(auth.args[1]).toContain('StrictHostKeyChecking=yes');
    expect(auth.args[1]).toContain('UpdateHostKeys=no');
    expect(auth.args[1].indexOf('StrictHostKeyChecking=yes')).toBeLessThan(auth.args[1].indexOf('-i /fixture/key'));
    expect(auth.options.env).toMatchObject({ GIT_ASKPASS: '', SSH_ASKPASS: '' });
    const remoteReads = runner.calls.filter(({ args }) => args.includes('ls-remote') || args.includes('push'));
    expect(remoteReads.every(({ options }) => options.env.GIT_SSH_COMMAND.includes('-i /fixture/key'))).toBe(true);
    expect(remoteReads.every(({ options }) => options.env.GIT_SSH_COMMAND.includes('StrictHostKeyChecking=yes'))).toBe(true);
    expect(remoteReads.every(({ options }) => options.env.GIT_SSH_COMMAND.includes('UpdateHostKeys=no'))).toBe(true);
  });

  it('gives the environment SSH command precedence over repository configuration', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: 'ssh -i /fixture/config-key',
      env: { GIT_SSH_COMMAND: 'ssh -i /fixture/environment-key' },
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.status).toBe('passed');
    const auth = runner.calls.find(({ command }) => command === 'sh');
    expect(auth.args[1]).toContain('/fixture/environment-key');
    expect(auth.args[1]).not.toContain('/fixture/config-key');
  });

  it('fails closed when a custom SSH command supplies an ambiguous host-key policy', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: 'ssh -o StrictHostKeyChecking=no',
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('ssh_host_key_policy_ambiguous');
    expect(runner.calls.some(({ command }) => command === 'sh')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('StrictHostKeyChecking=no');
  });

  it('fails closed on a shell-obfuscated SSH host-key policy', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: "ssh -o StrictHostKeyCheck'ing=no'",
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('ssh_host_key_policy_ambiguous');
    expect(runner.calls.some(({ command, args }) => command === 'sh' && args[0] === '-c')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('StrictHostKeyCheck');
  });

  it('fails closed when a configured SSH command disables batch mode', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: 'ssh -oBatchMode=no',
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('ssh_host_key_policy_ambiguous');
    expect(runner.calls.some(({ command }) => command === 'sh')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('BatchMode=no');
  });

  it('honors GIT_SSH when higher-precedence SSH controls are absent', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      env: { GIT_SSH: '/usr/bin/ssh' },
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.status).toBe('passed');
    const auth = runner.calls.find(({ command }) => command === 'sh');
    expect(auth.args[1]).toContain('/usr/bin/ssh');
  });

  it('fails closed when configured SSH enables automatic host-key updates', () => {
    const fixture = {
      ...fixturePack.fixtures.find(({ id }) => id === 'ssh_publication'),
      ssh_command: 'ssh -oUpdateHostKeys=yes',
    };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('ssh_host_key_policy_ambiguous');
    expect(runner.calls.some(({ command }) => command === 'sh')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain('UpdateHostKeys=yes');
  });

  it('redacts a mismatched canonical publication repository', () => {
    const fixture = fixturePack.fixtures.find(({ id }) => id === 'repository_mismatch');
    const { receipt } = runFixture(fixture);
    expect(receipt.checks.remote.repository).toBeNull();
    expect(receipt.findings.find(({ code }) => code === 'publication_repository_mismatch').evidence)
      .toEqual({ remote_name: 'origin', value_redacted: true });
    expect(JSON.stringify(receipt)).not.toContain('different-repository');
  });

  it('uses EMAIL after an absent role-specific and configured email', () => {
    const fixture = {
      ...fixturePack.fixtures[0],
      config_email_missing: true,
      env: { EMAIL: fixturePack.fixtures[0].email },
    };
    const { receipt } = runFixture(fixture);
    expect(receipt.status).toBe('passed');
    expect(receipt.checks.configured_identity.author.email.privacy_compatible).toBe(true);
    expect(receipt.checks.configured_identity.committer.email.privacy_compatible).toBe(true);
  });

  it('pins one candidate OID and blocks HEAD drift before probing', () => {
    const moved = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fixture = { ...fixturePack.fixtures[0], head_sequence: [HEAD, moved] };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('candidate_head_drift');
    expect(runner.calls.some(({ args }) => args.includes('push'))).toBe(false);
    const log = runner.calls.find(({ args }) => args.includes('log'));
    expect(log.args).toContain(HEAD);
    expect(log.args).not.toContain(moved);
  });

  it('blocks when HEAD drifts during the pinned-OID dry-run', () => {
    const moved = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const fixture = { ...fixturePack.fixtures[0], head_sequence: [HEAD, HEAD, moved] };
    const { receipt, runner } = runFixture(fixture);
    expect(receipt.findings.map(({ code }) => code)).toContain('candidate_head_drift');
    expect(receipt.checks.remote_probe.status).toBe('blocked');
    const probe = runner.calls.find(({ args }) => args.includes('push'));
    expect(probe.args).toContain(`${HEAD}:refs/heads/__ao_publication_preflight__/${HEAD}`);
  });
});
