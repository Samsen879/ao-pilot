import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { configuration, fixtureRoot } from './release-fixture.js';
import { createSystemdReleaseRunner, validateInstallConfiguration, probeExclusiveLock } from '../../scripts/ao/lib/release-systemd.js';
import { prepareStaging, assertStagingIsolation } from '../../scripts/verify-install-staging.js';
import { runCli } from '../../scripts/ao-upgrade.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() { const root = fixtureRoot(); roots.push(root); return { root, config: configuration(root) }; }
it('default runner issues only explicitly namespaced service commands and waits for strict readiness', async () => {
  const { config } = fixture(); const commands = []; let requests = 0; const sleeps = [];
  const runner = createSystemdReleaseRunner(config, { run: (command, args) => { commands.push([command, args]); return ''; }, fetchImpl: async () => ({ ok: true, json: async () => ++requests === 1 ? { state: 'degraded', reasons: ['boot'] } : { state: 'ready', reasons: [] } }), sleep: async (ms) => { sleeps.push(ms); } });
  await runner.start();
  expect(commands).toHaveLength(5); expect(commands[0]).toEqual(['systemctl', ['--user', 'start', 'ao-pilot-staging-fixture-tmux.service']]);
  expect(commands[4][1]).toContain('ao-pilot-staging-fixture-dashboard-adapter.service'); expect(sleeps).toEqual([250]);
});
it('default runner fails closed when only health=ok or degraded is observed', async () => {
  const { config } = fixture();
  const runner = createSystemdReleaseRunner(config, { run: () => '', fetchImpl: async () => ({ ok: true, json: async () => ({ health: 'ok' }) }), sleep: async () => {}, startupAttempts: 2 });
  await expect(runner.start()).rejects.toMatchObject({ code: 'install_startup_not_ready' });
});
it('rejects partial namespace configuration and symlinked ancestors before executing commands', () => {
  const { root, config } = fixture(); const incomplete = { ...config }; delete incomplete.tmuxTmpdir;
  expect(() => validateInstallConfiguration(incomplete)).toThrow();
  const linked = path.join(root, 'alias'); fs.symlinkSync(config.stateRoot, linked);
  expect(() => validateInstallConfiguration({ ...config, dataDir: path.join(linked, 'data') })).toThrow();
});
it('prepares isolated staging files and never starts services; overlapping production paths fail before writing', () => {
  const { root, config } = fixture(); const staging = path.join(root, 'new-staging');
  const plan = prepareStaging({ root: staging, id: 'unit-test', production: config, ports: [44001, 44000, 44002, 44003, 44004] });
  expect(assertStagingIsolation(plan, config)).toBe(true); expect(fs.existsSync(path.join(staging, 'LOCAL-VALIDATION.md'))).toBe(true);
  expect(fs.statSync(path.join(staging, 'install.json')).mode & 0o777).toBe(0o600);
  const collision = path.join(config.stateRoot, 'unsafe');
  expect(() => prepareStaging({ root: collision, id: 'collision', production: config })).toThrow(); expect(fs.existsSync(collision)).toBe(false);
});
it('upgrade CLI connects registered envelope input to real apply API and emits only its public receipt', async () => {
  const { root, config } = fixture(); const id = `1.0.0+${'a'.repeat(40)}`; config.releaseCatalog = { [id]: { bundle: path.join(root, 'bundle'), envelope_sha256: 'a'.repeat(64) } };
  let supplied; const output = []; const result = await runCli(['apply', '--release', id, '--install-config', path.join(root, 'private.json')], { writeStdout: (text) => output.push(text), writeStderr: (text) => output.push(text) }, { configLoader: () => config, apply: async (options) => { supplied = options; return { result: 'passed' }; } });
  expect(result.exitCode).toBe(0); expect(supplied).toMatchObject({ bundle: path.join(root, 'bundle'), expectedEnvelopeSha256: 'a'.repeat(64), resume: false }); expect(output).toEqual(['{\n  "result": "passed"\n}\n']);
});
it('a missing ownership lock is unknown rather than proof of daemon exit', () => {
  const { root } = fixture(); expect(probeExclusiveLock(path.join(root, 'missing'), { expectHeld: false })).toBeNull();
});
