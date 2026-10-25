import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, it } from '@jest/globals';
import { fixtureRoot, configuration } from './release-fixture.js';
import { fileSha256, durableJson } from '../../scripts/ao/lib/release-manifest.js';
import { processStartToken } from '../../scripts/ao/lib/release-lock.js';
import { captureLegacyServices, collectLegacyAdoption, assertLegacyAdoption, legacyExecStart } from '../../scripts/ao/lib/release-legacy-adoption.js';
import { copyCustodyTree } from '../../scripts/ao/lib/release-systemd.js';

const roots = []; const children = [];
afterEach(async () => {
  for (const child of children.splice(0)) { const done = once(child, 'exit'); child.kill(); await done; }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fixtureRoot(); roots.push(root); const config = configuration(root);
  const script = path.join(root, 'legacy.mjs'); fs.writeFileSync(script, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [script], { stdio: 'ignore' }); children.push(child); await once(child, 'spawn');
  const unitNames = ['runtime', 'dashboard', 'dashboard-adapter', 'session-recovery'].map((name) => `${config.namespace}-${name}.service`);
  fs.mkdirSync(config.unitRoot);
  const group = fs.readFileSync(`/proc/${child.pid}/cgroup`, 'utf8').trim().split(':')[2];
  const records = Object.fromEntries(unitNames.map((unit, index) => {
    const file = path.join(config.unitRoot, unit); fs.writeFileSync(file, '[Service]\nExecStart=fixture\n');
    return [unit, { Id: unit, LoadState: 'loaded', MainPID: String(index === 2 ? child.pid : 0),
      ExecStart: `{ path=${process.execPath} ; argv[]=${process.execPath} ${script} ; ignore_errors=no ; start_time=[n/a] ; pid=0 ; }`,
      FragmentPath: file, DropInPaths: '', NeedDaemonReload: 'no', ControlGroup: group }];
  }));
  const dependencies = {
    run(command, args) {
      expect(command).toBe('systemctl'); const record = records[args[2]]; expect(record).toBeDefined();
      return args.includes('--value') ? record.MainPID : Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
    },
    processEvidence(pid) {
      return { pid, start_token: processStartToken(pid), executable: fs.realpathSync(`/proc/${pid}/exe`),
        executable_sha256: fileSha256(`/proc/${pid}/exe`), argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
    },
    processUnchanged(proc) { return processStartToken(proc.pid) === proc.start_token; },
  };
  const units = captureLegacyServices(config, dependencies);
  config.legacyInventoryPath = path.join(root, 'l1-step6-inventory.json');
  durableJson(config.legacyInventoryPath, { schema_version: 'ao.legacy-adoption-inventory.v1', namespace: config.namespace, units });
  config.legacyInventorySha256 = fileSha256(config.legacyInventoryPath);
  return { root, config, dependencies, records, script };
}

it('adopts an exact legacy unit/ExecStart SHA256/cmdline match without requiring new-style AO environment', async () => {
  const { config, dependencies } = await fixture();
  const evidence = collectLegacyAdoption(config, dependencies);
  expect(evidence.units[2].process.cmdline).toHaveLength(2);
  expect(evidence.units[2].exec_start.files).toHaveLength(2); // Node + script
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).not.toThrow();
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
  const { config, dependencies, records } = await fixture(); const evidence = collectLegacyAdoption(config, dependencies);
  records[`${config.namespace}-dashboard-adapter.service`].MainPID = '0';
  expect(() => assertLegacyAdoption(config, evidence, dependencies)).toThrow();
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
