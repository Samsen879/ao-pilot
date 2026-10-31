import {verifyRestoreFiles} from './restore-files.js';
import { managedBindingsPath, MANAGED_RECOVERY_BINDINGS_CONTRACT, NATIVE_RECOVERY_BINDINGS_CONTRACT } from './session-recovery.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { adapterConfiguration, adapterConfigPath } from './release-adapter.js';
import { assertRelease, fileSha256, inventoryTree, objectSha256, readJson, sha256, syncTree, verifyReleaseTree } from './release-manifest.js';
import { processStartToken } from './release-lock.js';
import { isStrictReadyz } from './install-doctor.js';
import { RELEASE_SERVICES, renderReleaseUnits, validateEnvironmentOverride, stagingHomeEnvironment } from './release-units.js';
import { collectLegacyAdoption, assertLegacyAdoption } from './release-legacy-adoption.js';
import { createTerminalAuth } from '../../../integrations/dashboard-native-adapter/auth.mjs';
import { checkInstallTools, executableOnPath } from './release-tools.js';

export function copyCustodyTree(source, target) {
  const stat = fs.lstatSync(source);
  assertRelease(stat.isDirectory() && !stat.isSymbolicLink(), 'install_database_backup_invalid');
  const before = inventoryTree(source, { exclude: [] });
  fs.mkdirSync(target, { recursive: true, mode: stat.mode & 0o777 });
  assertRelease(fs.lstatSync(target).isDirectory() && !fs.lstatSync(target).isSymbolicLink(), 'install_database_backup_invalid');
  fs.cpSync(source, target, { recursive: true, verbatimSymlinks: true });
  // cpSync creates directories with the caller's umask, not the source mode.
  // Retain every recorded permission instead of omitting mode from the digest.
  for (const entry of before) {
    if (entry.type === 'symlink') continue;
    const file = path.join(target, entry.path); const copied = fs.lstatSync(file);
    assertRelease(!copied.isSymbolicLink() && (entry.type === 'directory' ? copied.isDirectory() : copied.isFile()), 'install_database_backup_invalid');
    fs.chmodSync(file, entry.mode);
  }
  fs.chmodSync(target, stat.mode & 0o777);
  assertRelease(objectSha256(inventoryTree(target, { exclude: [] })) === objectSha256(before), 'install_database_backup_invalid');
}

