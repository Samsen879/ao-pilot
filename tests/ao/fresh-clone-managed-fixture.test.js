import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { isolatedEnvironment, loadManagedTmuxFixture, parseArgs, verifyFreshClone } from '../../scripts/verify-fresh-clone.js';
import { hostedFixtureNamespace } from '../../scripts/ci/fresh-clone-tmux-fixture.js';
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fixture-contract-')); roots.push(base);
  const root = path.join(base, 'ao-fresh-tmux'), tmpdir = path.join(root, 'tmux');
  fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(tmpdir, { mode: 0o700 });
  const file = path.join(root, 'fixture.json');
  const value = { schema_version: 'ao.fresh-managed-tmux-fixture.v1', unit: 'ao-pilot-staging-fresh-123-1-tmux.service',
    socket: 'ao-pilot-staging-fresh-123-1', tmpdir, dbus_address: `unix:path=/run/user/${process.getuid()}/bus` };
  const save = () => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); save();
  return { base, root, file, value, save };
}
it('accepts an explicit private fixture without substituting inherited production bindings', () => {
  const f = fixture(); expect(loadManagedTmuxFixture(f.file, f.base)).toEqual(f.value);
  expect(parseArgs(['--managed-tmux-fixture', f.file]).managedTmuxFixture).toBe(f.file);
});
it('connects only the explicit fixture to the CI user manager while keeping daemon data private', () => {
  const f = fixture(), root = path.join(f.base, 'daemon');
  const inherited = { XDG_RUNTIME_DIR: '/production/runtime', AO_DATA_DIR: '/production/data', AO_RUN_FILE: '/production/discovery' };
  const env = isolatedEnvironment(root, '/safe/bin', path.join(root, 'cache'), inherited, loadManagedTmuxFixture(f.file, f.base));
  expect(env.XDG_RUNTIME_DIR).toBe(`/run/user/${process.getuid()}`);
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(f.value.dbus_address);
  expect(env.HOME).toBe(path.join(root, 'home'));
  expect(env.AO_DATA_DIR).toBe(path.join(root, 'native-data'));
  expect(env.AO_RUN_FILE).toBe(path.join(root, 'discovery/running.json'));
  expect(env.TMUX_TMPDIR).toBe(f.value.tmpdir);
  const ordinary = isolatedEnvironment(root, '/safe/bin', path.join(root, 'cache'), inherited);
  expect(ordinary.XDG_RUNTIME_DIR).toBe(path.join(root, 'xdg-runtime'));
  expect(ordinary.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
});
it.each(['unit', 'socket', 'tmpdir', 'dbus_address'])('rejects mismatched or production %s', key => {
  const f = fixture(); f.value[key] = { unit: 'ao-pilot-tmux.service', socket: 'default', tmpdir: '/production/tmux', dbus_address: 'tcp:host=127.0.0.1,port=1234' }[key]; f.save();
  if (key === 'unit') { f.value.socket = 'ao-pilot'; f.save(); }
  expect(() => loadManagedTmuxFixture(f.file, f.base)).toThrow();
});
it('rejects extra fields, shared file identity and unsafe fixture file permissions', () => {
  const f = fixture(); f.value.ExecStart = '/unexpected'; f.save(); expect(() => loadManagedTmuxFixture(f.file, f.base)).toThrow();
  delete f.value.ExecStart; f.save(); fs.linkSync(f.file, path.join(f.root, 'alias')); expect(() => loadManagedTmuxFixture(f.file, f.base)).toThrow();
  fs.unlinkSync(path.join(f.root, 'alias')); fs.chmodSync(f.file, 0o644); expect(() => loadManagedTmuxFixture(f.file, f.base)).toThrow();
});
it('rejects symlinked fixture directories', () => {
  const f = fixture(); fs.renameSync(path.join(f.root, 'tmux'), path.join(f.root, 'real')); fs.symlinkSync(path.join(f.root, 'real'), path.join(f.root, 'tmux'));
  expect(() => loadManagedTmuxFixture(f.file, f.base)).toThrow();
});
it('fails before starting a source lifecycle with no fixture', async () => {
  const options = parseArgs([]); options.tarball = null; options.releasePayload = null;
  await expect(verifyFreshClone(options)).rejects.toMatchObject({ code: 'fresh_clone_managed_tmux_fixture_required' });
});
it('does not let a source fixture override a separately bound packed namespace', async () => {
  const options = parseArgs(['--tarball', '/abs/package.tgz', '--release-payload', '/abs/payload', '--managed-tmux-fixture', '/abs/fixture.json']);
  await expect(verifyFreshClone(options)).rejects.toMatchObject({ code: 'fresh_clone_fixture_conflict' });
});
it('cannot run fixture provisioning on a workstation or a self-hosted runner', () => {
  expect(() => hostedFixtureNamespace({})).toThrow();
  const valid = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Samsen879/ao-pilot', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  for (const delta of [{ GITHUB_ACTIONS: 'false' }, { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REPOSITORY: 'another/repo' }, { GITHUB_RUN_ID: '123;unexpected' }]) expect(() => hostedFixtureNamespace({ ...valid, ...delta })).toThrow();
  expect(hostedFixtureNamespace(valid).unit).toBe('ao-pilot-staging-fresh-123-1-tmux.service');
});
