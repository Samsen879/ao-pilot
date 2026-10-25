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

export function captureLegacyServices(config, { run, processEvidence, processUnchanged }) {
  return components.map((component) => {
    const unit = `${config.namespace}-${component}.service`;
    const p = properties(run('systemctl', ['--user', 'show', unit,
      '--property=Id,LoadState,MainPID,ExecStart,FragmentPath,DropInPaths,NeedDaemonReload,ControlGroup']));
    assertRelease(p.Id === unit && p.LoadState === 'loaded' && p.NeedDaemonReload === 'no'
      && p.FragmentPath === path.join(config.unitRoot, unit), code);
    const drops = p.DropInPaths ? p.DropInPaths.split(/\s+/) : [];
    assertRelease(drops.every((file) => path.dirname(file) === path.join(config.unitRoot, `${unit}.d`)), code);
    const execStart = legacyExecStart(p.ExecStart);
    const files = [p.FragmentPath, ...drops].map(fileIdentity);
    const pid = Number(p.MainPID); assertRelease(Number.isSafeInteger(pid) && pid >= 0, code);
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
      && Object.keys(inventory).sort().join(',') === 'namespace,schema_version,units'
      && Array.isArray(inventory.units) && inventory.units.length === components.length
      && inventory.units.every((record, index) => record.unit === `${config.namespace}-${components[index]}.service`), code);
    return { sha256: digest, units: inventory.units };
  } finally { fs.closeSync(fd); }
}
export function collectLegacyAdoption(config, dependencies) {
  const inventory = readLegacyInventory(config);
  const units = captureLegacyServices(config, dependencies);
  assertRelease(objectSha256(units) === objectSha256(inventory.units), code);
  return { inventory_sha256: inventory.sha256, units };
}
export function assertLegacyAdoption(config, evidence, dependencies, { stopped = false } = {}) {
  const inventory = readLegacyInventory(config);
  assertRelease(evidence?.inventory_sha256 === inventory.sha256
    && objectSha256(evidence.units) === objectSha256(inventory.units), code);
  const current = captureLegacyServices(config, dependencies);
  const expected = stopped ? evidence.units.map((unit) => ({ ...unit, process: null })) : evidence.units;
  assertRelease(objectSha256(current) === objectSha256(expected), code);
}
