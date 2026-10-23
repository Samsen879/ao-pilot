import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assertRelease, fileSha256, readJson, verifyReleaseTree } from './release-manifest.js';
import { processStartToken } from './release-lock.js';
import { RELEASE_SERVICES, renderReleaseUnits, validateEnvironmentOverride } from './release-units.js';

export function validateInstallConfiguration(config) {
  assertRelease(config.schema_version === 'ao.install-config.v1' && process.platform === 'linux', 'invalid_install_configuration');
  assertRelease(/^ao-pilot(?:-staging-[a-z0-9-]+)?$/.test(config.namespace ?? ''), 'unsafe_unit_namespace');
  const names = ['installRoot', 'stateRoot', 'unitRoot', 'dataDir', 'discoveryDir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory', 'tmuxTmpdir'];
  for (const name of names) assertRelease(path.isAbsolute(config[name] ?? '') && !/[\r\n\0"%\\]/.test(config[name]), 'unsafe_install_configuration');
  assertRelease(new Set([config.installRoot, config.dataDir, config.discoveryDir, config.tmuxTmpdir]).size === 4, 'install_namespace_collision');
  assertRelease(/^[a-zA-Z0-9_-]+$/.test(config.tmuxSocket ?? '') && config.tmuxSocket !== 'default', 'invalid_tmux_namespace');
  for (const field of ['daemonURL', 'terminalURL', 'terminalOrigin']) {
    const url = new URL(config[field]);
    assertRelease(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && ['http:', 'ws:'].includes(url.protocol) && url.username === '' && url.password === '', 'non_loopback_install_endpoint');
  }
  assertRelease(config.terminalCanaryPrefix === 'canary:' && Array.isArray(config.listenPorts)
    && config.listenPorts.length >= 3 && new Set(config.listenPorts).size === config.listenPorts.length
    && config.listenPorts.every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535), 'invalid_install_ports');
  if (config.namespace.includes('-staging-')) {
    assertRelease(config.tmuxSocket.startsWith(config.namespace), 'install_namespace_collision');
    for (const name of ['dataDir', 'discoveryDir', 'tmuxTmpdir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory']) {
      assertRelease(path.resolve(config[name]).startsWith(`${path.resolve(config.stateRoot)}/`), 'install_namespace_collision');
    }
  }
  return config;
}
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  assertRelease(!result.error && result.status === 0, 'install_observation_failed', `Observation failed: ${command}`);
  return result.stdout.trim();
}
function envOf(pid) {
  return Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map((entry) => {
    const i = entry.indexOf('='); return [entry.slice(0, i), entry.slice(i + 1)];
  }));
}
function processEvidence(pid) {
  const token = processStartToken(pid);
  return { pid, start_token: token, executable: fs.realpathSync(`/proc/${pid}/exe`),
    argv: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean),
    cwd: fs.realpathSync(`/proc/${pid}/cwd`), environment: envOf(pid) };
}
function processUnchanged(evidence) {
  try { return processStartToken(evidence.pid) === evidence.start_token; } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error;
  }
}
export function probeExclusiveLock(file, { expectHeld, run = spawnSync } = {}) {
  // flock never deletes or rewrites the lock, and never waits for a held lock.
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const result = run('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
    if (result.error || ![0, 1].includes(result.status)) return null;
    return expectHeld ? result.status === 1 : result.status === 0;
  } finally { fs.closeSync(fd); }
}
export function controlLocksHaveStartTokens(root) {
  if (!fs.existsSync(root)) return true;
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).every((entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) return walk(file);
      if (!entry.name.endsWith('.lock')) return true;
      try { const owner = readJson(file); return typeof owner.process_start_token === 'string' && owner.process_start_token !== ''; } catch { return false; }
    });
  }
  return walk(root);
}
async function websocketResult(WebSocket, url, options, prefix, expectRejected) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, options);
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); socket.terminate(); resolve(value); };
    const timer = setTimeout(() => finish(false), 5000);
    socket.on('unexpected-response', (_request, response) => finish(expectRejected && [401, 403].includes(response.statusCode)));
    socket.on('open', () => { if (expectRejected) finish(false); });
    socket.on('message', (data) => { if (!expectRejected && data.toString('utf8').includes(prefix)) finish(true); });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
