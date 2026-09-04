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
      if (invocation === 'git remote get-url --push --all origin') {
        return { status: 0, stdout: 'https://github.com/Samsen879/ao-pilot.git\n' };
      }
      if (invocation === 'gh api user --jq .login') {
        return { status: 0, stdout: 'Samsen879\n' };
      }
      if (invocation === 'git config --get user.name') {
        return { status: 0, stdout: 'Worker\n' };
      }
      if (invocation === 'git config --get user.email') {
        return { status: 0, stdout: '123+Samsen879@users.noreply.github.com\n' };
      }
      if (args[0] === 'rev-list') {
        return { status: 0, stdout: '0918e609978553d944f6a6c4798c54691ae90775\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n' };
      }
      if (args[0] === 'log') {
        return { status: 0, stdout: '0918e609978553d944f6a6c4798c54691ae90775\u001fWorker\u001f123+Samsen879@users.noreply.github.com\u001fWorker\u001f123+Samsen879@users.noreply.github.com\n' };
      }
      if (invocation === 'git --exec-path') {
        return { status: 0, stdout: '/git-core\n' };
      }
      if (invocation === "git config --null --get-regexp ^credential(\\..*)?\\.helper$") {
        return { status: 0, stdout: 'credential.helper\nstore\0' };
      }
      if (command === 'git' && args.includes('credential') && args.includes('fill')) {
        return { status: 0, stdout: 'username=worker\npassword=fixture-secret\n' };
      }
      if (command === 'gh' && args[1] === 'repos/Samsen879/ao-pilot') {
        return { status: 0, stdout: '{"repository":"Samsen879/ao-pilot","push":true}\n' };
      }
      if (command === 'git' && args.includes('ls-remote')) {
        return { status: 0, stdout: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main\n' };
      }
      if (invocation === 'git rev-parse HEAD') {
        return { status: 0, stdout: '0918e609978553d944f6a6c4798c54691ae90775\n' };
      }
      if (args.includes('push') && args.includes('--dry-run')) {
        return { status: 0, stdout: 'Done\n' };
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

  it('repairs permissions when overwriting an existing receipt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-publication-preflight-mode-'));
    const receiptPath = path.join(root, 'receipt.json');
    fs.writeFileSync(receiptPath, '{}\n', { mode: 0o644 });
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
        resolveExecutable: () => true,
      });
      expect(result.exitCode).toBe(0);
      expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600);
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
