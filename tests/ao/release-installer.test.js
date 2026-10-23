import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from '@jest/globals';
import { acquireInstallLock } from '../../scripts/ao/lib/release-lock.js';
import { applyRelease, readReleasePointer } from '../../scripts/ao/lib/release-installer.js';
import { readJson, durableJson, fileSha256 } from '../../scripts/ao/lib/release-manifest.js';
import { fixtureRoot, createBundle, configuration, fakeRunner } from './release-fixture.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fixtureRoot(); roots.push(root); return { root, config: configuration(root) }; }
const apply = (bundle, config, runner, extra = {}) => applyRelease({ bundle: bundle.bundle, expectedEnvelopeSha256: bundle.envelopeSha, configuration: config, runner, ...extra });

describe('unified release transaction on real temporary filesystem with fake services', () => {
  it('installs all components, pins CLI/current, and supports new -> old -> new', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0', commit: 'c'.repeat(40), native: '#!/bin/sh\nexit 0 #new\n' });
    const runner = fakeRunner(root);
    expect(await apply(old, config, runner)).toMatchObject({ phase: 'committed', result: 'passed' });
    expect(await apply(next, config, runner)).toMatchObject({ release_id: next.manifest.release_id });
    expect(readReleasePointer(config.installRoot, 'previous')).toBe(`releases/${old.manifest.release_id}`);
    expect(await apply(old, config, runner)).toMatchObject({ result: 'passed' });
    expect(await apply(next, config, runner)).toMatchObject({ result: 'passed' });
    expect(fs.realpathSync(config.cliPath)).toBe(path.join(config.installRoot, 'releases', next.manifest.release_id, 'bin/ao-pilot.js'));
    const journal = readJson(path.join(config.installRoot, 'install-journal.json'));
    const privateFile = path.join(config.installRoot, 'transactions', journal.transaction_id, 'private-receipt.json');
    expect(fs.statSync(privateFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(config.unitRoot, 'ao-pilot-staging-fixture-runtime.service'), 'utf8')).toContain('KillMode=mixed');
    expect(runner.calls).toContain('backup');
  });
  it('retries the same version after a partial build/install failure', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
    await expect(apply(bundle, config, runner, { inject: (stage) => { if (stage === 'partial') throw Error('injected copy failure'); } })).rejects.toThrow('injected');
    expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
    expect(await apply(bundle, config, runner)).toMatchObject({ result: 'passed' });
  });
  it('never deletes an unknown partial directory', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    const partial = path.join(config.installRoot, 'releases', `${bundle.manifest.release_id}.partial`);
    fs.mkdirSync(partial, { recursive: true }); fs.writeFileSync(path.join(partial, 'unknown'), 'preserve');
    await expect(apply(bundle, config, fakeRunner(root))).rejects.toMatchObject({ code: 'unknown_partial_owner' });
    expect(fs.readFileSync(path.join(partial, 'unknown'), 'utf8')).toBe('preserve');
  });
  it('commits before GC, and a GC failure never rolls back a valid new installation', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0' }); const runner = fakeRunner(root);
    await apply(old, config, runner);
    const receipt = await apply(next, config, runner, { inject: (stage) => {
      if (stage === 'gc') {
        expect(readJson(path.join(config.installRoot, 'install-journal.json')).phase).toBe('committed');
        throw Error('secret /private/path 192.168.8.8 PID=42');
      }
    } });
    expect(receipt).toMatchObject({ result: 'passed', failure_code: 'gc_warning', warning_count: 1 });
    expect(readReleasePointer(config.installRoot, 'current')).toBe(`releases/${next.manifest.release_id}`);
    expect(JSON.stringify(receipt)).not.toMatch(/private\/path|192\.168|PID/);
  });
  it.each(['previous', 'current'])('recovers the journal after a crash following %s pointer publication', async (stage) => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0' }); const runner = fakeRunner(root);
    await apply(old, config, runner);
    await expect(apply(next, config, runner, { inject: (point) => {
      if (point === stage) throw Object.assign(Error('simulated crash'), { simulatedCrash: true });
    } })).rejects.toThrow('simulated crash');
    await expect(apply(next, config, runner)).rejects.toMatchObject({ code: 'interrupted_install_requires_resume' });
    expect(await apply(next, config, runner, { resume: true })).toMatchObject({ result: 'passed' });
    expect(readReleasePointer(config.installRoot, 'previous')).toBe(`releases/${old.manifest.release_id}`);
  });
  it('rolls back units and current after verify failure when the old schema is compatible', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0' });
    await apply(old, config, fakeRunner(root));
    const unit = path.join(config.unitRoot, 'ao-pilot-staging-fixture-runtime.service'); const oldUnit = fs.readFileSync(unit, 'utf8');
    await expect(apply(next, config, fakeRunner(root, { onObserve: (observation) => observation.services.daemon.release_id === next.manifest.release_id ? ({ ...observation, ready: { health: 'ok', state: 'degraded', reasons: ['injected'] } }) : observation }))).rejects.toMatchObject({ code: 'install_verify_failed' });
    expect(readReleasePointer(config.installRoot, 'current')).toBe(`releases/${old.manifest.release_id}`);
    expect(readJson(path.join(config.installRoot, 'install-journal.json')).phase).toBe('rolled_back');
    expect(fs.readFileSync(unit, 'utf8')).toBe(oldUnit);
  });
  it('restores legacy CLI and environment after first-install failure without restarting unowned services', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    const legacy = path.join(root, 'legacy-cli'); fs.writeFileSync(legacy, 'legacy');
    fs.mkdirSync(path.dirname(config.cliPath), { recursive: true }); fs.symlinkSync(legacy, config.cliPath); config.legacyCliTarget = legacy;
    fs.mkdirSync(config.installRoot, { recursive: true });
    const priorFiles = [path.join(config.stateRoot, 'install.env'), path.join(config.installRoot, 'installation.json'), path.join(config.stateRoot, 'dashboard-adapter.json')];
    priorFiles.forEach((file, index) => fs.writeFileSync(file, `old-${index}`, { mode: 0o600 }));
    const runner = fakeRunner(root, { onObserve: (observation) => ({ ...observation, terminal_auth: false }) });
    await expect(apply(bundle, config, runner)).rejects.toMatchObject({ publicReceipt: { result: 'hold' } });
    expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
    expect(fs.readlinkSync(config.cliPath)).toBe(legacy);
    priorFiles.forEach((file, index) => expect(fs.readFileSync(file, 'utf8')).toBe(`old-${index}`));
    expect(runner.calls.filter((call) => call === 'start')).toHaveLength(1);
    expect(readJson(path.join(config.installRoot, 'install-journal.json'))).toMatchObject({ phase: 'recovery_required', rollback_error: { code: 'legacy_restore_requires_manual_start' } });
  });
  it('removes first-install generated environment and CLI on failure', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    await expect(apply(bundle, config, fakeRunner(root, { onObserve: (observation) => ({ ...observation, terminal_auth: false }) }))).rejects.toThrow();
    for (const file of [config.cliPath, path.join(config.stateRoot, 'install.env'), path.join(config.installRoot, 'installation.json'), path.join(config.stateRoot, 'dashboard-adapter.json')]) {
      expect(() => fs.lstatSync(file)).toThrow();
    }
  });
  it('keeps every original unit untouched if a drop-in backup cannot be validated', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    const unit = path.join(config.unitRoot, 'ao-pilot-staging-fixture-runtime.service');
    fs.mkdirSync(`${unit}.d`, { recursive: true }); fs.writeFileSync(unit, 'original unit');
    fs.symlinkSync('/missing-private-fixture', path.join(`${unit}.d`, '99-hotfix.conf'));
    await expect(apply(bundle, config, fakeRunner(root))).rejects.toThrow();
    expect(fs.readFileSync(unit, 'utf8')).toBe('original unit');
    expect(fs.readlinkSync(path.join(`${unit}.d`, '99-hotfix.conf'))).toBe('/missing-private-fixture');
    expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
  });
  it('records stop intent before effects and takes the DB backup only after final stopped CID snapshot', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
    const originalStop = runner.stop;
    runner.stop = async () => { expect(readJson(path.join(config.installRoot, 'install-journal.json')).service_mutation_started).toBe(true); return originalStop(); };
    await apply(bundle, config, runner);
    expect(runner.calls.indexOf('stop')).toBeLessThan(runner.calls.indexOf('quiescent'));
    expect(runner.calls.indexOf('quiescent')).toBeLessThan(runner.calls.indexOf('backup'));
  });
  it('holds for rebaseline if CID membership changes before all writers stop', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
    runner.quiescent = async () => ({ cids: ['new-cid'], database: { schema: 43, integrity: 'ok' } });
    await expect(apply(bundle, config, runner)).rejects.toMatchObject({ code: 'install_baseline_changed', publicReceipt: { result: 'hold' } });
    expect(runner.calls).not.toContain('backup'); expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
  });
  it('restores already-stopped old services when post-stop backup fails', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0' });
    await apply(old, config, fakeRunner(root)); const runner = fakeRunner(root);
    runner.backupDatabase = async () => { throw Error('injected backup failure'); };
    await expect(apply(next, config, runner)).rejects.toThrow('injected backup failure');
    expect(runner.calls).toContain('start'); expect(readReleasePointer(config.installRoot, 'current')).toBe(`releases/${old.manifest.release_id}`);
    expect(readJson(path.join(config.installRoot, 'install-journal.json')).phase).toBe('rolled_back');
  });
  it.each(['unit', 'drop-in'])('preserves dangling %s symlinks and cannot write outside the transaction namespace', async (kind) => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    fs.mkdirSync(config.unitRoot, { recursive: true }); const external = path.join(root, 'external-unowned');
    const unit = path.join(config.unitRoot, 'ao-pilot-staging-fixture-runtime.service');
    const link = kind === 'unit' ? unit : `${unit}.d`; fs.symlinkSync(external, link);
    await expect(apply(bundle, config, fakeRunner(root))).rejects.toMatchObject({ code: 'unsafe_unit_override' });
    expect(fs.readlinkSync(link)).toBe(external); expect(fs.existsSync(external)).toBe(false);
    expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
  });
  it('holds on incompatible rollback without explicit backup restoration authority', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0', schema: 44 });
    await apply(old, config, fakeRunner(root));
    const runner = fakeRunner(root, { onObserve: (observation) => ({ ...observation, terminal_auth: false }) });
    await expect(apply(next, config, runner)).rejects.toMatchObject({ publicReceipt: { result: 'hold', failure_code: 'rollback_required' } });
    expect(runner.calls).not.toContain('restore_database');
    expect(readJson(path.join(config.installRoot, 'install-journal.json')).phase).toBe('recovery_required');
  });
  it('restores previous plus the pre-migration backup when explicitly allowed', async () => {
    const { root, config } = fixture(); const old = createBundle(root); const next = createBundle(root, { version: '2.0.0', schema: 44 });
    await apply(old, config, fakeRunner(root));
    const runner = fakeRunner(root, { onObserve: (observation) => ({ ...observation, terminal_auth: false }) });
    await expect(apply(next, config, runner, { allowDatabaseRestore: true })).rejects.toMatchObject({ code: 'install_verify_failed' });
    expect(runner.calls).toContain('restore_database');
    expect(readReleasePointer(config.installRoot, 'current')).toBe(`releases/${old.manifest.release_id}`);
  });
  it('rejects a service identity that changes between verify and readback', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root); let count = 0;
    const runner = fakeRunner(root, { onObserve: (observation) => {
      if (++count === 2) observation.services.daemon.start_token = 'new incarnation during readback'; return observation;
    } });
    await expect(apply(bundle, config, runner)).rejects.toMatchObject({ code: 'install_identity_changed' });
    expect(readJson(path.join(config.installRoot, 'install-journal.json')).phase).not.toBe('committed');
  });
  it('rejects tampered pack-once bytes before touching current or services', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root); const runner = fakeRunner(root);
    fs.appendFileSync(path.join(bundle.bundle, 'package.tgz'), 'tampered');
    await expect(apply(bundle, config, runner)).rejects.toMatchObject({ code: 'release_package_digest_mismatch' });
    expect(runner.calls).toEqual([]); expect(readReleasePointer(config.installRoot, 'current')).toBeNull();
  });
  it('backs up hotfix drop-ins before replacing them with at most one environment override', async () => {
    const { root, config } = fixture(); const bundle = createBundle(root);
    const drops = path.join(config.unitRoot, 'ao-pilot-staging-fixture-runtime.service.d'); fs.mkdirSync(drops, { recursive: true });
    const hotfix = '[Service]\nExecStart=\nExecStart=/old/private/binary\n'; fs.writeFileSync(path.join(drops, '99-hotfix.conf'), hotfix);
    config.environmentOverride = '[Service]\nEnvironment="AO_DASHBOARD_AUTOMATION=0"\n';
    await apply(bundle, config, fakeRunner(root));
    const journal = readJson(path.join(config.installRoot, 'install-journal.json'));
    const backup = path.join(config.installRoot, 'transactions', journal.transaction_id, 'units/ao-pilot-staging-fixture-runtime.service.d/99-hotfix.conf');
    expect(fs.readFileSync(backup, 'utf8')).toBe(hotfix);
    expect(fs.readdirSync(drops)).toEqual(['10-environment.conf']);
  });
});

