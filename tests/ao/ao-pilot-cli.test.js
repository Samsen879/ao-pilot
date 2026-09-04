import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
  applyConfiguredEvaluation,
  applyConfiguredProject,
  isDirectExecution,
  runCli,
} from '../../bin/ao-pilot.js';

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

describe('ao-pilot unified cli', () => {
  it('initializes a portable config file', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-cli-'));
    const output = createIo();

    try {
      const init = await runCli(
        ['init', '--project', 'portable-project', '--json'],
        output.io,
        { cwd: repoRoot },
      );
      expect(init.exitCode).toBe(0);
      expect(JSON.parse(output.stdout.join(''))).toMatchObject({
        project_id: 'portable-project',
        created: true,
      });
      expect(JSON.parse(fs.readFileSync(
        path.join(repoRoot, 'ao.config.json'),
        'utf8',
      ))).toMatchObject({
        project_id: 'portable-project',
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('uses the supplied library cwd for delegated config and state discovery', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-library-cwd-'));
    const output = createIo();

    try {
      fs.mkdirSync(path.join(repoRoot, '.git'));
      fs.writeFileSync(path.join(repoRoot, 'ao.config.json'), JSON.stringify({
        config_version: 1,
        project_id: 'ciecopilot-home',
      }));

      const result = await runCli(
        ['state', '--json'],
        output.io,
        { cwd: repoRoot },
      );

      expect(result.exitCode).toBe(0);
      expect(result.report).toMatchObject({
        project_id: 'ciecopilot-home',
        repo_root: repoRoot,
        state_root: path.join(
          repoRoot,
          '.ao-control-plane',
          'ciecopilot-home',
        ),
      });
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('reports the version declared by the installed package metadata', async () => {
    const output = createIo();
    const result = await runCli(['--version'], output.io);
    const packageJson = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), 'package.json'),
      'utf8',
    ));

    expect(result.exitCode).toBe(0);
    expect(output.stdout.join('')).toBe(`${packageJson.version}\n`);
  });

  it('applies configured projects without breaking explicit PR scope', () => {
    expect(applyConfiguredProject('state', ['--json'], 'portable-project')).toEqual([
      '--json',
      '--project',
      'portable-project',
    ]);
    expect(applyConfiguredProject('doctor', ['--pr', '42', '--json'], 'portable-project')).toEqual([
      '--pr',
      '42',
      '--json',
    ]);
    expect(applyConfiguredProject(
      'publication-preflight',
      ['--expected-repository', 'owner/repository'],
      'portable-project',
    )).toEqual(['--expected-repository', 'owner/repository']);
  });

  it('applies portable eval configuration without overriding explicit CLI options', () => {
    expect(applyConfiguredEvaluation(
      ['--json'],
      {
        fixture_root: './eval-packs',
        packs: ['smoke', 'continuity'],
        replay_count: 3,
      },
      '/tmp/sample/ao.config.json',
    )).toEqual([
      '--json',
      '--fixture-root',
      '/tmp/sample/eval-packs',
      '--pack',
      'smoke',
      '--pack',
      'continuity',
      '--replay-count',
      '3',
    ]);

    expect(applyConfiguredEvaluation(
      ['--fixture-root', '/explicit', '--pack', 'one', '--replay-count', '4'],
      {
        fixture_root: './ignored',
        packs: ['ignored'],
        replay_count: 2,
      },
      '/tmp/sample/ao.config.json',
    )).toEqual([
      '--fixture-root',
      '/explicit',
      '--pack',
      'one',
      '--replay-count',
      '4',
    ]);
  });

  it('exposes controller help without requiring a live session holder', async () => {
    const output = createIo();
    const result = await runCli(['controller', '--help'], output.io);

    expect(result.exitCode).toBe(0);
    expect(output.stdout.join('')).toContain('Durable holder identity');
    expect(output.stderr.join('')).toBe('');
  });

  it('exposes publication preflight help without requiring AO project config', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-preflight-help-'));
    const output = createIo();
    try {
      const result = await runCli(['publication-preflight', '--help'], output.io, {
        cwd: repoRoot,
      });

      expect(result.exitCode).toBe(0);
      expect(output.stdout.join('')).toContain('--expected-repository');
      expect(output.stderr.join('')).toBe('');
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('recognizes npm-style bin symlinks as direct execution', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-pilot-bin-'));
    const target = path.join(root, 'ao-pilot.js');
    const link = path.join(root, 'ao-pilot');
    fs.writeFileSync(target, '#!/usr/bin/env node\n');
    fs.symlinkSync(target, link);

    try {
      expect(isDirectExecution(link, target)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
