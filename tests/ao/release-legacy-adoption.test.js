import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from '@jest/globals';
import { fixtureRoot, configuration } from './release-fixture.js';
import { fileSha256, durableJson } from '../../scripts/ao/lib/release-manifest.js';
import { processStartToken } from '../../scripts/ao/lib/release-lock.js';
import { captureLegacyServices, collectLegacyAdoption, assertLegacyAdoption, legacyExecStart } from '../../scripts/ao/lib/release-legacy-adoption.js';
import { copyCustodyTree, createSystemdReleaseRunner } from '../../scripts/ao/lib/release-systemd.js';

const roots = []; const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode !== null || child.signalCode !== null) continue; const done = once(child, 'exit'); child.kill(); await done; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fixtureRoot(); roots.push(root); const config = configuration(root);
  // Runner toolcaches need not satisfy the product's executable owner/mode
  // policy. Use a small real interpreter blocked on its owned stdin pipe,
  // retaining executable/script SHA and cmdline assertions without hashing a
  // full Node executable dozens of times in this process-identity fixture.
  const executable = path.join(root, 'legacy-node'); fs.copyFileSync(fs.realpathSync('/bin/sh'), executable); fs.chmodSync(executable, 0o700);
  const script = path.join(root, 'legacy.mjs'); fs.writeFileSync(script, 'read -r fixture_input\n', { mode: 0o600 });
  const child = spawn(executable, [script], { stdio: ['pipe', 'ignore', 'ignore'] }); children.push(child); await once(child, 'spawn');
  const tmuxChild = spawn(executable, [script], { stdio: ['pipe', 'ignore', 'ignore'] }); children.push(tmuxChild); await once(tmuxChild, 'spawn');
  const unitNames = ['runtime', 'dashboard', 'dashboard-adapter', 'session-recovery'].map((name) => `${config.namespace}-${name}.service`);
  fs.mkdirSync(config.unitRoot);
  const group = fs.readFileSync(`/proc/${child.pid}/cgroup`, 'utf8').trim().split(':')[2];
  const records = Object.fromEntries(unitNames.map((unit, index) => {
    const file = path.join(config.unitRoot, unit); fs.writeFileSync(file, '[Service]\nExecStart=fixture\n');
    return [unit, { Id: unit, LoadState: 'loaded', MainPID: String(index === 2 ? child.pid : 0),
      ExecStart: `{ path=${executable} ; argv[]=${executable} ${script} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; }`,
      FragmentPath: file, DropInPaths: '', NeedDaemonReload: 'no', ControlGroup: group }];
  }));
  const dependencies = {
    run(command, args) {
      if (command === 'tmux') {
        expect(args.slice(0, 3)).toEqual(['-S', path.join(root, 'old-tmux', `tmux-${process.getuid()}`, 'default'), '-N']);
        if (!fs.existsSync(`/proc/${tmuxChild.pid}`)) return '';
        return args.includes('list-sessions') ? 'fixture-worker' : String(tmuxChild.pid);
      }
      expect(command).toBe('systemctl'); const record = records[args[2]]; expect(record).toBeDefined();
      return args.includes('--value') ? record.MainPID : Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
    },
    processEvidence(pid) {
      return { pid, start_token: processStartToken(pid), executable: fs.realpathSync(`/proc/${pid}/exe`),
        executable_sha256: fileSha256(`/proc/${pid}/exe`), argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
    },
    processUnchanged(proc) { try { return processStartToken(proc.pid) === proc.start_token; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
  };
  const units = captureLegacyServices(config, dependencies);
  config.legacyInventoryPath = path.join(root, 'l1-step6-inventory.json');
  const tmux = { socket: 'default', tmpdir: path.join(root, 'old-tmux'), pid: tmuxChild.pid,
    start_token: processStartToken(tmuxChild.pid), executable_sha256: fileSha256(executable), session_names: ['fixture-worker'] };
  durableJson(config.legacyInventoryPath, { schema_version: 'ao.legacy-adoption-inventory.v1', namespace: config.namespace, units, tmux });
  config.legacyInventorySha256 = fileSha256(config.legacyInventoryPath);
  return { root, config, dependencies, records, script, child, tmuxChild };
}

it('adopts an exact legacy unit/ExecStart SHA256/cmdline match without requiring new-style AO environment', async () => {
  const { config, dependencies } = await fixture();
  const evidence = collectLegacyAdoption(config, dependencies);
  expect(evidence.units[2].process.cmdline).toHaveLength(2);
  expect(evidence.units[2].exec_start.files).toHaveLength(2); // Node + script
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).not.toThrow();
  expect(evidence.tmux.socket).toBe('default'); expect(config.tmuxSocket).not.toBe('default');
});
it.each(['pid', 'start_token', 'session_names'])('rejects changed legacy tmux %s before switch', async (field) => {
  const { config, dependencies } = await fixture(); const evidence = collectLegacyAdoption(config, dependencies);
  const original = dependencies.run;
  if (field === 'pid') dependencies.run = (command, args, options) => command === 'tmux' && args.includes('display-message') ? String(evidence.tmux.pid + 1) : original(command, args, options);
  if (field === 'session_names') dependencies.run = (command, args, options) => command === 'tmux' && args.includes('list-sessions') ? 'unexpected-worker' : original(command, args, options);
  if (field === 'start_token') { const get = dependencies.processEvidence; dependencies.processEvidence = pid => pid === evidence.tmux.pid ? ({ ...get(pid), start_token: 'changed' }) : get(pid); }
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).toThrow('Legacy tmux');
});
it.each(['unit_name', 'target_sha256', 'cmdline', 'pid_generation', 'dropin', 'inventory_digest'])('rejects changed %s before any stop', async (kind) => {
  const { config, dependencies, records, script } = await fixture(); const evidence = collectLegacyAdoption(config, dependencies);
  const adapter = records[`${config.namespace}-dashboard-adapter.service`];
  if (kind === 'unit_name') adapter.Id = 'unowned.service';
  if (kind === 'target_sha256') fs.appendFileSync(script, '\n// changed bytes');
  if (kind === 'cmdline') {
    const original = dependencies.processEvidence; dependencies.processEvidence = (pid) => ({ ...original(pid), argv: [process.execPath, '/different.mjs'] });
  }
  if (kind === 'pid_generation') {
    const original = dependencies.processEvidence; dependencies.processEvidence = (pid) => ({ ...original(pid), start_token: 'reused-pid' });
  }
  if (kind === 'dropin') fs.appendFileSync(adapter.FragmentPath, '# changed unit');
  if (kind === 'inventory_digest') fs.appendFileSync(config.legacyInventoryPath, ' ');
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).toThrow('install_legacy_adoption_mismatch');
});
it('allows only the transaction-recorded fully stopped state, never a replacement process', async () => {
  const { config, dependencies, records, child, tmuxChild } = await fixture(); const evidence = collectLegacyAdoption(config, dependencies);
  records[`${config.namespace}-dashboard-adapter.service`].MainPID = '0';
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).toThrow();
  const exited = once(child, 'exit'); child.kill(); await exited;
  const tmuxExited = once(tmuxChild, 'exit'); tmuxChild.kill(); await tmuxExited;
  expect(() => assertLegacyAdoption(config, evidence, dependencies, { stopped: true })).not.toThrow();
});
it('copies custody directory modes exactly, including existing destinations and restored copies', () => {
  const root = fixtureRoot(); roots.push(root); const source = path.join(root, 'source');
  fs.mkdirSync(path.join(source, 'attempt/nested'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(source, 'attempt/nested/record.json'), 'custody', { mode: 0o600 });
  const target = path.join(root, 'backup'); fs.mkdirSync(path.join(target, 'attempt'), { recursive: true, mode: 0o755 });
  copyCustodyTree(source, target);
  const restored = path.join(root, 'restored'); copyCustodyTree(target, restored);
  for (const tree of [source, target, restored]) {
    for (const relative of ['attempt', 'attempt/nested']) expect(fs.statSync(path.join(tree, relative)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(tree, 'attempt/nested/record.json')).mode & 0o777).toBe(0o600);
  }
  // The existing inventory comparison must still reject extra copied data.
  fs.writeFileSync(path.join(target, 'unexpected'), 'drift');
  expect(() => copyCustodyTree(source, target)).toThrow('install_database_backup_invalid');
});
it('accepts a digest-bound non-writable system-owned interpreter, while refusing writable executable inputs', () => {
  const executable = fs.realpathSync('/bin/sh');
  expect(fs.statSync(executable).uid).toBe(0);
  const text = (file) => `{ path=${file} ; argv[]=${file} ; ignore_errors=no ; pid=0 ; }`;
  expect(legacyExecStart(text(executable)).files).toEqual([{ path: executable, sha256: fileSha256(executable) }]);
  const root = fixtureRoot(); roots.push(root); const unsafe = path.join(root, 'writable');
  fs.writeFileSync(unsafe, 'unsafe'); fs.chmodSync(unsafe, 0o777);
  expect(() => legacyExecStart(text(unsafe))).toThrow('install_legacy_adoption_mismatch');
});
it('rejects symlinked absolute script arguments instead of silently omitting their digest', () => {
  const root = fixtureRoot(); roots.push(root); const script = path.join(root, 'script.mjs'); const link = path.join(root, 'link.mjs');
  fs.writeFileSync(script, 'script'); fs.symlinkSync(script, link);
  const command = `{ path=${process.execPath} ; argv[]=${process.execPath} ${link} ; ignore_errors=no ; pid=0 ; }`;
  expect(() => legacyExecStart(command)).toThrow('install_legacy_adoption_mismatch');
  fs.appendFileSync(script, 'changed target bytes');
  expect(() => legacyExecStart(command)).toThrow('install_legacy_adoption_mismatch');
});

async function stoppedFixture() {
  const f = await fixture();
  for (const child of [f.child, f.tmuxChild]) { const done = once(child, 'exit'); child.kill(); await done; }
  for (const record of Object.values(f.records)) Object.assign(record, { MainPID: '0', ActiveState: 'inactive', SubState: 'dead', ControlGroup: '' });
  const run = f.dependencies.run;
  f.dependencies.run = (command, args, options) => command === 'ps' ? '' : run(command, args, options);
  return f;
}
it('offline adoption retains the original inventory and requires a fully stopped installation', async () => {
  const { config, dependencies } = await stoppedFixture();
  const bytes = fs.readFileSync(config.legacyInventoryPath);
  expect(() => collectLegacyAdoption(config, dependencies)).toThrow();
  const evidence = collectLegacyAdoption(config, dependencies, { offline: true });
  expect(evidence.adoption_mode).toBe('offline'); expect(evidence.units.every(unit => unit.process === null)).toBe(true);
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).not.toThrow();
  expect(fs.readFileSync(config.legacyInventoryPath)).toEqual(bytes);
});
it.each(['active', 'activating', 'unit_bytes', 'socket', 'outside_process', 'observation_unknown'])('offline adoption rejects %s without weakening online identity checks', async kind => {
  const { config, dependencies, records } = await stoppedFixture();
  const evidence = collectLegacyAdoption(config, dependencies, { offline: true });
  const unit = Object.values(records)[0];
  if (kind === 'active') unit.MainPID = String(process.pid);
  if (kind === 'activating') unit.ActiveState = 'activating';
  if (kind === 'unit_bytes') fs.appendFileSync(unit.FragmentPath, '# drift');
  if (kind === 'socket') { const socket = path.join(evidence.tmux.tmpdir, `tmux-${process.getuid()}`, evidence.tmux.socket); fs.mkdirSync(path.dirname(socket), { recursive: true }); fs.writeFileSync(socket, 'stale or live socket refuses adoption'); }
  if (kind === 'outside_process') { const run = dependencies.run; dependencies.run = (cmd, args, opts) => cmd === 'ps' ? `123 ${evidence.units[0].exec_start.argv.join(' ')}` : run(cmd, args, opts); }
  if (kind === 'observation_unknown') { const run = dependencies.run; dependencies.run = (cmd, args, opts) => { if (cmd === 'ps') throw Error('proc observation denied'); return run(cmd, args, opts); }; }
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).toThrow();
});

