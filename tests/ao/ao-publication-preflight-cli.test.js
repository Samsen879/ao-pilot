import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import { runCli } from '../../scripts/ao-publication-preflight.js';

function createIo() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    io: {
      writeStdout: (text) => stdout.push(text),
      writeStderr: (text) => stderr.push(text),
    },
  };
}

function passingRunner() {
  return {
    run(command, args) {
      const invocation = `${command} ${args.join(' ')}`;
      if (invocation === 'git remote get-url --push origin') {
        return { status: 0, stdout: 'https://github.com/Samsen879/ao-pilot.git\n' };
      }
      if (invocation === 'gh api user --jq .login') {
        return { status: 0, stdout: 'Samsen879\n' };
      }
      if (invocation === 'git config --get-urlmatch credential.helper https://github.com/Samsen879/ao-pilot') {
        return { status: 0, stdout: 'store\n' };
      }
      if (invocation === 'git config --get user.name') {
        return { status: 0, stdout: 'Worker\n' };
      }
      if (invocation === 'git config --get user.email') {
        return { status: 0, stdout: '123+Samsen879@users.noreply.github.com\n' };
      }
      if (args.includes('ls-remote')) {
        return { status: 0, stdout: 'ba3a94099c2052bec7388c6b7c76bfa2162fa7d8\tHEAD\n' };
      }
      throw new Error(`Unexpected test invocation: ${invocation}`);
    },
  };
}

describe('Git publication preflight CLI', () => {
  it('writes a private redacted receipt and returns the PASS exit code', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-publication-preflight-'));
    const receiptPath = path.join(root, 'receipt.json');
    const output = createIo();
    try {
      const result = await runCli([
        '--expected-repository', 'Samsen879/ao-pilot',
        '--expected-principal', 'Samsen879',
        '--worker-principal', 'Samsen879',
        '--receipt-out', receiptPath,
        '--json',
      ], output.io, {
        cwd: root,
        runner: passingRunner(),
        env: {},
        now: () => '2026-09-04T00:00:00.000Z',
        resolveExecutable: () => true,
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(output.stdout.join(''))).toEqual(result.receipt);
      expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toEqual(result.receipt);
      expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
      expect(output.stderr).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects missing admission bindings without dispatching a probe', async () => {
    const output = createIo();
    const result = await runCli(['--json'], output.io);

    expect(result.exitCode).toBe(4);
    expect(result.receipt).toBeNull();
    expect(output.stderr.join('')).toContain('Expected repository');
  });

  it('does not echo unexpected provider errors that may contain secrets', async () => {
    const output = createIo();
    const result = await runCli([
      '--expected-repository', 'Samsen879/ao-pilot',
      '--expected-principal', 'Samsen879',
      '--worker-principal', 'Samsen879',
    ], output.io, {
      runner: {
        run() {
          throw new Error('ghp_provider_secret private-address@example.test');
        },
      },
      env: {},
    });

    expect(result.exitCode).toBe(4);
    expect(output.stderr.join('')).toBe('Git publication preflight could not complete safely.\n');
  });
});
