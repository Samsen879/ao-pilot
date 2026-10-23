import { readFileSync } from 'node:fs';

const keys = [
  'LISTEN_HOST', 'LISTEN_PORT', 'DASHBOARD_UPSTREAM_HOST', 'DASHBOARD_UPSTREAM_PORT',
  'AO_DAEMON_HOST', 'AO_DAEMON_PORT', 'DIRECT_TERMINAL_HOST', 'DIRECT_TERMINAL_PORT',
  'DIRECT_TERMINAL_BROWSER_PORT', 'TERMINAL_ORIGIN', 'PROJECT_NAME', 'ISSUE_BASE_URL',
];

// No machine-specific endpoint defaults. JSON uses the same keys as the environment.
export function loadConfig(env = process.env) {
  let values = {};
  if (env.AO_DASHBOARD_ADAPTER_CONFIG) {
    try { values = JSON.parse(readFileSync(env.AO_DASHBOARD_ADAPTER_CONFIG, 'utf8')); }
    catch { throw new Error('Cannot read AO_DASHBOARD_ADAPTER_CONFIG as JSON'); }
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).some(key => !keys.includes(key))) {
      throw new Error('Invalid adapter configuration keys');
    }
  }
  for (const key of keys) if (env[key] !== undefined) values[key] = env[key];
  const required = key => {
    if (typeof values[key] !== 'string' || !values[key].trim()) {
      throw new Error(`Set ${key} explicitly`);
    }
    return values[key].trim();
  };
  const host = key => {
    const value = required(key);
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid ${key}`);
    return value;
  };
  const port = (key, allowZero = false) => {
    const value = values[key];
    if (!/^[0-9]+$/.test(String(value ?? ''))) throw new Error(`Invalid ${key}`);
    const number = Number(value);
    if (!Number.isInteger(number) || number < (allowZero ? 0 : 1) || number > 65535) {
      throw new Error(`Invalid ${key}`);
    }
    return number;
  };
  const url = (key, originOnly = false) => {
    let parsed;
    try { parsed = new URL(required(key)); } catch { throw new Error(`Invalid ${key}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.search || parsed.hash || (originOnly && parsed.pathname !== '/')) {
      throw new Error(`Invalid ${key}`);
    }
    return originOnly ? parsed.origin : parsed.href.replace(/\/$/, '');
  };
  return {
    listenHost: host('LISTEN_HOST'), port: port('LISTEN_PORT', true),
    dashboardHost: host('DASHBOARD_UPSTREAM_HOST'), dashboardPort: port('DASHBOARD_UPSTREAM_PORT'),
    daemonHost: host('AO_DAEMON_HOST'), daemonPort: port('AO_DAEMON_PORT'),
    directTerminalHost: host('DIRECT_TERMINAL_HOST'), directTerminalPort: port('DIRECT_TERMINAL_PORT'),
    browserTerminalPort: values.DIRECT_TERMINAL_BROWSER_PORT === undefined
      ? port('DIRECT_TERMINAL_PORT') : port('DIRECT_TERMINAL_BROWSER_PORT'),
    terminalOrigin: url('TERMINAL_ORIGIN', true),
    projectName: String(values.PROJECT_NAME ?? ''),
    issueBaseUrl: values.ISSUE_BASE_URL ? url('ISSUE_BASE_URL') : null,
  };
}