export function validateInstallConfiguration(config) {
  assertRelease(config.schema_version === 'ao.install-config.v1' && process.platform === 'linux', 'invalid_install_configuration');
  assertRelease(/^ao-pilot(?:-staging-[a-z0-9-]+)?$/.test(config.namespace ?? ''), 'unsafe_unit_namespace');
  const names = ['installRoot', 'stateRoot', 'unitRoot', 'dataDir', 'discoveryDir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory', 'tmuxTmpdir', 'terminalTokenFile'];
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
    for (const name of ['dataDir', 'discoveryDir', 'tmuxTmpdir', 'configPath', 'controlPlaneRoot', 'trustedHostDirectory', 'terminalTokenFile']) {
      assertRelease(path.resolve(config[name]).startsWith(`${path.resolve(config.stateRoot)}/`), 'install_namespace_collision');
    }
  }
  adapterConfiguration(config);
  return config;
}
function execute(command, args, { acceptedExitCodes = [0], ...options } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, ...options });
  if (result.error || !acceptedExitCodes.includes(result.status)) throw Object.assign(new Error(`Observation failed: ${command}: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`), {
    code: 'install_observation_failed', details: { command, status: result.status, signal: result.signal, error: result.error?.code ?? null, stderr: result.stderr?.trim() ?? '' },
  });
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
export function offlineProcessEntrypoint(pid, { run, read = file => fs.readFileSync(file, 'utf8'),
  realpath = fs.realpathSync, startToken = processStartToken, stat = fs.statSync } = {}) {
  const proc = { pid, start_token: startToken(pid), argv: read(`/proc/${pid}/cmdline`).split('\0').filter(Boolean) };
  try { return { ...proc, executable: realpath(`/proc/${pid}/exe`), cwd: realpath(`/proc/${pid}/cwd`) }; }
  catch (error) {
    if (error.code !== 'EACCES') throw error;
    // systemd --user and its PAM helper can be non-dumpable. Identify only
    // these core processes through the system manager's authoritative MainPID
    // and reserved init.scope; do not filter old entrypoints by mutable names.
    const unit = `user@${process.getuid()}.service`;
    const manager = Number(run('systemctl', ['show', unit, '--property=MainPID', '--value']));
    const group = run('systemctl', ['show', unit, '--property=ControlGroup', '--value']);
    assertRelease(Number.isSafeInteger(manager) && manager > 1 && group.startsWith('/') && group !== '/', 'install_legacy_process_unknown');
    const managerToken = startToken(manager);
    const argv = read(`/proc/${manager}/cmdline`).split('\0').filter(Boolean);
    assertRelease(argv.length === 2 && path.basename(argv[0]) === 'systemd' && argv[1] === '--user', 'install_legacy_process_unknown');
    const executable = stat(realpath(argv[0]));
    const cgroup = read(`/proc/${manager}/cgroup`);
    assertRelease(executable.isFile() && executable.uid === 0 && (executable.mode & 0o022) === 0
      && cgroup.trim().split('\n').every(line => line.split(':')[2] === `${group}/init.scope`), 'install_legacy_process_unknown');
    const text = read(`/proc/${pid}/stat`), fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
    const pam = Number(fields[1]) === manager && proc.argv.length === 1 && proc.argv[0] === '(sd-pam)'
      && read(`/proc/${pid}/cgroup`) === cgroup;
    assertRelease((pid === manager || pam) && startToken(manager) === managerToken, 'install_legacy_process_unknown', 'Unreadable process is not a proven user manager/PAM helper');
    return { ...proc, unrelated: true, system_manager: { pid: manager, start_token: managerToken, control_group: group } };
  }
}
export function probeExclusiveLock(file, { expectHeld, run = spawnSync, flock = 'flock' } = {}) {
  // flock never deletes or rewrites the lock, and never waits for a held lock.
  if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const result = run(flock, ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd] });
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
 for(const field of ['firstRestoreSessionIDs','restoreLastSessionIDs']) if(config[field]!==undefined) assertRelease(Array.isArray(config[field])&&new Set(config[field]).size===config[field].length&&config[field].every(id=>typeof id==='string'&&/^[A-Za-z0-9_.-]+$/.test(id)),'install_first_restore_input_required');

}
export function assertFirstRestoreScope(config, mode, baseline) {
  if (mode !== 'first') return;
  assertRelease(Array.isArray(baseline?.identities) && Array.isArray(baseline?.projects)
    && baseline.identities.every((row) => config.restoreProjects.includes(row.project_id)
      && typeof row.ao_session_id === 'string' && /^[A-Za-z0-9_.-]+$/.test(row.ao_session_id)
      && ['worker', 'orchestrator'].includes(row.kind) && [0, 1].includes(row.is_terminated))
    && config.restoreProjects.every((project) => baseline.projects.includes(project)), 'install_first_restore_scope_incomplete');
 const ids=new Map(baseline.identities.map(row=>[row.ao_session_id,row]));
 assertRelease((config.firstRestoreSessionIDs??[]).every(id=>ids.has(id))&&(config.restoreLastSessionIDs??[]).every(id=>ids.has(id)&&ids.get(id).kind==='worker'&&firstRestoreIdentities(config,baseline).some(row=>row.ao_session_id===id)),'install_first_restore_scope_incomplete');

}
export function firstRestoreIdentities(config, baseline) {
 const explicit=new Set(config.firstRestoreSessionIDs??[]);
 return baseline.identities.filter(row=>row.is_terminated===0||explicit.has(row.ao_session_id));
}
export function firstRestorePlan(config, baseline) {
  const plan = [];
  // The HTTP request limit remains 4096 bytes. Finish every project's
  // orchestrator requests before admitting any worker request.
  for (const kind of ['orchestrator', 'worker']) for (const project of config.restoreProjects) {
    const ids = firstRestoreIdentities(config,baseline).filter(row=>row.project_id===project&&row.kind===kind)
      .map((row) => row.ao_session_id).sort();
    let chunk = [];
    const fits = (sessionIds) => Buffer.byteLength(JSON.stringify({ project, concurrency: config.restoreConcurrency,
      includeTerminated: true, sessionIds })) <= 4096;
    for (const id of ids) {
      if (!fits([...chunk, id])) {
        assertRelease(chunk.length > 0, 'install_first_restore_input_required');
        plan.push({ project, ids: chunk }); chunk = [];
      }
      assertRelease(fits([id]), 'install_first_restore_input_required'); chunk.push(id);
    }
    if (chunk.length) plan.push({ project, ids: chunk });
  }
 const last=new Set(config.restoreLastSessionIDs??[]);
 if(last.size){const tail=[];for(const id of config.restoreLastSessionIDs){const row=firstRestoreIdentities(config,baseline).find(row=>row.ao_session_id===id);assertRelease(row,'install_first_restore_scope_incomplete');tail.push({project:row.project_id,ids:[id]})};return [...plan.map(batch=>({...batch,ids:batch.ids.filter(id=>!last.has(id))})).filter(batch=>batch.ids.length),...tail];}

  return plan;
}
export function assertLoadedProcess({ proc, root, manifest, component, config }) {
  const recoveryContract = manifest.components.cli.recovery_bindings;
  assertRelease(recoveryContract === undefined || [MANAGED_RECOVERY_BINDINGS_CONTRACT,NATIVE_RECOVERY_BINDINGS_CONTRACT].includes(recoveryContract), 'install_loaded_release_drift');
  const entry = component === 'session-recovery' ? 'scripts/ao-session.js' : manifest.components[component].entrypoint;
  const executable = component === 'daemon' ? path.join(root, entry) : manifest.toolchain.node_executable;
  const args = component === 'daemon' ? [executable, 'daemon']
    : [executable, path.join(root, entry), ...(component === 'session-recovery' ? ['serve', ...(recoveryContract !== undefined ? ['--bindings', managedBindingsPath(config.dataDir), ...(recoveryContract===NATIVE_RECOVERY_BINDINGS_CONTRACT?['--native-daemon']:[])] : [])] : [])];
  assertRelease(proc.executable === fs.realpathSync(executable) && JSON.stringify(proc.argv) === JSON.stringify(args)
    && proc.cwd === (component === 'daemon' ? fs.realpathSync(config.dataDir) : root)
    && proc.environment.AO_RELEASE_ID === manifest.release_id && proc.environment.AO_RELEASE_ROOT === root
    && proc.environment.AO_DATA_DIR === config.dataDir && proc.environment.AO_RUN_FILE === path.join(config.discoveryDir, 'running.json')
    && proc.environment.AO_MANAGED_RUNTIME_BINARY === path.join(root, manifest.components.daemon.entrypoint)
    && proc.environment.AO_MANAGED_RUNTIME_BINARY_SHA256 === manifest.components.daemon.files.find((file) => file.path === manifest.components.daemon.entrypoint).sha256
    && proc.environment.AO_MANAGED_RUNTIME_DATA_DIR === config.dataDir
    && proc.environment.AO_MANAGED_RUNTIME_RUN_FILE === path.join(config.discoveryDir, 'running.json')
    && proc.environment.AO_TMUX_SOCKET === config.tmuxSocket
    && proc.environment.AO_TMUX_UNIT === `${config.namespace}-tmux.service`
    && proc.environment.AO_TMUX_TMPDIR === config.tmuxTmpdir && proc.environment.TMUX_TMPDIR === config.tmuxTmpdir
    && proc.environment.AO_DASHBOARD_ADAPTER_CONFIG === adapterConfigPath(config)
    && (!config.namespace.startsWith('ao-pilot-staging-')
      || Object.entries(stagingHomeEnvironment(config.stateRoot)).every(([key, value]) => proc.environment[key] === value))
    && proc.executable_sha256 === (component === 'daemon' ? manifest.components.daemon.files.find((file) => file.path === entry).sha256 : manifest.toolchain.node_sha256),
  'install_loaded_release_drift');
}
// Parse YAML with the shared full schema and native project-key identity before
// migration/switch. Native status only probes namespace/health, not YAML validity.
export async function checkNativeRecoveryConfiguration(config, manifest, releaseRoot, { run, env, preparedConfigPath, loadConfig = null } = {}) {
  if(manifest.components.cli.recovery_bindings!==NATIVE_RECOVERY_BINDINGS_CONTRACT)return;
  const configPath=preparedConfigPath??config.configPath, configSha=fileSha256(configPath);
  const validateConfig=loadConfig??(await import('../../../browser/packages/core/dist/config.js')).loadNativeRecoveryConfig;
  validateConfig(configPath);
  const binary=path.join(releaseRoot,manifest.components.daemon.entrypoint);
  const expected=manifest.components.daemon.files.find(file=>file.path===manifest.components.daemon.entrypoint)?.sha256;
  assertRelease(fileSha256(binary)===expected,'release_external_binary_drift');
  const runFile=path.join(config.discoveryDir,'running.json');
  const status=JSON.parse(run(binary,['status','--json'],{env:{...env,AO_CONFIG_PATH:preparedConfigPath??config.configPath,
    AO_MANAGED_RUNTIME_BINARY:binary,AO_MANAGED_RUNTIME_BINARY_SHA256:expected,
    AO_MANAGED_RUNTIME_DATA_DIR:config.dataDir,AO_MANAGED_RUNTIME_RUN_FILE:runFile},timeout:10000}));
  assertRelease(path.isAbsolute(status.dataDir??'')&&path.isAbsolute(status.runFile??'')
    &&path.resolve(status.dataDir)===path.resolve(config.dataDir)&&path.resolve(status.runFile)===path.resolve(runFile)
    &&fileSha256(binary)===expected&&fileSha256(configPath)===configSha,'install_native_recovery_config_invalid');
}