describe('kernel installation lock with permanent inode', () => {
  it('excludes an independent installer process and keeps the inode across release', () => {
    const { root } = fixture(); const lock = acquireInstallLock(root); const inode = fs.statSync(path.join(root, '.install.lock')).ino;
    const module = new URL('../../scripts/ao/lib/release-lock.js', import.meta.url).href;
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import {acquireInstallLock} from ${JSON.stringify(module)}; try {const lock=acquireInstallLock(process.argv[1]);lock.release();process.exit(9);} catch(e){process.exit(e.code==='install_lock_busy'?0:3);}`, root], { encoding: 'utf8' });
    expect(probe.status).toBe(0); lock.release();
    const successor = acquireInstallLock(root); expect(successor.owner.nonce).not.toBe(lock.owner.nonce); successor.release();
    expect(fs.statSync(path.join(root, '.install.lock')).ino).toBe(inode);
  });
  it('fences a writer whose owner metadata was replaced and never removes the successor owner', () => {
    const { root } = fixture(); const lock = acquireInstallLock(root); const owner = path.join(root, '.install-owner.json');
    durableJson(owner, { ...lock.owner, nonce: 'unknown-successor' });
    expect(() => lock.assertOwned()).toThrow('install_lock_lost'); expect(() => lock.release()).toThrow('install_lock_lost');
    expect(readJson(owner).nonce).toBe('unknown-successor');
  });
});
