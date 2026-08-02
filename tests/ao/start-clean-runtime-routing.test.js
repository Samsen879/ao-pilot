import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from '@jest/globals';

describe('start-clean managed runtime routing', () => {
  it('prints only ao-pilot lifecycle entrypoints in dry-run mode', () => {
    const scriptPath = path.join(process.cwd(), 'scripts', 'ao', 'start-clean.sh');
    const result = spawnSync('bash', [scriptPath, '--project', 'portable', '--dry-run'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('bin/ao-pilot.js runtime-path');
    expect(result.stdout).toContain('bin/ao-pilot.js stop --project portable');
    expect(result.stdout).toContain('bin/ao-pilot.js start --project portable');
    expect(result.stdout).toContain('bin/ao-pilot.js status --project portable');
    expect(result.stdout).not.toMatch(/(^|[+ ])ao (start|stop|status|doctor|update|send)\b/m);
  });

  it('contains no executable invocation of a PATH-resolved ao', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'ao', 'start-clean.sh'),
      'utf8',
    );
    expect(source).not.toMatch(/^\s*ao\s+/m);
    expect(source).not.toContain('run_cmd ao');
  });
});
