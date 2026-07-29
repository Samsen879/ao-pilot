import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

import {
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
  });

  it('exposes controller help without requiring a live session holder', async () => {
    const output = createIo();
    const result = await runCli(['controller', '--help'], output.io);

    expect(result.exitCode).toBe(0);
    expect(output.stdout.join('')).toContain('Durable holder identity');
    expect(output.stderr.join('')).toBe('');
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