export function createSystemdReleaseRunner(rawConfiguration, { run = execute, fetchImpl = fetch } = {}) {
  const config = validateInstallConfiguration(rawConfiguration);
  const unitName = (name) => `${config.namespace}-${name}.service`;
  const systemctl = (args) => run('systemctl', ['--user', ...args]);
  const env = { ...process.env, AO_DATA_DIR: config.dataDir, AO_RUN_FILE: path.join(config.discoveryDir, 'running.json'),
    AO_TMUX_SOCKET: config.tmuxSocket, AO_TMUX_UNIT: unitName('tmux'), AO_TMUX_TMPDIR: config.tmuxTmpdir, TMUX_TMPDIR: config.tmuxTmpdir };
  const ownershipFiles = [path.join(config.dataDir, '.daemon-owner.lock'), path.join(config.discoveryDir, '.daemon-discovery.lock')];
  async function get(relative) {
    const response = await fetchImpl(new URL(relative, config.daemonURL), { signal: AbortSignal.timeout(5000) });
    assertRelease(response.ok, 'install_observation_failed'); return response.json();
  }
  async function observe({ releaseRoot }) {
    const manifest = verifyReleaseTree(releaseRoot);
    const observations = { services: {} };
    const collect = async (name, fn) => { try { observations[name] = await fn(); } catch { observations[name] = null; } };
    const expectedUnits = renderReleaseUnits({ installRoot: config.installRoot, stateRoot: config.stateRoot,
      envFile: path.join(config.stateRoot, 'install.env'), nodePath: manifest.toolchain.node_executable, namespace: config.namespace });
    for (const component of ['daemon', 'dashboard', 'adapter', 'session-recovery']) {
      try {
        const unit = unitName(component === 'daemon' ? 'runtime' : component);
        const properties = Object.fromEntries(systemctl(['show', unit, '--property=MainPID,ActiveState,ExecMainStartTimestampMonotonic,FragmentPath,DropInPaths,ControlGroup'])
          .split('\n').map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
        const pid = Number(properties.MainPID); assertRelease(properties.ActiveState === 'active' && pid > 0, 'install_service_inactive');
        const proc = processEvidence(pid);
        const root = fs.realpathSync(proc.environment.AO_RELEASE_ROOT ?? proc.cwd);
        const loaded = verifyReleaseTree(root);
        const entry = component === 'session-recovery' ? 'scripts/ao-session.js' : loaded.components[component].entrypoint;
        const expectedExecutable = component === 'daemon' ? path.join(root, entry) : loaded.toolchain.node_executable;
        const expectedArgs = component === 'daemon' ? [expectedExecutable, 'daemon']
          : [expectedExecutable, path.join(root, entry), ...(component === 'session-recovery' ? ['serve'] : [])];
        assertRelease(proc.executable === fs.realpathSync(expectedExecutable) && JSON.stringify(proc.argv) === JSON.stringify(expectedArgs)
          && proc.cwd === root && proc.environment.AO_RELEASE_ID === loaded.release_id
          && proc.environment.AO_DATA_DIR === config.dataDir && proc.environment.AO_RUN_FILE === env.AO_RUN_FILE
          && fileSha256(`/proc/${pid}/exe`) === (component === 'daemon' ? loaded.components.daemon.files.find((file) => file.path === entry).sha256 : loaded.toolchain.node_sha256), 'install_loaded_release_drift');
        let unitVerified = properties.FragmentPath === path.join(config.unitRoot, unit)
          && fs.readFileSync(properties.FragmentPath, 'utf8') === expectedUnits[unit];
        const drops = properties.DropInPaths.trim() ? properties.DropInPaths.trim().split(/\s+/) : [];
        unitVerified &&= drops.length <= 1 && drops.every((drop) => drop === path.join(config.unitRoot, `${unit}.d/10-environment.conf`));
        for (const drop of drops) {
          const values = validateEnvironmentOverride(fs.readFileSync(drop, 'utf8'));
          unitVerified &&= Object.entries(values).every(([key, value]) => proc.environment[key] === value);
        }
        observations.services[component] = { pid, start_token: proc.start_token, start_time: properties.ExecMainStartTimestampMonotonic,
          control_group: properties.ControlGroup, release_root: root, release_id: loaded.release_id,
          component_sha256: component === 'session-recovery' ? loaded.components.cli.sha256 : loaded.components[component].sha256,
          stable: processUnchanged(proc), unit_verified: unitVerified };
      } catch { observations.services[component] = null; }
    }
    await collect('ready', () => get('/readyz'));
    await collect('cids', async () => {
      const result = await get('/api/v1/sessions'); const sessions = result.sessions ?? result.data?.sessions ?? result.data;
      assertRelease(Array.isArray(sessions) && sessions.every((session) => typeof (session.cid ?? session.id) === 'string'), 'install_sessions_unknown');
      return sessions.map((session) => session.cid ?? session.id);
    });
    await collect('tmux', () => {
      const doctor = JSON.parse(run(path.join(releaseRoot, 'native/ao'), ['doctor', '--json'], { env }));
      const check = doctor.checks?.find((item) => item.name === 'tmux_cgroup');
      assertRelease(check && check.details, 'install_tmux_unknown');
      return { ...check.details, level: check.level, executable_sha256: fileSha256(`/proc/${check.details.server_pid}/exe`) };
    });
    await collect('linger', () => run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']) === 'yes');
    await collect('listeners_loopback', () => {
      const rows = run('ss', ['-H', '-ltn']).split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)[3]);
      return config.listenPorts.every((port) => {
        const matches = rows.filter((address) => address.endsWith(`:${port}`));
        return matches.length > 0 && matches.every((address) => /^(127\.0\.0\.1|\[::1\]|::1):/.test(address));
      });
    });
    await collect('terminal_auth', async () => {
      const secret = fs.readFileSync(config.terminalTokenFile, 'utf8').trim();
      assertRelease(secret !== '', 'install_terminal_token_missing');
      const require = createRequire(path.join(releaseRoot, 'browser/package.json'));
      const WebSocket = require('ws');
      const options = { origin: config.terminalOrigin, headers: { Authorization: `Bearer ${secret}` } };
      const results = await Promise.all([
        websocketResult(WebSocket, config.terminalURL, { origin: config.terminalOrigin }, '', true),
        websocketResult(WebSocket, config.terminalURL, { origin: config.terminalOrigin, headers: { Authorization: 'Bearer deliberately-invalid' } }, '', true),
        websocketResult(WebSocket, config.terminalURL, { ...options, origin: 'http://invalid.example' }, '', true),
        websocketResult(WebSocket, config.terminalURL, options, config.terminalCanaryPrefix, false),
      ]);
      return results.every(Boolean);
    });
    await collect('database', () => {
      const output = run('sqlite3', ['-readonly', path.join(config.dataDir, 'ao.db'), 'SELECT version_id FROM goose_db_version WHERE is_applied=1 ORDER BY id DESC LIMIT 1; PRAGMA integrity_check;']).split('\n');
      return { schema: Number(output[0]), integrity: output.slice(1).join('\n') };
    });
    await collect('ownership_locks', () => {
      const daemonPid = observations.services.daemon?.pid;
      assertRelease(Number.isSafeInteger(daemonPid), 'install_lock_owner_unknown');
      const descriptors = fs.readdirSync(`/proc/${daemonPid}/fd`);
      return ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: true }) === true
        && descriptors.some((descriptor) => {
          try {
            return fs.realpathSync(`/proc/${daemonPid}/fd/${descriptor}`) === fs.realpathSync(file)
              && new RegExp(`FLOCK\\s+ADVISORY\\s+WRITE\\s+${daemonPid}\\s`).test(fs.readFileSync(`/proc/${daemonPid}/fdinfo/${descriptor}`, 'utf8'));
          } catch { return false; }
        }));
    });
    await collect('lan_disabled', async () => {
      const mobile = await get('/api/v1/mobile/status');
      return (mobile.enabled ?? mobile.data?.enabled) === false;
    });
    await collect('trusted_host_disabled', () => !fs.existsSync(config.trustedHostDirectory)
      || fs.readdirSync(config.trustedHostDirectory).length === 0);
    await collect('tokenless_lock_safe', () => controlLocksHaveStartTokens(config.controlPlaneRoot));
    return observations;
  }
  return {
    configuration: config, observe,
    async preflight({ releaseRoot }) {
      assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
      assertRelease(fs.statSync(config.configPath).isFile(), 'install_config_missing');
      const baseline = await observe({ releaseRoot });
      assertRelease(Array.isArray(baseline.cids) && baseline.database?.integrity === 'ok' && baseline.tmux?.server_start_token, 'install_baseline_unknown');
      return baseline;
    },
    async backupDatabase({ backupRoot }) {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backup = path.join(backupRoot, 'ao.db');
      assertRelease(!backup.includes("'"), 'unsafe_install_configuration');
      run('sqlite3', [path.join(config.dataDir, 'ao.db'), `.backup '${backup}'`]);
      assertRelease(run('sqlite3', ['-readonly', backup, 'PRAGMA integrity_check;']) === 'ok', 'install_database_backup_invalid');
      return { path: backup, sha256: fileSha256(backup), completed_at: new Date().toISOString() };
    },
    async stop() {
      const owned = [];
      for (const name of ['adapter', 'session-recovery', 'dashboard', 'runtime']) {
        const raw = systemctl(['show', unitName(name), '--property=MainPID', '--value']);
        if (Number(raw) > 0) {
          const proc = processEvidence(Number(raw));
          assertRelease(proc.environment.AO_DATA_DIR === config.dataDir && proc.environment.AO_RUN_FILE === env.AO_RUN_FILE, 'install_service_namespace_mismatch');
          owned.push(proc);
        }
        systemctl(['stop', unitName(name)]);
      }
      assertRelease(owned.every((proc) => !processUnchanged(proc)), 'install_previous_process_alive');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true), 'install_previous_locks_held');
    },
    async reload() { systemctl(['daemon-reload']); },
    async start() {
      systemctl(['start', unitName('tmux')]);
      for (const name of ['runtime', 'dashboard', 'session-recovery', 'adapter']) systemctl(['start', unitName(name)]);
    },
    async restoreDatabase({ backup }) {
      assertRelease(fileSha256(backup.path) === backup.sha256, 'install_database_backup_invalid');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true), 'install_previous_locks_held');
      fs.copyFileSync(backup.path, path.join(config.dataDir, 'ao.db'));
      for (const suffix of ['-wal', '-shm']) fs.rmSync(path.join(config.dataDir, `ao.db${suffix}`), { force: true });
    },
    async pins() {
      const roots = [];
      for (const name of RELEASE_SERVICES) {
        const pid = Number(systemctl(['show', unitName(name), '--property=MainPID', '--value']));
        if (pid > 0) { const proc = processEvidence(pid); roots.push(proc.environment.AO_RELEASE_ROOT ?? proc.cwd); }
      }
      return roots;
    },
  };
}
