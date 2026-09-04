import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  prepareWorkerWorktree,
  WORKER_PREPARATION_EXIT_CODES,
} from '../../scripts/ao/lib/worker-worktree-preparation.js';
import { runCli } from '../../scripts/prepare-worker-worktree.js';

const CONTRACT = {
  schema_version: 'ao.worker-worktree-preparation-contract.v1',
  package_manager: 'npm',
  lockfile: 'package-lock.json',
  install_command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  test_runner: 'node_modules/.bin/jest',
};

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-worker-preparation-'));
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    ao: { worker_worktree_preparation: CONTRACT },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: 'fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'fixture', version: '1.0.0' } },
  }, null, 2)}\n`);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'AO Test']);
  git(root, ['config', 'user.email', 'ao-test@example.invalid']);
  git(root, ['add', 'package.json', 'package-lock.json']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);
  return root;
}

function successfulInstaller(root, calls) {
  return (command, args, options) => {
    if (command === 'git') return spawnSync(command, args, options);
    calls.push({ command, args, options });
    if (command === 'npm' || command === 'npm.cmd') {
      const runner = path.join(root, 'node_modules', '.bin', 'jest');
      fs.mkdirSync(path.dirname(runner), { recursive: true });
      fs.writeFileSync(runner, 'fixture');
    }
    return { status: 0, signal: null };
  };
}

describe('Worker worktree preparation', () => {
  it('prepares a fresh worktree with the exact allowlisted, secret-free npm invocation', () => {
    const root = fixture();
    const calls = [];
    const result = prepareWorkerWorktree({ repoRoot: root, processRunner: successfulInstaller(root, calls) });

    expect(result).toMatchObject({
      status: 'ready',
      ready: true,
      failure_class: null,
      install_performed: true,
      receipt_replayed: false,
      repository: { commit_sha: expect.stringMatching(/^[0-9a-f]{40}$/), tree_sha: expect.stringMatching(/^[0-9a-f]{40}$/) },
      lockfile: { path: 'package-lock.json', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      test_runner: { path: 'node_modules/.bin/jest', ready: true },
    });
    const installCall = calls.find(({ command }) => command === 'npm' || command === 'npm.cmd');
    expect(installCall.args).toEqual(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(installCall.options).toMatchObject({ stdio: 'ignore', timeout: 600_000 });
    expect(installCall.options.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(installCall.options.env).not.toHaveProperty('NODE_AUTH_TOKEN');
  });

  it('replays a matching receipt without reinstalling', () => {
    const root = fixture();
    const calls = [];
    const processRunner = successfulInstaller(root, calls);
    const first = prepareWorkerWorktree({ repoRoot: root, processRunner });
    const second = prepareWorkerWorktree({ repoRoot: root, processRunner });

    expect(first.install_performed).toBe(true);
    expect(second).toMatchObject({ status: 'ready', install_performed: false, receipt_replayed: true });
    expect(second.repository).toEqual(first.repository);
    expect(second.lockfile).toEqual(first.lockfile);
    expect(calls.filter(({ command }) => command === 'npm' || command === 'npm.cmd')).toHaveLength(1);
    expect(calls.filter(({ args }) => args[0] === '--version')).toHaveLength(2);
  });

  it.each([
    ['missing', (root) => fs.rmSync(path.join(root, 'package-lock.json')), 'committed_lockfile_missing'],
    ['changed', (root) => fs.appendFileSync(path.join(root, 'package-lock.json'), ' '), 'committed_lockfile_changed'],
  ])('fails closed for a %s committed lockfile', (_name, mutate, reasonCode) => {
    const root = fixture();
    mutate(root);
    const calls = [];
    const result = prepareWorkerWorktree({ repoRoot: root, processRunner: successfulInstaller(root, calls) });
    expect(result).toMatchObject({ status: 'setup_failed', ready: false, failure_class: 'setup', reason_code: reasonCode });
    expect(calls).toHaveLength(0);
  });

  it('retries safely after an interrupted install without accepting a partial runner', () => {
    const root = fixture();
    let attempt = 0;
    const processRunner = (command, args, options) => {
      if (command === 'git') return spawnSync(command, args, options);
      if (command === 'npm' || command === 'npm.cmd') attempt += 1;
      if (attempt === 1) return { status: null, signal: 'SIGTERM' };
      const runner = path.join(root, 'node_modules', '.bin', 'jest');
      fs.mkdirSync(path.dirname(runner), { recursive: true });
      fs.writeFileSync(runner, 'fixture');
      return { status: 0, signal: null };
    };

    expect(prepareWorkerWorktree({ repoRoot: root, processRunner })).toMatchObject({
      status: 'setup_failed',
      failure_class: 'setup',
      reason_code: 'dependency_install_failed',
      install: { exit_code: null, signal: 'SIGTERM' },
    });
    expect(prepareWorkerWorktree({ repoRoot: root, processRunner })).toMatchObject({
      status: 'ready',
      install_performed: true,
    });
    expect(attempt).toBe(2);
  });

  it('does not report readiness when npm succeeds without a healthy declared test runner', () => {
    const root = fixture();
    const processRunner = (command, args, options) => (
      command === 'git'
        ? spawnSync(command, args, options)
        : { status: 0, signal: null }
    );
    expect(prepareWorkerWorktree({ repoRoot: root, processRunner })).toMatchObject({
      status: 'setup_failed',
      ready: false,
      failure_class: 'setup',
      reason_code: 'test_runner_unhealthy_after_install',
      install_performed: true,
    });
  });

  it('reinstalls when a matching receipt has an unhealthy runner', () => {
    const root = fixture();
    const calls = [];
    const healthyRunner = successfulInstaller(root, calls);
    prepareWorkerWorktree({ repoRoot: root, processRunner: healthyRunner });
    let probeCount = 0;
    const processRunner = (command, args, options) => {
      if (command === 'git') return spawnSync(command, args, options);
      if (args[0] === '--version') {
        probeCount += 1;
        return { status: probeCount === 1 ? 1 : 0, signal: null };
      }
      return healthyRunner(command, args, options);
    };
    expect(prepareWorkerWorktree({ repoRoot: root, processRunner })).toMatchObject({
      status: 'ready',
      install_performed: true,
      receipt_replayed: false,
    });
    expect(probeCount).toBe(2);
    expect(calls.filter(({ command }) => command === 'npm' || command === 'npm.cmd')).toHaveLength(2);
  });

  it('accepts a Git-clean CRLF materialization while binding the committed blob digest', () => {
    const root = fixture();
    git(root, ['config', 'core.autocrlf', 'true']);
    const lockfilePath = path.join(root, 'package-lock.json');
    fs.writeFileSync(lockfilePath, fs.readFileSync(lockfilePath, 'utf8').replaceAll('\n', '\r\n'));
    const result = prepareWorkerWorktree({ repoRoot: root, processRunner: successfulInstaller(root, []) });
    expect(result).toMatchObject({ status: 'ready', lockfile: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
  });

  it('allocates a bounded Git output buffer large enough for common lockfiles', () => {
    const root = fixture();
    let observedMaxBuffer = 0;
    const installer = successfulInstaller(root, []);
    const processRunner = (command, args, options) => {
      if (command === 'git' && args[0] === 'show') observedMaxBuffer = options.maxBuffer;
      return command === 'git'
        ? spawnSync(command, args, options)
        : installer(command, args, options);
    };
    expect(prepareWorkerWorktree({ repoRoot: root, processRunner }).ready).toBe(true);
    expect(observedMaxBuffer).toBe(32 * 1024 * 1024);
  });

  it('emits classified JSON when repository-local state cannot be written', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, '.ao-pilot'), 'not a directory');
    let stdout = '';
    const outcome = runCli(['--json'], {
      writeStdout: (text) => { stdout += text; },
      writeStderr: () => {},
    }, { cwd: root });
    expect(outcome.exitCode).toBe(WORKER_PREPARATION_EXIT_CODES.setupFailure);
    expect(JSON.parse(stdout)).toMatchObject({
      status: 'setup_failed',
      failure_class: 'setup',
      reason_code: 'preparation_state_unwritable',
    });
  });

  it('rejects project npm configuration before install', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, '.npmrc'), 'fund=false');
    const result = prepareWorkerWorktree({ repoRoot: root });
    expect(result).toMatchObject({ failure_class: 'setup', reason_code: 'project_npmrc_not_allowed' });
    expect(JSON.stringify(result)).not.toContain('fund=false');
  });

  it('uses a dedicated setup-failure exit code and emits only JSON evidence', () => {
    let stdout = '';
    const outcome = runCli(['--unsupported'], {
      writeStdout: (text) => { stdout += text; },
      writeStderr: () => {},
    });
    expect(outcome.exitCode).toBe(WORKER_PREPARATION_EXIT_CODES.setupFailure);
    expect(JSON.parse(stdout)).toMatchObject({ failure_class: 'setup', reason_code: 'unsupported_argument' });
  });
});
