import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { checkInstallTools, INSTALL_TOOLS } from '../../scripts/ao/lib/release-tools.js';
import { applyRelease, preflightRelease } from '../../scripts/ao/lib/release-installer.js';
import { createSystemdReleaseRunner, validateInstallConfiguration } from '../../scripts/ao/lib/release-systemd.js';
import { processStartToken } from '../../scripts/ao/lib/release-lock.js';
import { runCli } from '../../scripts/ao-upgrade.js';
import { fixtureRoot, configuration, createBundle, fakeRunner } from './release-fixture.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() { const root = fixtureRoot(); roots.push(root); return { root, config: configuration(root) }; }
it('reports all missing prerequisites by name without executing any tool', () => {
  const checked = [];
  try {
    checkInstallTools({ resolve: name => { checked.push(name); return ['sqlite3', 'flock'].includes(name) ? null : `/tools/${name}`; } });
    throw Error('must reject');
  } catch (error) {
    expect(error.code).toBe('install_required_tools_missing');
    expect(error.details.missing).toEqual(['flock', 'sqlite3']);
    expect(error.message).toContain('sqlite3');
    expect(checked).toEqual(INSTALL_TOOLS);
  }
});
it('rejects missing tools before creating the install root, lock or journal', async () => {
  const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
  runner.checkTools = () => checkInstallTools({ resolve: () => null });
  await expect(applyRelease({ bundle: bundle.bundle, expectedEnvelopeSha256: bundle.envelopeSha, configuration: config, runner })).rejects.toMatchObject({ code: 'install_required_tools_missing' });
  expect(fs.existsSync(config.installRoot)).toBe(false); expect(runner.calls).toEqual([]);
});
it('runs actual API preflight without acquiring a lock, preparing a release or stopping services', async () => {
  const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
  const result = await preflightRelease({ bundle: bundle.bundle, expectedEnvelopeSha256: bundle.envelopeSha, configuration: config, runner });
  expect(result).toMatchObject({ status: 'passed', phase: 'preflight', production_mutated: false });
  expect(runner.calls).toEqual(['preflight']); expect(fs.existsSync(config.installRoot)).toBe(false);
});
it('uses inventoried default only for legacy baseline and retains every concrete observation error', async () => {
  const { root, config } = fixture(); const bundle = createBundle(root); const doctorEnvs = [];
  const legacy = { tmux: { socket: 'default', tmpdir: path.join(root, 'old-tmux') } };
  const runner = createSystemdReleaseRunner(config, { run(command, args, options) {
    if (command === 'sqlite3') throw Object.assign(Error('readonly SQLite fixture denied'), { code: 'SQLITE_DENIED', details: { operation: 'query' } });
    if (command.endsWith('/native/ao')) { doctorEnvs.push(options.env); return JSON.stringify({ checks: [{ name: 'tmux_cgroup', level: 'FAIL', details: { status: 'violation', server_pid: process.pid, server_start_token: processStartToken() } }] }); }
    if (command === 'loginctl') return 'yes';
    throw Error(`Unexpected command: ${command}`);
  }, fetchImpl: async url => ({ ok: true, json: async () => url.pathname.includes('sessions') ? { sessions: [] } : url.pathname.includes('mobile') ? { enabled: false } : { status: 'ready', ready: true, reasons: [] } }) });
  let error; try { await runner.observe({ releaseRoot: bundle.payload, baselineOnly: true, legacy }); } catch (e) { error = e; }
  expect(error.code).toBe('install_baseline_observation_failed');
  expect(error.details.identity).toMatchObject({ code: 'SQLITE_DENIED', message: 'readonly SQLite fixture denied' });
  expect(error.details.database.details.operation).toBe('query');
  expect(doctorEnvs[0]).toMatchObject({ AO_TMUX_SOCKET: 'default', AO_TMUX_TMPDIR: legacy.tmux.tmpdir, TMUX_TMPDIR: legacy.tmux.tmpdir });
  expect(() => validateInstallConfiguration({ ...config, tmuxSocket: 'default' })).toThrow('invalid_tmux_namespace');
});
it('exposes private concrete CLI diagnostics while rejecting prepared-input overrides for apply', async () => {
  const { config } = fixture(); const id = `1.0.0+${'a'.repeat(40)}`; config.releaseCatalog = { [id]: { bundle: '/private/bundle', envelope_sha256: 'a'.repeat(64) } };
  const out = [], err = []; let applied = false;
  const dependencies = { configLoader: () => config, preflight: async () => { throw Object.assign(Error('sqlite3 unavailable'), { code: 'install_required_tools_missing', details: { missing: ['sqlite3'] } }); }, apply: async () => { applied = true; } };
  const io = { writeStdout: text => out.push(text), writeStderr: text => err.push(text) };
  expect((await runCli(['preflight', '--release', id], io, dependencies)).exitCode).toBe(2);
  expect(JSON.parse(err[0])).toMatchObject({ code: 'install_required_tools_missing', details: { missing: ['sqlite3'] } });
  expect(out).toEqual([]);
  expect((await runCli(['apply', '--release', id, '--prepared-config', '/private/input'], io, dependencies)).exitCode).toBe(2);
  expect(applied).toBe(false);
});

it.each([['tmux_cgroup_violation', true], ['session_reconcile_failed', false]])('preserves only the inventoried legacy tmux degraded readiness (%s)', async (reason, accepted) => {
 const { root, config } = fixture(); const bundle = createBundle(root); const commands = [];
 const runner = createSystemdReleaseRunner(config, { run(command, args) {
  commands.push([command, args]);
  if (command === 'sqlite3') return args.includes('-json') ? '[]' : '43\nok';
  if (command === 'loginctl') return 'yes';
  if (command.endsWith('/native/ao')) return JSON.stringify({ checks: [{ name: 'tmux_cgroup', level: 'FAIL', details: { server_pid: process.pid, server_start_token: processStartToken() } }] });
  throw Error('unexpected tool');
 }, fetchImpl: async url => ({ ok: !url.pathname.endsWith('/readyz'), status: url.pathname.endsWith('/readyz') ? 503 : 200,
  json: async () => url.pathname.endsWith('/readyz') ? { status: 'degraded', ready: false, reasons: [{ code: reason }] } : url.pathname.includes('sessions') ? { sessions: [] } : { enabled: false } }) });
 const legacy = { tmux: { socket: 'default', tmpdir: path.join(root, 'legacy-tmux') } };
 if (accepted) {
  const baseline = await runner.observe({ releaseRoot: bundle.payload, baselineOnly: true, legacy });
  expect(baseline.ready).toMatchObject({ status: 'degraded', ready: false });
 } else await expect(runner.observe({ releaseRoot: bundle.payload, baselineOnly: true, legacy })).rejects.toMatchObject({ code: 'install_baseline_observation_failed' });
 const verify = await runner.observe({ releaseRoot: bundle.payload }); expect(verify.ready).toBeNull();
 expect(commands.filter(([tool]) => tool.endsWith('/native/ao')).every(([,args])=>args.includes('--tmux-only'))).toBe(true);
});
