import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  parseGitHubRepository,
  runGitPublicationPreflight,
} from '../../scripts/ao/lib/git-publication-preflight.js';

const fixturePack = JSON.parse(fs.readFileSync(path.join(
  process.cwd(),
  'tests/ao/fixtures/git-publication-preflight/pack.v1.json',
), 'utf8'));

function processResult(status, stdout = '', stderr = '') {
  return { status, signal: null, stdout, stderr, error: null };
}

function fixtureRunner(fixture) {
  const calls = [];
  return {
    calls,
    run(command, args, options) {
      calls.push({ command, args, options });
      if (command === 'git' && args.join(' ') === 'remote get-url --push origin') {
        return processResult(0, `${fixture.remote_url}\n`);
      }
      if (command === 'gh' && args.join(' ') === 'api user --jq .login') {
        return fixture.authenticated_principal == null
          ? processResult(1, '', 'token ghp_forbidden must never escape')
          : processResult(0, `${fixture.authenticated_principal}\n`);
      }
      if (command === 'git' && args.join(' ') === 'config --get-urlmatch credential.helper https://github.com/Samsen879/ao-pilot') {
        return fixture.helpers.length === 0
          ? processResult(1)
          : processResult(0, `${fixture.helpers.join('\n')}\n`);
      }
      if (command === 'git' && args.join(' ') === 'config --get user.name') {
        return processResult(0, `${fixture.name}\n`);
      }
      if (command === 'git' && args.join(' ') === 'config --get user.email') {
        return processResult(0, `${fixture.email}\n`);
      }
      if (command === 'git' && args.includes('ls-remote')) {
        return processResult(0, 'ba3a94099c2052bec7388c6b7c76bfa2162fa7d8\tHEAD\n');
      }
      throw new Error(`Unexpected command in fixture: ${command}`);
    },
  };
}

describe('diagnostic Git publication preflight', () => {
  it.each(fixturePack.fixtures)('$id', (fixture) => {
    const runner = fixtureRunner(fixture);
    const receipt = runGitPublicationPreflight({
      cwd: '/governed/worktree',
      expectedRepository: 'Samsen879/ao-pilot',
      expectedPrincipal: 'Samsen879',
      workerPrincipal: 'Samsen879',
      commandScopedCredentialHelper: fixture.command_scoped_helper ?? null,
      runner,
      env: {},
      now: () => '2026-09-04T00:00:00.000Z',
      resolveExecutable: (executable) => fixture.available_executables.includes(executable),
    });

    expect(receipt.status).toBe(fixture.expected_status);
    expect(receipt.risk).toMatchObject({
      tier: 'R2',
      boundary: 'diagnostic_git_publication_preflight',
    });
    expect(receipt.checks.remote_probe).toMatchObject({
      attempted: fixture.probe_attempted,
      remote_mutation: false,
    });
    expect(receipt.redaction).toEqual({
      credential_values_emitted: false,
      email_values_emitted: false,
      subprocess_output_emitted: false,
    });
    if (fixture.expected_finding == null) {
      expect(receipt.findings).toEqual([]);
    } else {
      expect(receipt.findings.map(({ code }) => code)).toContain(fixture.expected_finding);
    }

    for (const { command, args } of runner.calls) {
      expect(['git', 'gh']).toContain(command);
      expect(args).not.toContain('push');
      expect(args).not.toContain('send-pack');
      expect(args).not.toContain('receive-pack');
      expect(args).not.toContain('create');
      expect(args).not.toContain('merge');
      expect(args).not.toContain('--method');
      if (command === 'gh') {
        expect(args).toEqual(['api', 'user', '--jq', '.login']);
      }
    }
    for (const call of runner.calls.filter(({ args }) => args.includes('ls-remote'))) {
      expect(call.options.env).toMatchObject({
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
      });
    }

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(fixture.email);
    expect(serialized).not.toContain('ghp_forbidden');
  });

  it('applies the explicit command-scoped helper only to the read-only probe', () => {
    const fixture = fixturePack.fixtures.find(({ id }) => id === 'command_scoped_remediation');
    const runner = fixtureRunner(fixture);
    const receipt = runGitPublicationPreflight({
      cwd: '/governed/worktree',
      expectedRepository: 'Samsen879/ao-pilot',
      expectedPrincipal: 'Samsen879',
      workerPrincipal: 'Samsen879',
      commandScopedCredentialHelper: fixture.command_scoped_helper,
      runner,
      env: {},
      resolveExecutable: (executable) => fixture.available_executables.includes(executable),
    });

    expect(receipt.checks.credential_helpers.source).toBe('command_scoped_override');
    expect(receipt.remediation).toMatchObject({
      performed: true,
      performed_kind: 'command_scoped_credential_helper_override',
    });
    const probeCall = runner.calls.find(({ args }) => args.includes('ls-remote'));
    expect(probeCall.args).toEqual([
      '-c',
      'credential.interactive=never',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=store',
      'ls-remote',
      '--exit-code',
      'origin',
      'HEAD',
    ]);
  });

  it('redacts credential-bearing remote URLs and private subprocess diagnostics', () => {
    const fixture = {
      ...fixturePack.fixtures[0],
      remote_url: 'https://oauth2:ghp_remote_secret@github.com/Samsen879/ao-pilot.git',
      email: 'private-address@example.test',
    };
    const runner = fixtureRunner(fixture);
    const receipt = runGitPublicationPreflight({
      expectedRepository: 'Samsen879/ao-pilot',
      expectedPrincipal: 'Samsen879',
      workerPrincipal: 'Samsen879',
      runner,
      env: {},
      resolveExecutable: () => true,
    });
    const serialized = JSON.stringify(receipt);

    expect(receipt.status).toBe('blocked');
    expect(serialized).not.toContain('ghp_remote_secret');
    expect(serialized).not.toContain('private-address');
  });

  it('parses canonical GitHub publication transports without retaining URLs', () => {
    expect(parseGitHubRepository('https://github.com/Samsen879/ao-pilot.git')).toEqual({
      repository: 'Samsen879/ao-pilot',
      transport: 'https',
    });
    expect(parseGitHubRepository('git@github.com:Samsen879/ao-pilot.git')).toEqual({
      repository: 'Samsen879/ao-pilot',
      transport: 'ssh',
    });
    expect(parseGitHubRepository('https://token@github.com/Samsen879/ao-pilot.git')).toBeNull();
  });
});
