import fs from 'node:fs';
import path from 'node:path';
import { assertRelease, fileSha256, objectSha256, sha256 } from './release-manifest.js';

const components = ['runtime', 'dashboard', 'dashboard-adapter', 'session-recovery'];
const code = 'install_legacy_adoption_mismatch';

function properties(text) {
  return Object.fromEntries(text.trim().split('\n').map((line) => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
}
function fileIdentity(file, { executableInput = false } = {}) {
  const stat = fs.lstatSync(file);
  const trustedOwner = stat.uid === process.getuid() || executableInput && stat.uid === 0;
  assertRelease(stat.isFile() && !stat.isSymbolicLink() && trustedOwner
    && (!executableInput || (stat.mode & 0o022) === 0), code);
  return { path: file, sha256: fileSha256(file) };
}

// Read the effective ExecStart, including historical reset/override drop-ins.
// Ambiguous systemd escaping or multiple commands are deliberately unsupported.
export function legacyExecStart(text) {
  const match = text.match(/^\{ path=([^ ;\\]+) ; argv\[\]=([^;\\]+) ; ignore_errors=(?:yes|no) ;[^{}]*\}$/);
  assertRelease(match && path.isAbsolute(match[1]), code);
  const argv = match[2].trim().split(/\s+/);
  assertRelease(argv[0] === match[1] && argv.every((arg) => !/["'\r\n\0]/.test(arg)), code);
  // Bind both interpreter and script when ExecStart invokes Node or a wrapper.
  const files = [...new Set(argv.filter((arg, index) => {
    if (index === 0) return true;
    if (!path.isAbsolute(arg)) return false;
    const stat = fs.lstatSync(arg);
    assertRelease(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), code);
    return stat.isFile();
  }))].map((file) => fileIdentity(file, { executableInput: true }));
  return { path: match[1], argv, files };
}

export function captureLegacyServices(config, { run, processEvidence, processUnchanged }, { offline = false } = {}) {
  return components.map((component) => {
    const unit = `${config.namespace}-${component}.service`;
    const p = properties(run('systemctl', ['--user', 'show', unit,
      `--property=Id,LoadState,MainPID,ExecStart,FragmentPath,DropInPaths,NeedDaemonReload,ControlGroup${offline ? ',ActiveState,SubState' : ''}`]));
    assertRelease(p.Id === unit && p.LoadState === 'loaded' && p.NeedDaemonReload === 'no'
      && p.FragmentPath === path.join(config.unitRoot, unit), code);
    const drops = p.DropInPaths ? p.DropInPaths.split(/\s+/) : [];
    assertRelease(drops.every((file) => path.dirname(file) === path.join(config.unitRoot, `${unit}.d`)), code);
    const execStart = legacyExecStart(p.ExecStart);
    const files = [p.FragmentPath, ...drops].map(fileIdentity);
    const pid = Number(p.MainPID); assertRelease(Number.isSafeInteger(pid) && pid >= 0, code);
    if (offline) assertRelease(pid === 0 && p.ActiveState === 'inactive' && p.SubState === 'dead'
      && !p.ControlGroup, code, `Offline adoption requires inactive legacy unit: ${unit}`);
    let process = null;
    if (pid > 0) {
      const proc = processEvidence(pid);
      assertRelease(proc.start_token && processUnchanged(proc)
        && JSON.stringify(proc.argv) === JSON.stringify(execStart.argv)
        && proc.executable === fs.realpathSync(execStart.path)
        && proc.executable_sha256 === execStart.files[0].sha256
        && p.ControlGroup && fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').split('\n').some((line) => line.split(':')[2] === p.ControlGroup), code);
      process = { pid, start_token: proc.start_token, cmdline: proc.argv,
        executable: proc.executable, executable_sha256: proc.executable_sha256 };
    }
    assertRelease(run('systemctl', ['--user', 'show', unit, '--property=MainPID', '--value']) === String(pid), code);
    return { unit, exec_start: execStart, unit_files: files, process };
  });
}

export function readLegacyInventory(config) {
  assertRelease(path.isAbsolute(config.legacyInventoryPath ?? '') && /^[a-f0-9]{64}$/.test(config.legacyInventorySha256 ?? ''), 'install_legacy_inventory_required');
  const fd = fs.openSync(config.legacyInventoryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assertRelease(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'install_legacy_inventory_required');
    const bytes = fs.readFileSync(fd);
    // Hash the bytes actually read, not a second path lookup.
    const digest = sha256(bytes);
    assertRelease(digest === config.legacyInventorySha256, code);
    const inventory = JSON.parse(bytes);
    assertRelease(inventory.schema_version === 'ao.legacy-adoption-inventory.v1' && inventory.namespace === config.namespace
      && Object.keys(inventory).sort().join(',') === 'namespace,schema_version,tmux,units'
      && Array.isArray(inventory.units) && inventory.units.length === components.length
      && inventory.units.every((record, index) => record.unit === `${config.namespace}-${components[index]}.service`), code);
    const tmux = inventory.tmux;
    assertRelease(tmux && Object.keys(tmux).sort().join(',') === 'executable_sha256,pid,session_names,socket,start_token,tmpdir'
      && /^[A-Za-z0-9_-]+$/.test(tmux.socket ?? '') && path.isAbsolute(tmux.tmpdir ?? '')
      && !/[\r\n\0]/.test(tmux.tmpdir) && Number.isSafeInteger(tmux.pid) && tmux.pid > 1
      && /^[0-9]+$/.test(tmux.start_token ?? '') && /^[a-f0-9]{64}$/.test(tmux.executable_sha256 ?? '')
      && Array.isArray(tmux.session_names) && tmux.session_names.every(name => /^[A-Za-z0-9_.-]+$/.test(name))
      && new Set(tmux.session_names).size === tmux.session_names.length, 'install_legacy_tmux_inventory_required');
    return { sha256: digest, units: inventory.units, tmux };
  } finally { fs.closeSync(fd); }
}
export function collectLegacyAdoption(config, dependencies, { offline = false } = {}) {
  const inventory = readLegacyInventory(config);
  const units = captureLegacyServices(config, dependencies, { offline });
  const expected = offline ? inventory.units.map(unit => ({ ...unit, process: null })) : inventory.units;
  assertRelease(objectSha256(units) === objectSha256(expected), code, 'Legacy unit/ExecStart/file/process evidence differs from inventory');
  if (offline) assertOfflineLegacyAbsent(inventory, dependencies);
  else assertLegacyTmux(inventory.tmux, dependencies);
  return { inventory_sha256: inventory.sha256, units, tmux: inventory.tmux, ...(offline ? { adoption_mode: 'offline' } : {}) };
}
function assertOfflineLegacyAbsent(inventory, dependencies) {
  assertRelease(inventory.units.every(unit => !unit.process || !dependencies.processUnchanged(unit.process))
    && !dependencies.processUnchanged(inventory.tmux), code, 'Recorded legacy process still exists');
  const socket = path.join(inventory.tmux.tmpdir, `tmux-${process.getuid()}`, inventory.tmux.socket);
  try { fs.lstatSync(socket); assertRelease(false, code, 'Offline adoption requires absent legacy tmux socket'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // -N is mandatory: this observation must never create a server.
  dependencies.run('tmux', ['-S', socket, '-N', 'display-message', '-p', '#{pid}'], { acceptedExitCodes: [1] });
  const rows = dependencies.run('ps', ['-u', String(process.getuid()), '-o', 'pid=']).split('\n').filter(row => row.trim());
  for (const row of rows) {
    assertRelease(/^\s*\d+\s*$/.test(row), code, 'Unknown process enumeration');
    let proc;
    try { proc = dependencies.processEntrypoint(Number(row), inventory.units); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    assertRelease(dependencies.processUnchanged(proc), code, 'Process changed during offline observation');
    if (proc.unrelated) continue;
    const matches = inventory.units.some(unit => {
      const scripts = unit.exec_start.files.slice(1).map(file => fs.realpathSync(file.path));
      if (!scripts.length) return proc.executable === fs.realpathSync(unit.exec_start.path);
      return proc.argv.slice(1).some(arg => {
        try { return scripts.includes(fs.realpathSync(path.resolve(proc.cwd, arg))); }
        catch (error) { if (['ENOENT', 'ENOTDIR', 'ENAMETOOLONG'].includes(error.code)) return false; throw error; }
      });
    });
    assertRelease(!matches, code, 'Legacy component is running outside its stopped unit');
  }
}
function assertLegacyTmux(tmux, dependencies, stopped = false) {
  const socket = path.join(tmux.tmpdir, `tmux-${process.getuid()}`, tmux.socket);
  if (stopped) {
    assertRelease(!dependencies.processUnchanged(tmux), code, 'Legacy tmux owner is still alive after stop');
    dependencies.run('tmux', ['-S', socket, '-N', 'display-message', '-p', '#{pid}'], { acceptedExitCodes: [1] });
    return;
  }
  const pid = Number(dependencies.run('tmux', ['-S', socket, '-N', 'display-message', '-p', '#{pid}']));
  assertRelease(pid === tmux.pid, code, 'Legacy tmux socket/PID changed');
  const proc = dependencies.processEvidence(pid);
  assertRelease(proc.start_token === tmux.start_token && proc.executable_sha256 === tmux.executable_sha256
    && dependencies.processUnchanged(proc), code, 'Legacy tmux process identity changed');
  const sessions = dependencies.run('tmux', ['-S', socket, '-N', 'list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean).sort();
  assertRelease(objectSha256(sessions) === objectSha256([...tmux.session_names].sort()), code, 'Legacy tmux session set changed');
}
export function assertLegacyAdoption(config, evidence, dependencies, { stopped = false } = {}) {
  const inventory = readLegacyInventory(config);
  const offline = evidence?.adoption_mode === 'offline';
  const recorded = offline ? inventory.units.map(unit => ({ ...unit, process: null })) : inventory.units;
  assertRelease(evidence?.inventory_sha256 === inventory.sha256
    && objectSha256(evidence.units) === objectSha256(recorded)
    && objectSha256(evidence.tmux) === objectSha256(inventory.tmux), code);
  const current = captureLegacyServices(config, dependencies, { offline });
  const expected = stopped ? evidence.units.map((unit) => ({ ...unit, process: null })) : evidence.units;
  assertRelease(objectSha256(current) === objectSha256(expected), code);
  if (offline) assertOfflineLegacyAbsent(inventory, dependencies);
  else assertLegacyTmux(inventory.tmux, dependencies, stopped);
}
