import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { adapterConfiguration, adapterConfigPath } from './release-adapter.js';
import { assertRelease, fileSha256, inventoryTree, objectSha256, readJson, syncTree, verifyReleaseTree } from './release-manifest.js';
import { processStartToken } from './release-lock.js';
import { isStrictReadyz } from './install-doctor.js';
import { RELEASE_SERVICES, renderReleaseUnits, validateEnvironmentOverride } from './release-units.js';

export function validateInstallConfiguration(config) {
  assertRelease(config.schema_version === 'ao.install-config.v1' && process.platform === 'linux', 'invalid_install_configuration');
  assertRelease(/^ao-pilot(?:-staging-[a-z0-9-]+)?$/.test(config.namespace ?? ''), 'unsafe_unit_namespace');
  const names = ['installRoot', 'stateRoot', 'unitRoot', 'dataDir', 'discoveryDir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory', 'tmuxTmpdir'];
  for (const name of names) assertRelease(path.isAbsolute(config[name] ?? '') && !/[\r\n\0"%\\]/.test(config[name]), 'unsafe_install_configuration');
  for (const name of names) {
    let ancestor = path.resolve(config[name]);
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    assertRelease(fs.realpathSync(ancestor) === ancestor, 'unsafe_install_configuration');
  }
  assertRelease(new Set([config.installRoot, config.dataDir, config.discoveryDir, config.tmuxTmpdir]).size === 4, 'install_namespace_collision');
  assertRelease(/^[a-zA-Z0-9_-]+$/.test(config.tmuxSocket ?? '') && config.tmuxSocket !== 'default', 'invalid_tmux_namespace');
  for (const field of ['daemonURL', 'terminalURL', 'terminalOrigin']) {
    const url = new URL(config[field]);
    assertRelease(['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && ['http:', 'ws:'].includes(url.protocol) && url.username === '' && url.password === '', 'non_loopback_install_endpoint');
  }
  assertRelease(config.terminalCanaryPrefix === 'canary:' && Array.isArray(config.listenPorts)
    && config.listenPorts.length === 5 && new Set(config.listenPorts).size === config.listenPorts.length
    && config.listenPorts.every((port) => Number.isSafeInteger(port) && port >= 1024 && port <= 65535), 'invalid_install_ports');
  if (config.namespace.includes('-staging-')) {
    assertRelease(config.tmuxSocket.startsWith(config.namespace), 'install_namespace_collision');
    for (const name of ['dataDir', 'discoveryDir', 'tmuxTmpdir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory']) {
      assertRelease(path.resolve(config[name]).startsWith(`${path.resolve(config.stateRoot)}/`), 'install_namespace_collision');
    }
  }
  adapterConfiguration(config);
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
    cwd: fs.realpathSync(`/proc/${pid}/cwd`), environment: envOf(pid), executable_sha256: fileSha256(`/proc/${pid}/exe`) };
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
export function assertFirstRestoreConfiguration(config, mode) {
  if (mode !== 'first') return;
  assertRelease(Array.isArray(config.restoreProjects) && config.restoreProjects.length > 0
    && new Set(config.restoreProjects).size === config.restoreProjects.length
    && config.restoreProjects.every((project) => typeof project === 'string' && /^[A-Za-z0-9._-]+$/.test(project))
    && Number.isSafeInteger(config.restoreConcurrency) && config.restoreConcurrency >= 1 && config.restoreConcurrency <= 16,
  'install_first_restore_input_required');
}
export function assertFirstRestoreScope(config, mode, baseline) {
  if (mode !== 'first') return;
  assertRelease(Array.isArray(baseline?.identities) && Array.isArray(baseline?.projects)
    && baseline.identities.every((row) => config.restoreProjects.includes(row.project_id))
    && config.restoreProjects.every((project) => baseline.projects.includes(project)), 'install_first_restore_scope_incomplete');
}
export function assertLoadedProcess({ proc, root, manifest, component, config }) {
  const entry = component === 'session-recovery' ? 'scripts/ao-session.js' : manifest.components[component].entrypoint;
  const executable = component === 'daemon' ? path.join(root, entry) : manifest.toolchain.node_executable;
  const args = component === 'daemon' ? [executable, 'daemon']
    : [executable, path.join(root, entry), ...(component === 'session-recovery' ? ['serve'] : [])];
  assertRelease(proc.executable === fs.realpathSync(executable) && JSON.stringify(proc.argv) === JSON.stringify(args)
    && proc.cwd === (component === 'daemon' ? fs.realpathSync(config.dataDir) : root)
    && proc.environment.AO_RELEASE_ID === manifest.release_id && proc.environment.AO_RELEASE_ROOT === root
    && proc.environment.AO_DATA_DIR === config.dataDir && proc.environment.AO_RUN_FILE === path.join(config.discoveryDir, 'running.json')
    && proc.environment.AO_MANAGED_RUNTIME_BINARY === path.join(root, manifest.components.daemon.entrypoint)
    && proc.environment.AO_MANAGED_RUNTIME_BINARY_SHA256 === manifest.components.daemon.files.find((file) => file.path === manifest.components.daemon.entrypoint).sha256
    && proc.environment.AO_MANAGED_RUNTIME_DATA_DIR === config.dataDir
    && proc.environment.AO_MANAGED_RUNTIME_RUN_FILE === path.join(config.discoveryDir, 'running.json')
    && proc.executable_sha256 === (component === 'daemon' ? manifest.components.daemon.files.find((file) => file.path === entry).sha256 : manifest.toolchain.node_sha256),
  'install_loaded_release_drift');
}
export function createSystemdReleaseRunner(rawConfiguration, { run = execute, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), startupAttempts = 60 } = {}) {
  const config = validateInstallConfiguration(rawConfiguration);
  const unitName = (name) => `${config.namespace}-${name === 'adapter' ? 'dashboard-adapter' : name}.service`;
  const systemctl = (args) => run('systemctl', ['--user', ...args]);
  const env = { ...process.env, AO_DATA_DIR: config.dataDir, AO_RUN_FILE: path.join(config.discoveryDir, 'running.json'),
    AO_TMUX_SOCKET: config.tmuxSocket, AO_TMUX_UNIT: unitName('tmux'), AO_TMUX_TMPDIR: config.tmuxTmpdir, TMUX_TMPDIR: config.tmuxTmpdir };
  const ownershipFiles = [path.join(config.dataDir, '.daemon-owner.lock'), path.join(config.discoveryDir, '.daemon-discovery.lock')];
  async function get(relative) {
    const response = await fetchImpl(new URL(relative, config.daemonURL), { signal: AbortSignal.timeout(5000) });
    assertRelease(response.ok, 'install_observation_failed'); return response.json();
  }
  function identitySnapshot() {
    const database = path.join(config.dataDir, 'ao.db');
    const identities = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT s.id AS ao_session_id,s.project_id,s.num,s.kind,s.harness,s.agent_session_id AS native_conversation_id,s.runtime_launch_id,s.runtime_handle_id,s.is_terminated,s.workspace_path,s.branch,s.created_at,a.attempt_id FROM sessions s LEFT JOIN spawn_attempt_sessions a ON a.session_id=s.id ORDER BY s.id;']) || '[]');
    const attempts = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT session_id,attempt_id,project_id,session_num FROM spawn_attempt_sessions ORDER BY session_id;']) || '[]');
    const custody = attempts.map((entry) => {
        let raw_outcome = null; let record_sha256 = null; let record_state = 'unknown';
        if (/^[a-f0-9-]{36}$/.test(entry.attempt_id ?? '')) {
          const recordPath = path.join(config.dataDir, 'spawn-attempts', entry.attempt_id, 'record.json');
          try {
            assertRelease(fs.realpathSync(recordPath) === recordPath && fs.lstatSync(recordPath).isFile(), 'install_custody_unknown');
            record_sha256 = fileSha256(recordPath); record_state = 'present';
            const record = readJson(recordPath);
            raw_outcome = typeof record.outcome === 'string' ? record.outcome : null;
          } catch (error) { if (error.code === 'ENOENT') record_state = 'missing'; /* no authority inference */ }
        }
        return { ...entry, raw_outcome, record_sha256, record_state, validation: 'UNKNOWN' };
      });
    assertRelease(identities.every((row) => typeof row.ao_session_id === 'string' && typeof row.project_id === 'string'
      && (row.native_conversation_id === null || typeof row.native_conversation_id === 'string')), 'install_native_identity_unknown');
    const projects = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT id FROM projects ORDER BY id;']) || '[]').map((row) => row.id);
    return { identities, custody, projects, native_cids: identities.map((row) => ({ ao_session_id: row.ao_session_id, native_conversation_id: row.native_conversation_id ?? null })) };
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
        assertLoadedProcess({ proc, root, manifest: loaded, component, config });
        if (component === 'adapter') {
          assertRelease(proc.environment.AO_DASHBOARD_ADAPTER_CONFIG === adapterConfigPath(config)
            && JSON.stringify(readJson(adapterConfigPath(config))) === JSON.stringify(adapterConfiguration(config)), 'adapter_config_drift');
        }
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
    await collect('cli_bound', () => Boolean(config.cliPath) && fs.realpathSync(config.cliPath) === path.join(fs.realpathSync(releaseRoot), 'bin/ao-pilot.js'));
    await collect('identity', () => identitySnapshot());
    if (observations.identity) Object.assign(observations, observations.identity);
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
    async preflight({ releaseRoot, mode }) {
      assertFirstRestoreConfiguration(config, mode);
      assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
      const configStat = fs.lstatSync(config.configPath);
      assertRelease(configStat.isFile() && !configStat.isSymbolicLink() && configStat.uid === process.getuid()
        && (configStat.mode & 0o077) === 0, 'install_config_missing');
      const baseline = await observe({ releaseRoot });
      assertRelease(Array.isArray(baseline.cids) && baseline.database?.integrity === 'ok' && baseline.tmux?.server_start_token && Array.isArray(baseline.native_cids) && Array.isArray(baseline.custody), 'install_baseline_unknown');
      assertFirstRestoreScope(config, mode, baseline);
      return baseline;
    },
    async quiescent() {
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true), 'install_previous_locks_held');
      const database = path.join(config.dataDir, 'ao.db');
      const rows = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT id FROM sessions ORDER BY id;']) || '[]');
      const state = run('sqlite3', ['-readonly', database, 'SELECT version_id FROM goose_db_version WHERE is_applied=1 ORDER BY id DESC LIMIT 1; PRAGMA integrity_check;']).split('\n');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true), 'install_previous_locks_held');
      return { ...identitySnapshot(), cids: rows.map((row) => row.id), database: { schema: Number(state[0]), integrity: state.slice(1).join('\n') } };
    },
    async backupDatabase({ backupRoot }) {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backup = path.join(backupRoot, 'ao.db');
      assertRelease(!backup.includes("'"), 'unsafe_install_configuration');
      run('sqlite3', [path.join(config.dataDir, 'ao.db'), `.backup '${backup}'`]);
      assertRelease(run('sqlite3', ['-readonly', backup, 'PRAGMA integrity_check;']) === 'ok'
        && ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true)
        && run('sqlite3', ['-readonly', backup, 'SELECT id FROM sessions ORDER BY id;']) === run('sqlite3', ['-readonly', path.join(config.dataDir, 'ao.db'), 'SELECT id FROM sessions ORDER BY id;']), 'install_database_backup_invalid');
      const recoverySource = path.join(config.dataDir, 'spawn-attempts');
      const recovery = { exists: fs.existsSync(recoverySource), path: path.join(backupRoot, 'spawn-attempts') };
      if (recovery.exists) {
        const before = objectSha256(inventoryTree(recoverySource, { exclude: [] }));
        fs.cpSync(recoverySource, recovery.path, { recursive: true, verbatimSymlinks: true });
        recovery.sha256 = objectSha256(inventoryTree(recovery.path, { exclude: [] }));
        assertRelease(recovery.sha256 === before, 'install_database_backup_invalid'); syncTree(recovery.path);
      }
      const backupFd = fs.openSync(backup, 'r'); try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
      return { path: backup, sha256: fileSha256(backup), recovery, completed_at: new Date().toISOString() };
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
    async start({ releaseRoot, mode = 'daily', baseline } = {}) {
      assertFirstRestoreConfiguration(config, mode);
      assertFirstRestoreScope(config, mode, baseline);
      systemctl(['start', unitName('tmux')]);
      for (const name of ['runtime', 'dashboard', 'session-recovery', 'adapter']) systemctl(['start', unitName(name)]);
      const wait = async (probe) => {
        for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
          try { if (await probe()) return; } catch { /* unknown stays blocked until bounded timeout */ }
          await sleep(250);
        }
        assertRelease(false, 'install_startup_not_ready');
      };
      const restore_results = [];
      if (mode === 'first') {
        // REST is available after boot even while readiness is degraded. Restore
        // precedes strict ready admission and remains an explicit native action.
        await wait(async () => Array.isArray((await get('/api/v1/sessions')).sessions));
        for (const project of config.restoreProjects) {
          const result = JSON.parse(run(path.join(releaseRoot, 'native/ao'), ['session', 'restore', '--project', project,
            '--all', '--concurrency', String(config.restoreConcurrency), '--json'], { env, timeout: 15 * 60 * 1000 + 10000 }));
          const expected = baseline.identities.filter((row) => row.project_id === project).map((row) => row.ao_session_id).sort();
          assertRelease(result.projectId === project && Array.isArray(result.results)
            && result.results.every((row) => ['restored', 'skipped_hold'].includes(row.outcome) && typeof row.reason === 'string'
              && (row.outcome !== 'restored' || row.reason === 'already_running' || row.restoreMode === 'native'))
            && objectSha256(result.results.map((row) => row.sessionId).sort()) === objectSha256(expected), 'install_first_restore_failed');
          restore_results.push(result);
        }
      }
      await wait(async () => isStrictReadyz(await get('/readyz')));
      return { restore_results };
    },
    async restoreDatabase({ backup }) {
      assertRelease(fileSha256(backup.path) === backup.sha256, 'install_database_backup_invalid');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false }) === true), 'install_previous_locks_held');
      if (backup.recovery?.exists) assertRelease(objectSha256(inventoryTree(backup.recovery.path, { exclude: [] })) === backup.recovery.sha256, 'install_database_backup_invalid');
      assertRelease(backup.recovery && path.dirname(backup.recovery.path) === path.dirname(backup.path), 'install_database_backup_invalid');
      fs.copyFileSync(backup.path, path.join(config.dataDir, 'ao.db'));
      const recoveryTarget = path.join(config.dataDir, 'spawn-attempts');
      try { assertRelease(!fs.lstatSync(recoveryTarget).isSymbolicLink(), 'install_database_backup_invalid'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmSync(recoveryTarget, { force: true, recursive: true });
      if (backup.recovery.exists) fs.cpSync(backup.recovery.path, recoveryTarget, { recursive: true, verbatimSymlinks: true });
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
