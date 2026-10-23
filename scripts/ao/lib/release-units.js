import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertRelease, fileSha256, durableJson, readJson, syncDirectory, syncTree } from './release-manifest.js';

const TEMPLATE_ROOT = fileURLToPath(new URL('../../../templates/systemd/', import.meta.url));
export const RELEASE_SERVICES = ['tmux', 'runtime', 'dashboard', 'session-recovery', 'adapter'];
export const ALLOWED_ENVIRONMENT = new Set([
  'AO_DASHBOARD_ADAPTER_CONFIG', 'DIRECT_TERMINAL_PORT', 'TERMINAL_PORT', 'AO_MANAGED_RUNTIME_BINARY', 'AO_MANAGED_RUNTIME_BINARY_SHA256', 'AO_HOST', 'AO_PORT', 'AO_DASHBOARD_PORT', 'AO_INSTALL_ROOT', 'AO_DATA_DIR', 'AO_RUN_FILE', 'AO_MANAGED_RUNTIME_DATA_DIR',
  'AO_MANAGED_RUNTIME_RUN_FILE', 'AO_TMUX_SOCKET', 'AO_TMUX_UNIT', 'AO_TMUX_TMPDIR', 'TMUX_TMPDIR',
  'AO_CONFIG_PATH', 'AO_PILOT_RUNTIME_STORE', 'AO_DASHBOARD_TERMINAL_ACCESS', 'AO_DASHBOARD_READ_ONLY',
  'AO_DASHBOARD_AUTOMATION', 'AO_INSTALL_NAMESPACE', 'AO_INSTALL_CONFIG', 'PATH', 'NODE_ENV',
]);
function safe(value) {
  assertRelease(typeof value === 'string' && value !== '' && !/[\r\n\0"%\\]/.test(value), 'unsafe_unit_value');
  return value;
}
export function validateEnvironmentOverride(text) {
  const assignments = {};
  let section = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    if (line === '[Service]' && section === null) { section = 'Service'; continue; }
    const match = line.match(/^Environment="([A-Z_][A-Z_0-9]*)=([^"\\\n\r]*)"$/);
    assertRelease(section === 'Service' && match && ALLOWED_ENVIRONMENT.has(match[1])
      && !Object.hasOwn(assignments, match[1]), 'unsafe_unit_override');
    assignments[match[1]] = safe(match[2]);
  }
  return assignments;
}
export function renderReleaseUnits({ installRoot, stateRoot, envFile, nodePath, namespace = 'ao-pilot' }) {
  assertRelease(/^ao-pilot(?:-staging-[a-z0-9-]+)?$/.test(namespace), 'unsafe_unit_namespace');
  const substitutions = { CURRENT: path.join(installRoot, 'current'), STATE_ROOT: stateRoot,
    ENV_FILE: envFile, NODE: nodePath, TMUX_UNIT: `${namespace}-tmux.service`, RUNTIME_UNIT: `${namespace}-runtime.service` };
  for (const value of Object.values(substitutions)) safe(value);
  return Object.fromEntries(RELEASE_SERVICES.map((component) => {
    let body = fs.readFileSync(path.join(TEMPLATE_ROOT, `ao-pilot-${component === 'adapter' ? 'dashboard-adapter' : component}.service`), 'utf8');
    for (const [key, value] of Object.entries(substitutions)) body = body.replaceAll(`{{${key}}}`, value);
    assertRelease(!body.includes('{{'), 'invalid_unit_template');
    return [`${namespace}-${component === 'adapter' ? 'dashboard-adapter' : component}.service`, body];
  }));
}
function existing(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function assertWritableUnitPaths(unit, drops) {
  const unitStat = existing(unit); const dropsStat = existing(drops);
  assertRelease(!unitStat || unitStat.isFile() && !unitStat.isSymbolicLink(), 'unsafe_unit_override');
  assertRelease(!dropsStat || dropsStat.isDirectory() && !dropsStat.isSymbolicLink(), 'unsafe_unit_override');
}
export function writeReleaseUnits({ unitRoot, units, lock, environmentOverride = null }) {
  if (environmentOverride !== null) validateEnvironmentOverride(environmentOverride);
  for (const [name, body] of Object.entries(units)) {
    lock.assertOwned();
    const unit = path.join(unitRoot, name); const drops = `${unit}.d`;
    assertWritableUnitPaths(unit, drops);
    if (existing(drops)) fs.rmSync(drops, { recursive: true });
    const temporary = `${unit}.tmp-${randomUUID()}`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    lock.assertOwned(); fs.renameSync(temporary, unit); syncDirectory(unitRoot);
    if (environmentOverride) {
      fs.mkdirSync(drops, { mode: 0o700 });
      fs.writeFileSync(path.join(drops, '10-environment.conf'), environmentOverride, { mode: 0o600 });
    }
  }
}
export function backupAndInstallUnits({ unitRoot, backupRoot, units, lock, environmentOverride = null, onBackup = () => {} }) {
  lock.assertOwned(); fs.mkdirSync(unitRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  if (environmentOverride !== null) validateEnvironmentOverride(environmentOverride);
  const entries = [];
  for (const name of Object.keys(units)) {
    assertRelease(/^ao-pilot(?:-staging-[a-z0-9-]+)?-(tmux|runtime|dashboard|session-recovery|dashboard-adapter)\.service$/.test(name), 'unsafe_unit_namespace');
    const unit = path.join(unitRoot, name); const drops = `${unit}.d`;
    assertWritableUnitPaths(unit, drops);
    for (const target of [unit, drops]) if (existing(target)) {
      assertRelease(!fs.lstatSync(target).isSymbolicLink(), 'unsafe_unit_override');
      const destination = path.join(backupRoot, path.basename(target));
      fs.cpSync(target, destination, { recursive: true, dereference: false, verbatimSymlinks: true });
      if (target === unit) entries.push({ file: name, sha256: fileSha256(target), mode: fs.statSync(target).mode & 0o777 });
      else for (const file of fs.readdirSync(target)) {
        assertRelease(file.endsWith('.conf') && fs.lstatSync(path.join(target, file)).isFile(), 'unsafe_unit_override');
        entries.push({ file: `${name}.d/${file}`, sha256: fileSha256(path.join(target, file)), mode: fs.statSync(path.join(target, file)).mode & 0o777 });
      }
    }
  }
  // The complete backup is durable before the first unit/drop-in mutation.
  syncTree(backupRoot);
  durableJson(path.join(backupRoot, 'backup.json'), entries);
  onBackup();
  writeReleaseUnits({ unitRoot, units, lock, environmentOverride });
  return entries;
}
export function restoreUnitBackup({ unitRoot, backupRoot, units, lock }) {
  lock.assertOwned();
  const entries = readJson(path.join(backupRoot, 'backup.json'));
  for (const entry of entries) assertRelease(fileSha256(path.join(backupRoot, entry.file)) === entry.sha256, 'unit_backup_digest_mismatch');
  for (const name of Object.keys(units)) {
    lock.assertOwned();
    for (const suffix of ['', '.d']) {
      const target = path.join(unitRoot, name + suffix); const saved = path.join(backupRoot, name + suffix);
      fs.rmSync(target, { force: true, recursive: true });
      if (fs.existsSync(saved)) fs.cpSync(saved, target, { recursive: true, verbatimSymlinks: true });
    }
  }
}
