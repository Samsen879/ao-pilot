#!/usr/bin/env node
// External fixture only. The verifier never installs or starts user units.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStartToken } from '../ao/lib/release-lock.js';

export function hostedFixtureNamespace(env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted'
    || env.GITHUB_REPOSITORY !== 'Samsen879/ao-pilot'
    || !/^[0-9]+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[0-9]+$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) throw new Error('Fixture requires this repository on an ephemeral GitHub-hosted runner');
  const socket = `ao-pilot-staging-fresh-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  return { socket, unit: `${socket}-tmux.service` };
}

export function runFixture(operation, inherited = process.env) {
  const { socket, unit } = hostedFixtureNamespace(inherited);
  if (!['prepare', 'cleanup'].includes(operation) || !path.isAbsolute(inherited.RUNNER_TEMP ?? '')
    || !path.isAbsolute(inherited.GITHUB_WORKSPACE ?? '')) throw new Error('Invalid fixture operation or workspace');
  process.umask(0o077);
  const root = path.join(fs.realpathSync(inherited.RUNNER_TEMP), 'ao-fresh-tmux');
  const ownerFile = path.join(root, 'owner.json'), tmpdir = path.join(root, 'tmux');
  const uid = process.getuid(), bus = `unix:path=/run/user/${uid}/bus`;
  const env = { ...inherited, XDG_RUNTIME_DIR: `/run/user/${uid}`, DBUS_SESSION_BUS_ADDRESS: bus };
  const run = (command, args, allowed = [0]) => {
    const p = spawnSync(command, args, { env, encoding: 'utf8', timeout: 30000 });
    if (p.error || !allowed.includes(p.status)) throw new Error(`Fixture ${command} failed: ${p.error?.message ?? p.stderr}`);
    return p.stdout.trim();
  };
  const info = () => Object.fromEntries(run('/usr/bin/systemctl', ['--user', 'show', unit,
    '--property=LoadState,ActiveState,MainPID,ControlGroup'], [0, 4]).split('\n').filter(line => line.includes('=')).map(line => line.split(/=(.*)/s).slice(0, 2)));
  if (operation === 'prepare') {
    if (fs.existsSync(root)) throw new Error('Refusing existing fixture directory');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(tmpdir, { mode: 0o700 });
    const owner = { uid, unit, socket, created: false };
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    // This modifies only the ephemeral runner, never workstation/production systemd.
    run('/usr/bin/sudo', ['/usr/bin/loginctl', 'enable-linger', os.userInfo().username]);
    run('/usr/bin/sudo', ['/usr/bin/systemctl', 'start', `user@${uid}.service`]);
    const before = info();
    if (before.LoadState !== 'not-found' || Number(before.MainPID) !== 0) throw new Error('Refusing pre-existing fixture unit');
    run('/usr/bin/systemd-run', ['--user', '--collect', `--unit=${unit}`, '--property=Type=simple',
      '--property=KillMode=control-group', '--property=Restart=no', `--working-directory=${tmpdir}`,
      `--setenv=TMUX_TMPDIR=${tmpdir}`, `--setenv=HOME=${root}`, '/usr/bin/tmux', '-L', socket,
      '-f', path.join(inherited.GITHUB_WORKSPACE, 'templates/tmux/ao-pilot.conf'), '-D']);
    const current = info(), pid = Number(current.MainPID);
    if (current.ActiveState !== 'active' || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('Fixture unit did not start');
    owner.created = true; owner.pid = pid; owner.start_token = processStartToken(pid);
    fs.writeFileSync(ownerFile, JSON.stringify(owner));
    fs.writeFileSync(path.join(root, 'fixture.json'), JSON.stringify({ schema_version: 'ao.fresh-managed-tmux-fixture.v1',
      unit, socket, tmpdir, dbus_address: bus }));
    return { status: 'prepared' };
  }
  if (!fs.existsSync(root)) return { status: 'not_created' };
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) throw new Error('Unknown fixture directory owner');
  const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  if (owner.uid !== uid || owner.unit !== unit || owner.socket !== socket) throw new Error('Fixture owner mismatch');
  if (!owner.created) return { status: 'uncommitted_fixture_preserved' };
  if (owner.created) {
    const current = info();
    if (current.LoadState !== 'not-found' && Number(current.MainPID) > 0) {
      if (Number(current.MainPID) !== owner.pid || processStartToken(owner.pid) !== owner.start_token) throw new Error('Fixture process identity changed');
      run('/usr/bin/systemctl', ['--user', 'stop', unit]);
    }
    try { if (processStartToken(owner.pid) === owner.start_token) throw new Error('Fixture process still alive'); }
    catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  fs.rmSync(root, { recursive: true });
  return { status: 'cleaned' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runFixture(process.argv[2]))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
