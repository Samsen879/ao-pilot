import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const PROJECT_ROOT = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

describe('ao-pilot public product contract', () => {
  it('ships a deterministic install and verification surface', () => {
    const packageJson = JSON.parse(read('package.json'));

    expect(packageJson.version).toBe('0.2.0');
    expect(packageJson.engines.node).toBe('^20.0.0 || >=22.0.0');
    expect(packageJson.bin['ao-pilot']).toBe('./bin/ao-pilot.js');
    expect(packageJson.scripts['ao:init']).toBe('node scripts/ao-init.js');
    expect(packageJson.scripts.test).toContain('--runInBand');
    expect(packageJson.scripts['ao:test:acceptance']).toContain(
      'tests/ao/ao-lifecycle-acceptance.test.js',
    );
    expect(packageJson.scripts['ao:smoke']).toBe('node scripts/ao/run-operator-smoke.js');
    expect(packageJson.scripts['verify:runtime-lock']).toBe(
      'node scripts/verify-runtime-lock.js',
    );
    expect(packageJson.scripts['release:check']).toContain('npm run verify:package');
    expect(packageJson.scripts['release:check']).toContain('npm run verify:runtime-lock');
    expect(packageJson.publishConfig).toEqual({
      access: 'public',
      provenance: true,
    });
    expect(packageJson.overrides['brace-expansion']).toBe('5.0.9');
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'package-lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'CHANGELOG.md'))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'docs', 'AO_RELEASE.md'))).toBe(true);
    expect(fs.existsSync(path.join(
      PROJECT_ROOT,
      'runtime',
      'agent-orchestrator.lock.json',
    ))).toBe(true);
  });

  it('keeps public documentation independent from the CIE product repository', () => {
    const architecture = read('docs/AO_ARCHITECTURE.md');
    const configuration = read('docs/AO_CONFIGURATION.md');
    const development = read('docs/AO_DEVELOPMENT.md');
    const migrationHistory = read('docs/AO_MIGRATION_HISTORY.md');

    expect(architecture).toContain('generic AI coding agent control plane');
    expect(development).toContain('npm ci');
    expect(development).toContain('npm test');
    expect(migrationHistory).toContain('Independent product baseline');

    expect(configuration).toContain('ao.config.json');
    expect(configuration).toContain('agent-orchestrator-cli');
    expect(configuration).toContain('github-cli');

    for (const text of [architecture, configuration, development, migrationHistory]) {
      expect(text).not.toContain('ciecopilot-home');
      expect(text).not.toContain('9709');
      expect(text).not.toContain('semantic KG');
      expect(text).not.toContain('learning runtime');
    }
  });
});
