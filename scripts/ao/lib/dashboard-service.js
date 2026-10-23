import path from 'node:path';
import fs from 'node:fs';
import { renderReleaseUnits } from './release-units.js';
export function buildDashboardUnits({ installRoot = null, stateRoot = null, envFile = null, namespace = 'ao-pilot', packageRoot, nodePath, home, managedRuntimeBinary = null, managedRuntimeBinarySha256 = null, managedRuntimeStore = null, terminalAccess = false }) {
  if (installRoot) return renderReleaseUnits({ installRoot, stateRoot, envFile, nodePath, namespace });
  // Legacy read-only renderer remains for inspecting old receipts. New writes
  // exclusively use release-installer and the unified templates.
  for (const value of [packageRoot, nodePath, home, managedRuntimeBinary, managedRuntimeStore].filter(Boolean)) {
    if (!path.isAbsolute(value) || /[\r\n\x00"%\\]/.test(value)) throw new Error('Unsafe service path');
  }
  if (new Set([managedRuntimeBinary,managedRuntimeBinarySha256,managedRuntimeStore].map(value => value == null)).size !== 1
    || (managedRuntimeBinarySha256 != null && !/^[a-f0-9]{64}$/.test(managedRuntimeBinarySha256))) {
    throw new Error('Invalid managed runtime identity binding');
  }
  const base = path.join(home, '.local/share/ao-pilot/cie-runtime');
  const command = script => `"${nodePath}" "${path.join(packageRoot, 'scripts', script)}"`;
  const common = `WorkingDirectory=${packageRoot}\nEnvironment="PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin"\nEnvironment="AO_DATA_DIR=${base}/data"\nEnvironment="AO_RUN_FILE=${base}/running.json"\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nUMask=0077\n`;
  const terminalEnvironment = `Environment="AO_DASHBOARD_TERMINAL_ACCESS=${terminalAccess ? '1' : '0'}"\n`;
  const runtimeEnvironment = managedRuntimeBinary == null
    ? `Environment="XDG_DATA_HOME=${path.join(home, '.local/share')}"\n`
    : `Environment="AO_PILOT_RUNTIME_STORE=${managedRuntimeStore}"\nEnvironment="AO_MANAGED_RUNTIME_BINARY=${managedRuntimeBinary}"\nEnvironment="AO_MANAGED_RUNTIME_BINARY_SHA256=${managedRuntimeBinarySha256}"\nEnvironment="AO_MANAGED_RUNTIME_DATA_DIR=${base}/data"\nEnvironment="AO_MANAGED_RUNTIME_RUN_FILE=${base}/running.json"\n`;
  const values = {
    COMMON: common, RUNTIME_ENVIRONMENT: runtimeEnvironment, TERMINAL_ENVIRONMENT: terminalEnvironment,
    HOME: home, COMMAND_RUNTIME: command('ao-runtime-foreground.js'),
    COMMAND_DASHBOARD: command('ao-dashboard.js'), COMMAND_RECOVERY: command('ao-session.js'),
  };
  return Object.fromEntries(['runtime', 'dashboard', 'session-recovery'].map((name) => {
    const file = `ao-pilot-${name}.service`;
    let body = fs.readFileSync(new URL(`../../../templates/systemd/legacy/${file}`, import.meta.url), 'utf8');
    for (const [key, value] of Object.entries(values)) body = body.replaceAll(`{{${key}}}`, value);
    return [file, body];
  }));
}