export function createSystemdReleaseRunner(rawConfiguration, { run: suppliedRun = null, fetchImpl = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), startupAttempts = 60, toolResolver = executableOnPath, preparedInputs = null } = {}) {
  const config = validateInstallConfiguration(rawConfiguration);
  const executionEnv = { ...process.env }; let tools;
  const checkTools = () => tools ??= checkInstallTools({ env: executionEnv, resolve: toolResolver });
  const run = suppliedRun ?? ((command, args, options = {}) => {
    const executable = path.isAbsolute(command) ? command : tools?.[command] ?? toolResolver(command, executionEnv);
    assertRelease(executable, 'install_required_tools_missing', `Missing required tool: ${command}`);
    return execute(executable, args, { env: executionEnv, ...options });
  });
  const unitName = (name) => `${config.namespace}-${name === 'adapter' ? 'dashboard-adapter' : name}.service`;
  const systemctl = (args) => run('systemctl', ['--user', ...args]);
  const env = { ...process.env, AO_DATA_DIR: config.dataDir, AO_RUN_FILE: path.join(config.discoveryDir, 'running.json'),
    AO_TMUX_SOCKET: config.tmuxSocket, AO_TMUX_UNIT: unitName('tmux'), AO_TMUX_TMPDIR: config.tmuxTmpdir, TMUX_TMPDIR: config.tmuxTmpdir };
  const ownershipFiles = [path.join(config.dataDir, '.daemon-owner.lock'), path.join(config.discoveryDir, '.daemon-discovery.lock')];
  const legacyDependencies = { run, processEvidence, processUnchanged,
    processEntrypoint: pid => offlineProcessEntrypoint(pid, { run }) };
  async function get(relative, { legacyReadiness = false } = {}) {
    const response = await fetchImpl(new URL(relative, config.daemonURL), { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    const knownDegraded = legacyReadiness && response.status === 503 && body.status === 'degraded' && body.ready === false
      && Array.isArray(body.reasons) && body.reasons.length === 1 && body.reasons[0]?.code === 'tmux_cgroup_violation';
    assertRelease(response.ok || knownDegraded, 'install_observation_failed', `HTTP ${response.status} collecting ${relative}`); return body;
  }
  function identitySnapshot(database = path.join(config.dataDir, 'ao.db')) {
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
          } catch (error) { if (error.code === 'ENOENT') record_state = 'missing'; else throw error; /* preserve observation errors without authority inference */ }
        }
        return { ...entry, raw_outcome, record_sha256, record_state, validation: 'UNKNOWN' };
      });
    assertRelease(identities.every((row) => typeof row.ao_session_id === 'string' && typeof row.project_id === 'string'
      && (row.native_conversation_id === null || typeof row.native_conversation_id === 'string')), 'install_native_identity_unknown');
    const projects = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT id FROM projects ORDER BY id;']) || '[]').map((row) => row.id);
    return { identities, custody, projects, native_cids: identities.map((row) => ({ ao_session_id: row.ao_session_id, native_conversation_id: row.native_conversation_id ?? null })) };
  }
  function offlineSnapshot() {
    const assertStopped = () => {
      assertRelease(ownershipFiles.every(file => probeExclusiveLock(file, { expectHeld: false,
        flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true), 'install_previous_locks_held');
      const addresses = run('ss', ['-H', '-ltn']).split('\n').filter(Boolean).map(line => line.trim().split(/\s+/)[3]);
      assertRelease(!addresses.some(address => config.listenPorts.some(port => address.endsWith(`:${port}`))),
        'install_legacy_offline_not_quiescent', 'Offline adoption requires all configured listening ports to be unused');
    };
    const databaseFiles = () => ['ao.db', 'ao.db-wal'].map(name => {
      const file = path.join(config.dataDir, name);
      try {
        const stat = fs.lstatSync(file);
        assertRelease(stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid(), 'install_legacy_offline_baseline_invalid');
        return { name, size: stat.size, sha256: fileSha256(file) };
      } catch (error) { if (error.code === 'ENOENT' && name.endsWith('-wal')) return { name, absent: true }; throw error; }
    });
    assertStopped(); const before = databaseFiles();
    // Even SQLite mode=ro can create WAL/SHM sidecars. Offline check-only uses
    // immutable reads only after proving there are no pending WAL bytes.
    // A nonempty WAL is refused, never silently ignored or checkpointed.
    const databaseURI = offlineDatabaseURI();
    const identity = identitySnapshot(databaseURI);
    const output = run('sqlite3', ['-readonly', databaseURI,
      'SELECT version_id FROM goose_db_version WHERE is_applied=1 ORDER BY id DESC LIMIT 1; PRAGMA integrity_check;']).split('\n');
    const snapshot = { ...identity, database: { schema: Number(output[0]), integrity: output.slice(1).join('\n') } };
    assertRelease(snapshot.database.integrity === 'ok' && Number.isSafeInteger(snapshot.database.schema), 'install_baseline_unknown');
    assertStopped(); assertRelease(objectSha256(before) === objectSha256(databaseFiles()), 'install_baseline_changed', 'Offline database changed during observation');
    return { snapshot, database_files: before };
  }
  function offlineDatabaseURI() {
    const wal = path.join(config.dataDir, 'ao.db-wal');
    try { const stat = fs.lstatSync(wal); assertRelease(stat.isFile() && !stat.isSymbolicLink() && stat.size === 0,
      'install_legacy_offline_wal_pending', 'Offline read-only baseline requires an absent or empty WAL; no automatic checkpoint'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return pathToFileURL(path.join(config.dataDir, 'ao.db')).href + '?mode=ro&immutable=1';
  }
  function offlineBaseline(legacy) {
    assertRelease(path.isAbsolute(config.offlineBaselinePath ?? '') && /^[a-f0-9]{64}$/.test(config.offlineBaselineSha256 ?? ''), 'install_legacy_offline_baseline_required');
    const fd = fs.openSync(config.offlineBaselinePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let saved;
    try {
      const stat = fs.fstatSync(fd), bytes = fs.readFileSync(fd);
      assertRelease(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0,
        'install_legacy_offline_baseline_invalid');
      // fileSha256 would reopen a mutable pathname; hash the bytes read instead.
      assertRelease(sha256(bytes) === config.offlineBaselineSha256, 'install_legacy_offline_baseline_invalid');
      saved = JSON.parse(bytes);
    } finally { fs.closeSync(fd); }
    const current = offlineSnapshot();
    assertRelease(run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']) === 'yes',
      'install_legacy_offline_not_quiescent', 'Offline adoption requires linger');
    assertRelease((!fs.existsSync(config.trustedHostDirectory) || fs.readdirSync(config.trustedHostDirectory).length === 0)
      && controlLocksHaveStartTokens(config.controlPlaneRoot), 'install_legacy_offline_baseline_invalid');
    assertRelease(saved.schema_version === 'ao.legacy-offline-baseline.v1' && saved.inventory_sha256 === legacy.inventory_sha256
      && objectSha256(saved.snapshot) === objectSha256(current.snapshot), 'install_baseline_changed', 'Offline database identities/custody/schema differ from the approved baseline');
    return current;
  }
  function recheckLegacy(evidence, stopped = false) {
    assertLegacyAdoption(config, evidence, legacyDependencies, { stopped });
    if (evidence.adoption_mode === 'offline') {
      const current = offlineBaseline(evidence);
      assertRelease(objectSha256(current) === objectSha256(evidence.offline_snapshot), 'install_baseline_changed', 'Offline database changed before switch');
    }
  }
  async function observe({ releaseRoot, baselineOnly = false, legacy = null, tmuxProbeRoot = releaseRoot }) {
    const manifest = verifyReleaseTree(releaseRoot);
    const observations = { services: {} };
    const errors = {};
    const failed = (name, error) => { errors[name] = { code: error.code ?? 'observation_failed', message: error.message, ...(error.details ? { details: error.details } : {}) }; };
    const collect = async (name, fn) => { try { observations[name] = await fn(); } catch (error) { failed(name, error); if (!baselineOnly) observations[name] = null; } };
    const expectedUnits = renderReleaseUnits({ installRoot: config.installRoot, stateRoot: config.stateRoot,
      envFile: path.join(config.stateRoot, 'install.env'), nodePath: manifest.toolchain.node_executable, namespace: config.namespace });
    for (const component of (baselineOnly && legacy ? [] : ['daemon', 'dashboard', 'adapter', 'session-recovery'])) {
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
      } catch (error) { failed(`service_${component}`, error); observations.services[component] = null; }
    }
    if (!baselineOnly) await collect('cli_bound', () => Boolean(config.cliPath) && fs.realpathSync(config.cliPath) === path.join(fs.realpathSync(releaseRoot), 'bin/ao-pilot.js'));
    await collect('identity', () => identitySnapshot());
    if (observations.identity) Object.assign(observations, observations.identity);
    await collect('ready', () => get('/readyz', { legacyReadiness: baselineOnly && legacy !== null }));
    await collect('cids', async () => {
      const result = await get('/api/v1/sessions'); const sessions = result.sessions ?? result.data?.sessions ?? result.data;
      assertRelease(Array.isArray(sessions) && sessions.every((session) => typeof (session.cid ?? session.id) === 'string'), 'install_sessions_unknown');
      return sessions.map((session) => session.cid ?? session.id);
    });
    await collect('tmux', () => {
      // Doctor exits 1 for a reported FAIL; preserve that evidence for the
      // legacy baseline. Verify still requires tmux_cgroup PASS after cutover.
      const doctorEnv = legacy ? { ...env, AO_TMUX_SOCKET: legacy.tmux.socket, AO_TMUX_TMPDIR: legacy.tmux.tmpdir, TMUX_TMPDIR: legacy.tmux.tmpdir } : env;
      const doctor = JSON.parse(run(path.join(tmuxProbeRoot, 'native/ao'), ['doctor', '--json', '--tmux-only'], { env: doctorEnv, acceptedExitCodes: [0, 1] }));
      const check = doctor.checks?.find((item) => item.name === 'tmux_cgroup');
      assertRelease(check && check.details, 'install_tmux_unknown');
      return { ...check.details, level: check.level, executable_sha256: fileSha256(`/proc/${check.details.server_pid}/exe`) };
    });
    await collect('linger', () => run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value']) === 'yes');
    if (!baselineOnly) await collect('listeners_loopback', () => {
      const rows = run('ss', ['-H', '-ltn']).split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/)[3]);
      return config.listenPorts.every((port) => {
        const matches = rows.filter((address) => address.endsWith(`:${port}`));
        return matches.length > 0 && matches.every((address) => /^(127\.0\.0\.1|\[::1\]|::1):/.test(address));
      });
    });
    if (!baselineOnly) await collect('terminal_auth', async () => {
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
    if (!baselineOnly) await collect('ownership_locks', () => {
      const daemonPid = observations.services.daemon?.pid;
      assertRelease(Number.isSafeInteger(daemonPid), 'install_lock_owner_unknown');
      const descriptors = fs.readdirSync(`/proc/${daemonPid}/fd`);
      return ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: true, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true
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
    if (Object.keys(errors).length) {
      observations.observation_errors = errors;
      if (baselineOnly) throw Object.assign(new Error(`Baseline observation failed: ${Object.entries(errors).map(([name, error]) => `${name}: ${error.message}`).join('; ')}`), { code: 'install_baseline_observation_failed', details: errors });
    }
    return observations;
  }
  return {
    configuration: config, observe, checkTools,
    async preflight({ releaseRoot, probeRoot = releaseRoot, manifest: candidateManifest = null, mode, adoptLegacy = false, adoptLegacyOffline = false }) {
      assertRelease(!adoptLegacyOffline || adoptLegacy && mode === 'first', 'install_legacy_adoption_not_first');
      assertFirstRestoreConfiguration(config, mode);
      checkTools();
      // Reject missing/unsafe capabilities before any stop; new components
      // enforce the same credential and exact browser origin on every upgrade.
      try { createTerminalAuth(preparedInputs?.terminalTokenFile ?? config.terminalTokenFile, config.terminalOrigin, true); }
      catch { assertRelease(false, 'install_terminal_auth_input_invalid'); }
      const legacy = adoptLegacy ? collectLegacyAdoption(config, legacyDependencies, { offline: adoptLegacyOffline }) : null;
      assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
      const configStat = fs.lstatSync(preparedInputs?.configPath ?? config.configPath);
      assertRelease(configStat.isFile() && !configStat.isSymbolicLink() && configStat.uid === process.getuid()
        && (configStat.mode & 0o077) === 0, 'install_config_missing');
      await checkNativeRecoveryConfiguration(config,candidateManifest??verifyReleaseTree(probeRoot),probeRoot,{run,env,preparedConfigPath:preparedInputs?.configPath});
      if (adoptLegacyOffline) {
        const current = offlineBaseline(legacy);
        legacy.offline_snapshot = current;
        const baseline = { ...current.snapshot, services: {}, cids: current.snapshot.identities.map(row => row.ao_session_id),
          legacy_adoption: legacy, offline: true };
        assertFirstRestoreScope(config, mode, baseline); firstRestorePlan(config, baseline);
        for (const id of config.restoreLastSessionIDs ?? []) verifyRestoreFiles(config, baseline, id);
        recheckLegacy(legacy);
        return baseline;
      }
      const baseline = await observe({ releaseRoot, baselineOnly: true, legacy, tmuxProbeRoot: probeRoot });
      assertRelease(Array.isArray(baseline.cids) && baseline.database?.integrity === 'ok' && baseline.tmux?.server_start_token && Array.isArray(baseline.native_cids) && Array.isArray(baseline.custody), 'install_baseline_unknown');
      if (legacy) assertRelease(baseline.tmux.server_pid === legacy.tmux.pid && baseline.tmux.server_start_token === legacy.tmux.start_token
        && baseline.tmux.executable_sha256 === legacy.tmux.executable_sha256, 'install_legacy_adoption_mismatch', 'Legacy tmux baseline differs from inventory');
      assertFirstRestoreScope(config, mode, baseline);
      if (mode === 'first') firstRestorePlan(config, baseline);
      for(const id of config.restoreLastSessionIDs??[]) verifyRestoreFiles(config,baseline,id);
      return { ...baseline, ...(legacy ? { legacy_adoption: legacy } : {}) };
    },
    async quiescent({ offline = false } = {}) {
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true), 'install_previous_locks_held');
      const database = offline ? offlineDatabaseURI() : path.join(config.dataDir, 'ao.db');
      const rows = JSON.parse(run('sqlite3', ['-readonly', '-json', database, 'SELECT id FROM sessions ORDER BY id;']) || '[]');
      const state = run('sqlite3', ['-readonly', database, 'SELECT version_id FROM goose_db_version WHERE is_applied=1 ORDER BY id DESC LIMIT 1; PRAGMA integrity_check;']).split('\n');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true), 'install_previous_locks_held');
      return { ...identitySnapshot(database), cids: rows.map((row) => row.id), database: { schema: Number(state[0]), integrity: state.slice(1).join('\n') } };
    },
    async backupDatabase({ backupRoot, offline = false }) {
      fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
      const backup = path.join(backupRoot, 'ao.db');
      assertRelease(!backup.includes("'"), 'unsafe_install_configuration');
      const database = offline ? offlineDatabaseURI() : path.join(config.dataDir, 'ao.db');
      run('sqlite3', [...(offline ? ['-readonly'] : []), database, `.backup '${backup}'`]);
      assertRelease(run('sqlite3', ['-readonly', backup, 'PRAGMA integrity_check;']) === 'ok'
        && ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true)
        && run('sqlite3', ['-readonly', backup, 'SELECT id FROM sessions ORDER BY id;']) === run('sqlite3', ['-readonly', database, 'SELECT id FROM sessions ORDER BY id;']), 'install_database_backup_invalid');
      const recoverySource = path.join(config.dataDir, 'spawn-attempts');
      const recovery = { exists: fs.existsSync(recoverySource), path: path.join(backupRoot, 'spawn-attempts') };
      if (recovery.exists) {
        const before = objectSha256(inventoryTree(recoverySource, { exclude: [] }));
        copyCustodyTree(recoverySource, recovery.path);
        recovery.sha256 = objectSha256(inventoryTree(recovery.path, { exclude: [] }));
        assertRelease(recovery.sha256 === before, 'install_database_backup_invalid'); syncTree(recovery.path);
      }
      const backupFd = fs.openSync(backup, 'r'); try { fs.fsyncSync(backupFd); } finally { fs.closeSync(backupFd); }
      return { path: backup, sha256: fileSha256(backup), recovery, completed_at: new Date().toISOString() };
    },
    async checkLegacy({ evidence, stopped = false }) { recheckLegacy(evidence, stopped); },
    async stop({ legacyAdoption = null, legacyStopped = false } = {}) {
      if (legacyAdoption) recheckLegacy(legacyAdoption, legacyStopped);
      if (legacyAdoption?.adoption_mode === 'offline') return; // Already stopped; never boot the old daemon.
      const owned = [];
      for (const name of ['adapter', 'session-recovery', 'dashboard', 'runtime']) {
        const raw = systemctl(['show', unitName(name), '--property=MainPID', '--value']);
        if (Number(raw) > 0) {
          const proc = processEvidence(Number(raw));
          if (!legacyAdoption) assertRelease(proc.environment.AO_DATA_DIR === config.dataDir && proc.environment.AO_RUN_FILE === env.AO_RUN_FILE, 'install_service_namespace_mismatch');
          owned.push(proc);
        }
        systemctl(['stop', unitName(name)]);
      }
      assertRelease(owned.every((proc) => !processUnchanged(proc)), 'install_previous_process_alive');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true), 'install_previous_locks_held');
    },
    async reload() { systemctl(['daemon-reload']); },
    async start({ releaseRoot, mode = 'daily', baseline } = {}) {
      assertFirstRestoreConfiguration(config, mode);
      assertFirstRestoreScope(config, mode, baseline);
      const restorePlan = mode === 'first' ? firstRestorePlan(config, baseline) : [];
      systemctl(['start', unitName('tmux')]);
      for (const name of ['runtime', 'dashboard', 'session-recovery', 'adapter']) systemctl(['start', unitName(name)]);
      const wait = async (probe) => {
        for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
          try { if (await probe()) return; } catch { /* unknown stays blocked until bounded timeout */ }
          await sleep(250);
        }
        assertRelease(false, 'install_startup_not_ready');
      };
      const restore_results = []; const file_manifest_checks=[];
      if (mode === 'first') {
        // REST is available after boot even while readiness is degraded. Restore
        // precedes strict ready admission and remains an explicit native action.
        await wait(async () => Array.isArray((await get('/api/v1/sessions')).sessions));
        const byProject = new Map(config.restoreProjects.map((projectId) => [projectId, { projectId, results: [] }]));
        for (const { project, ids: expected } of restorePlan) {
          // Reconciliation can mark old live sessions terminated before this
          // call. Permit only that captured live set, never historical rows.
          const result = JSON.parse(run(path.join(releaseRoot, 'native/ao'), ['session', 'restore', '--project', project,
            '--all', '--include-terminated', ...expected.flatMap((id) => ['--session-id', id]),
            '--concurrency', String(config.restoreConcurrency), '--json'], { env, timeout: 15 * 60 * 1000 + 10000 }));
          assertRelease(result.projectId === project && Array.isArray(result.results)
            && result.results.every((row) => ['restored', 'skipped_hold'].includes(row.outcome) && typeof row.reason === 'string'
              && (row.outcome !== 'restored' || row.reason === 'already_running' || row.restoreMode === 'native'))
            && objectSha256(result.results.map((row) => row.sessionId).sort()) === objectSha256(expected), 'install_first_restore_failed');
          byProject.get(project).results.push(...result.results);
          for(const id of expected) if(config.restoreLastSessionIDs?.includes(id)){file_manifest_checks.push(verifyRestoreFiles(config,baseline,id));}
        }
        for (const [project, result] of byProject) {
          const expected = firstRestoreIdentities(config,baseline).filter(row=>row.project_id===project)
            .map((row) => row.ao_session_id).sort();
          assertRelease(objectSha256(result.results.map((row) => row.sessionId).sort()) === objectSha256(expected),
            'install_first_restore_failed');
        }
        restore_results.push(...byProject.values());
      }
      await wait(async () => isStrictReadyz(await get('/readyz')));
      return { restore_results,...(file_manifest_checks.length?{file_manifest_checks}:{}) };
    },
    async restoreDatabase({ backup }) {
      assertRelease(fileSha256(backup.path) === backup.sha256, 'install_database_backup_invalid');
      assertRelease(ownershipFiles.every((file) => probeExclusiveLock(file, { expectHeld: false, flock: tools?.flock ?? toolResolver('flock', executionEnv) }) === true), 'install_previous_locks_held');
      if (backup.recovery?.exists) assertRelease(objectSha256(inventoryTree(backup.recovery.path, { exclude: [] })) === backup.recovery.sha256, 'install_database_backup_invalid');
      assertRelease(backup.recovery && path.dirname(backup.recovery.path) === path.dirname(backup.path), 'install_database_backup_invalid');
      fs.copyFileSync(backup.path, path.join(config.dataDir, 'ao.db'));
      const recoveryTarget = path.join(config.dataDir, 'spawn-attempts');
      try { assertRelease(!fs.lstatSync(recoveryTarget).isSymbolicLink(), 'install_database_backup_invalid'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.rmSync(recoveryTarget, { force: true, recursive: true });
      if (backup.recovery.exists) copyCustodyTree(backup.recovery.path, recoveryTarget);
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