async function offlineRunnerFixture() {
  const f = await stoppedFixture(); const { root, config } = f;
  config.restoreProjects = ['fixture']; config.restoreConcurrency = 1;
  fs.chmodSync(config.configPath, 0o600);
  fs.mkdirSync(config.dataDir, { recursive: true }); fs.mkdirSync(config.discoveryDir, { recursive: true });
  for (const file of [path.join(config.dataDir, '.daemon-owner.lock'), path.join(config.discoveryDir, '.daemon-discovery.lock')]) fs.writeFileSync(file, '', { mode: 0o600 });
  const db = path.join(config.dataDir, 'ao.db');
  execFileSync('sqlite3', [db, `CREATE TABLE projects(id TEXT); INSERT INTO projects VALUES('fixture');
    CREATE TABLE goose_db_version(id INTEGER,version_id INTEGER,is_applied INTEGER); INSERT INTO goose_db_version VALUES(1,43,1);
    CREATE TABLE spawn_attempt_sessions(session_id TEXT,attempt_id TEXT,project_id TEXT,session_num INTEGER);
    CREATE TABLE sessions(id TEXT,project_id TEXT,num INTEGER,kind TEXT,harness TEXT,agent_session_id TEXT,runtime_launch_id TEXT,runtime_handle_id TEXT,is_terminated INTEGER,workspace_path TEXT,branch TEXT,created_at TEXT);
    INSERT INTO sessions VALUES('live','fixture',1,'worker','codex','native-live',NULL,NULL,0,NULL,NULL,'fixed');
    INSERT INTO sessions VALUES('historical','fixture',2,'worker','codex','native-old',NULL,NULL,1,NULL,NULL,'fixed');`]);
  const identities = JSON.parse(execFileSync('sqlite3', ['-json', db, 'SELECT s.id AS ao_session_id,s.project_id,s.num,s.kind,s.harness,s.agent_session_id AS native_conversation_id,s.runtime_launch_id,s.runtime_handle_id,s.is_terminated,s.workspace_path,s.branch,s.created_at,a.attempt_id FROM sessions s LEFT JOIN spawn_attempt_sessions a ON a.session_id=s.id ORDER BY s.id;'], { encoding: 'utf8' }));
  config.offlineBaselinePath = path.join(root, 'approved-offline-baseline.json');
  durableJson(config.offlineBaselinePath, { schema_version: 'ao.legacy-offline-baseline.v1', inventory_sha256: config.legacyInventorySha256,
    snapshot: { identities, custody: [], projects: ['fixture'], native_cids: identities.map(row => ({ ao_session_id: row.ao_session_id, native_conversation_id: row.native_conversation_id })), database: { schema: 43, integrity: 'ok' } } });
  config.offlineBaselineSha256 = fileSha256(config.offlineBaselinePath);
  let ports = ''; const calls = [];
  const runner = createSystemdReleaseRunner(config, { run: (command, args, options) => {
    calls.push([command, args]);
    if (command === 'sqlite3') return execFileSync(command, args, { encoding: 'utf8' }).trim();
    if (command === 'ss') return ports;
    if (command === 'loginctl') return 'yes';
    return f.dependencies.run(command, args, options);
  }, fetchImpl: async () => { throw Error('Offline preflight must not call old HTTP services'); } });
  return { ...f, runner, calls, db, setPorts(value) { ports = value; } };
}
it('collects offline native identities from a real SQLite DB, makes no service mutation, and fences the journal evidence', async () => {
  const { config, runner, calls, db } = await offlineRunnerFixture();
  if (typeof process.execve !== 'function') {
    await expect(runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true })).rejects.toThrow('release_node_execve_required'); return;
  }
  const baseline = await runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true });
  expect(baseline.offline).toBe(true); expect(baseline.cids).toEqual(['historical', 'live']);
  expect(baseline.ready).toBeUndefined(); expect(baseline.tmux).toBeUndefined();
  await runner.checkLegacy({ evidence: baseline.legacy_adoption });
  await runner.stop({ legacyAdoption: baseline.legacy_adoption });
  expect(calls.some(([command, args]) => command === 'systemctl' && args.includes('stop'))).toBe(false);
  execFileSync('sqlite3', [db, "UPDATE sessions SET agent_session_id='changed' WHERE id='live'"]);
  await expect(runner.checkLegacy({ evidence: baseline.legacy_adoption })).rejects.toThrow('approved baseline');
  expect(fs.existsSync(config.installRoot)).toBe(false);
});
it('refuses occupied ports, missing locks and an altered offline baseline before service mutations', async () => {
  const { config, runner, setPorts } = await offlineRunnerFixture();
  if (typeof process.execve !== 'function') {
    await expect(runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true })).rejects.toThrow('release_node_execve_required'); return;
  }
  setPorts('LISTEN 0 128 127.0.0.1:43001 0.0.0.0:*');
  await expect(runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true })).rejects.toThrow('ports');
  setPorts(''); fs.appendFileSync(config.offlineBaselinePath, ' ');
  await expect(runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true })).rejects.toThrow('install_legacy_offline_baseline_invalid');
  config.offlineBaselineSha256 = fileSha256(config.offlineBaselinePath);
  fs.rmSync(path.join(config.dataDir, '.daemon-owner.lock'));
  await expect(runner.preflight({ mode: 'first', adoptLegacy: true, adoptLegacyOffline: true })).rejects.toThrow('install_previous_locks_held');
});
