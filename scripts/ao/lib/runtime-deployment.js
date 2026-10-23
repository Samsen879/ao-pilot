import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import { resolveUnifiedRuntime } from './release-runtime.js';
import { validateInstallConfiguration } from './release-systemd.js';
import { renderReleaseUnits, validateEnvironmentOverride } from './release-units.js';
import { processStartToken } from './release-lock.js';
import { getDefaultRuntimeStore } from './runtime-bootstrap.js';
export function deploymentBinding(home) {
  const root = path.join(home, '.local/share/ao-pilot/cie-runtime');
  return {schema_version:'ao.runtime-deployment.v1',data_dir:path.join(root,'data'),run_file:path.join(root,'running.json')};
}

function inspectActiveRuntimeService(execute, readFile, realpath, unitName = 'ao-pilot-runtime.service') {
  const property = name => String(execute('systemctl', [
    '--user', 'show', unitName, `--property=${name}`, '--value',
  ], {encoding:'utf8',stdio:['ignore','pipe','pipe']})).trim();
  const activeState = property('ActiveState');
  const mainPid = property('MainPID');
  const fragmentPath = property('FragmentPath');
  const dropInPaths = property('DropInPaths');
  if (activeState !== 'active' || !/^[1-9][0-9]*$/.test(mainPid)) {
    throw new Error('Installed runtime service is not active; HOLD');
  }
  const procRoot = `/proc/${mainPid}`;
  const argv = readFile(path.join(procRoot, 'cmdline'))
    .toString('utf8').split('\0').filter(Boolean);
  const environment = Object.fromEntries(readFile(path.join(procRoot, 'environ'))
    .toString('utf8').split('\0').filter(Boolean).map(entry => {
      const separator = entry.indexOf('=');
      return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  const children = environment.AO_INSTALL_ROOT ? [mainPid] : readFile(path.join(procRoot, 'task', mainPid, 'children'), 'utf8')
    .trim().split(/\s+/).filter(Boolean);
  if (children.length !== 1 || !/^[1-9][0-9]*$/.test(children[0])) {
    throw new Error('Installed runtime service does not own exactly one daemon child; HOLD');
  }
  const daemonPid = children[0];
  const daemonRoot = `/proc/${daemonPid}`;
  const daemonArgv = readFile(path.join(daemonRoot, 'cmdline'))
    .toString('utf8').split('\0').filter(Boolean);
  const daemonEnvironment = Object.fromEntries(readFile(path.join(daemonRoot, 'environ'))
    .toString('utf8').split('\0').filter(Boolean).map(entry => {
      const separator = entry.indexOf('=');
      return separator < 1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  const daemonExecutable = realpath(path.join(daemonRoot, 'exe'));
  const daemonSha256 = crypto.createHash('sha256')
    .update(readFile(path.join(daemonRoot, 'exe'))).digest('hex');
  if (!path.isAbsolute(fragmentPath) || (!environment.AO_INSTALL_ROOT && dropInPaths !== '')) {
    throw new Error('Installed runtime service effective unit is not immutable; HOLD');
  }
  return {
    activeState,mainPid,packageRoot:realpath(path.join(procRoot, 'cwd')),argv,environment,
    daemonPid,daemonArgv,daemonEnvironment,daemonExecutable,daemonSha256,
    fragmentPath,dropInPaths,unitText:readFile(fragmentPath, 'utf8'),
    ...(environment.AO_INSTALL_ROOT ? { startToken: processStartToken(Number(mainPid)) } : {}),
  };
}

function unitDirectiveValues(unitText, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directive = new RegExp(`^${escapedName}\\s*=\\s*(.*)$`);
  return String(unitText ?? '').split(/\r?\n/)
    .map(line => line.trim())
    .map(line => line.match(directive))
    .filter(Boolean)
    .map(match => match[1]);
}

function unitEnvironmentAssignmentCount(values, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignment = new RegExp(`(?:^|[\\s"'])${escapedName}=`, 'g');
  return values.reduce((count, value) => count + [...value.matchAll(assignment)].length, 0);
}

export function resolveInstalledRuntimeServiceBinding({
  home = os.homedir(),
  env = process.env,
  readFile = fs.readFileSync,
  lstat = fs.lstatSync,
  realpath = fs.realpathSync,
  execute = childProcess.execFileSync,
  inspectService = () => inspectActiveRuntimeService(execute, readFile, realpath, env.AO_INSTALL_ROOT
    ? `${JSON.parse(readFile(path.join(env.AO_INSTALL_ROOT, 'installation.json'), 'utf8')).namespace}-runtime.service`
    : 'ao-pilot-runtime.service'),
} = {}) {
  const service = inspectService();
  if (service.environment?.AO_INSTALL_ROOT) {
    const root = service.environment.AO_INSTALL_ROOT;
    const resolution = resolveUnifiedRuntime({ env: { ...service.environment, AO_INSTALL_ROOT: root } });
    const configFile = service.environment.AO_INSTALL_CONFIG;
    if (!configFile || !path.isAbsolute(configFile)) throw new Error('Unified install config identity unknown; HOLD');
    const configuration = validateInstallConfiguration(JSON.parse(readFile(configFile, 'utf8')));
    const unitName = `${configuration.namespace}-runtime.service`;
    const expected = renderReleaseUnits({ installRoot: root, stateRoot: configuration.stateRoot,
      envFile: path.join(configuration.stateRoot, 'install.env'), nodePath: resolution.manifest.toolchain.node_executable,
      namespace: configuration.namespace })[unitName];
    const drops = service.dropInPaths?.trim() ? service.dropInPaths.trim().split(/\s+/) : [];
    if (configuration.installRoot !== root || service.activeState !== 'active'
      || service.packageRoot !== resolution.runtime_directory || service.fragmentPath !== path.join(configuration.unitRoot, unitName)
      || service.unitText !== expected || String(service.mainPid) !== String(service.daemonPid)
      || !service.startToken || service.daemonExecutable !== resolution.binary_path
      || service.daemonSha256 !== resolution.binary_sha256 || JSON.stringify(service.argv) !== JSON.stringify([resolution.binary_path, 'daemon'])
      || service.environment.AO_DATA_DIR !== configuration.dataDir
      || service.environment.AO_RUN_FILE !== path.join(configuration.discoveryDir, 'running.json')
      || drops.length > 1 || drops.some((file) => file !== path.join(configuration.unitRoot, `${unitName}.d/10-environment.conf`))) {
      throw new Error('Unified runtime service binding drifted; HOLD');
    }
    for (const drop of drops) {
      const values = validateEnvironmentOverride(readFile(drop, 'utf8'));
      if (Object.entries(values).some(([key, value]) => service.environment[key] !== value)) throw new Error('Unified environment override drifted; HOLD');
    }
    const confirmed = inspectService();
    if (String(confirmed.mainPid) !== String(service.mainPid) || confirmed.startToken !== service.startToken
      || confirmed.daemonSha256 !== service.daemonSha256 || confirmed.unitText !== service.unitText
      || confirmed.dropInPaths !== service.dropInPaths) throw new Error('Unified runtime changed during inspection; HOLD');
    return { package_root: resolution.runtime_directory, binary_path: resolution.binary_path,
      binary_sha256: resolution.binary_sha256, store_root: root, data_dir: configuration.dataDir,
      run_file: path.join(configuration.discoveryDir, 'running.json') };
  }

  const packageRoot = service.packageRoot;
  const expected = deploymentBinding(home);
  const dataDir = service.environment.AO_DATA_DIR;
  const runFile = service.environment.AO_RUN_FILE;
  const runtimeStore = service.environment.AO_PILOT_RUNTIME_STORE;
  const effectiveRuntimeStore = runtimeStore ?? getDefaultRuntimeStore({env:service.environment,homedir:home});
  const nodePath = service.argv[0];
  const foregroundPath = path.join(packageRoot, 'scripts', 'ao-runtime-foreground.js');
  const unitWorkingDirectories = unitDirectiveValues(service.unitText, 'WorkingDirectory');
  const unitExecStarts = unitDirectiveValues(service.unitText, 'ExecStart');
  const unitEnvironments = unitDirectiveValues(service.unitText, 'Environment');
  const hasExactUnitEnvironment = (name, value) => (
    unitEnvironmentAssignmentCount(unitEnvironments, name) === 1
    && unitEnvironments.includes(`"${name}=${value}"`)
  );
  const xdgDataHome = service.environment.XDG_DATA_HOME;
  const implicitStorePinned = runtimeStore != null || (
    xdgDataHome != null
    && path.isAbsolute(xdgDataHome)
    && !/[\r\n\x00"%\\]/.test(xdgDataHome)
    && hasExactUnitEnvironment('XDG_DATA_HOME', xdgDataHome)
  );
  if (
    service.activeState !== 'active'
    || !/^[1-9][0-9]*$/.test(String(service.mainPid))
    || !path.isAbsolute(packageRoot)
    || /[\r\n\x00"%\\]/.test(packageRoot)
    || realpath(packageRoot) !== packageRoot
    || service.argv.length !== 2
    || !path.isAbsolute(nodePath ?? '')
    || service.argv[1] !== foregroundPath
    || !path.isAbsolute(service.fragmentPath ?? '')
    || service.dropInPaths !== ''
    || unitWorkingDirectories.length !== 1
    || unitWorkingDirectories[0] !== packageRoot
    || unitExecStarts.length !== 1
    || unitExecStarts[0] !== `"${nodePath}" "${foregroundPath}"`
    || unitDirectiveValues(service.unitText, 'EnvironmentFile').length !== 0
    || unitDirectiveValues(service.unitText, 'UnsetEnvironment').length !== 0
    || unitEnvironments.some(value => value.trim() === '')
    || unitEnvironments.some(value => value.includes('\\'))
    || !hasExactUnitEnvironment('AO_DATA_DIR', dataDir)
    || !hasExactUnitEnvironment('AO_RUN_FILE', runFile)
    || (runtimeStore != null
      ? !hasExactUnitEnvironment('AO_PILOT_RUNTIME_STORE', runtimeStore)
      : unitEnvironmentAssignmentCount(unitEnvironments, 'AO_PILOT_RUNTIME_STORE') !== 0)
    || !implicitStorePinned
    || (runtimeStore != null
      && (!path.isAbsolute(runtimeStore) || /[\r\n\x00"%\\]/.test(runtimeStore)))
    || dataDir !== expected.data_dir
    || runFile !== expected.run_file
    || !/^[1-9][0-9]*$/.test(String(service.daemonPid))
    || service.daemonArgv?.length !== 2
    || service.daemonArgv?.[1] !== 'daemon'
    || service.daemonEnvironment?.AO_DATA_DIR !== dataDir
    || service.daemonEnvironment?.AO_RUN_FILE !== runFile
    || (runtimeStore != null
      && service.daemonEnvironment?.AO_PILOT_RUNTIME_STORE !== runtimeStore)
  ) {
    throw new Error('Installed runtime service binding drifted; HOLD');
  }
  const cliPath = path.join(packageRoot, 'bin', 'ao-pilot.js');
  const cliStat = lstat(cliPath);
  const foregroundStat = lstat(foregroundPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()
    || !foregroundStat.isFile() || foregroundStat.isSymbolicLink()) {
    throw new Error('Installed runtime service CLI is not an immutable regular file; HOLD');
  }
  const raw = execute(nodePath, [cliPath, 'runtime-path', '--json'], {
    cwd: packageRoot,
    env: {
      HOME: home,
      PATH: service.environment.PATH ?? path.dirname(nodePath),
      AO_DATA_DIR: dataDir,
      AO_RUN_FILE: runFile,
      AO_PILOT_RUNTIME_STORE: effectiveRuntimeStore,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(raw);
  if (
    report.status !== 'verified'
    || !path.isAbsolute(report.binary_path ?? '')
    || !/^[a-f0-9]{64}$/.test(report.binary_sha256 ?? '')
  ) {
    throw new Error('Installed runtime service provenance is not verified; HOLD');
  }
  if (service.daemonExecutable !== report.binary_path
    || service.daemonArgv[0] !== report.binary_path
    || service.daemonSha256 !== report.binary_sha256) {
    throw new Error('Active daemon child does not match verified runtime provenance; HOLD');
  }
  const confirmedService = inspectService();
  if (String(confirmedService.mainPid) !== String(service.mainPid)
    || confirmedService.packageRoot !== packageRoot
    || JSON.stringify(confirmedService.argv) !== JSON.stringify(service.argv)
    || String(confirmedService.daemonPid) !== String(service.daemonPid)
    || JSON.stringify(confirmedService.daemonArgv) !== JSON.stringify(service.daemonArgv)
    || confirmedService.fragmentPath !== service.fragmentPath
    || confirmedService.dropInPaths !== service.dropInPaths
    || confirmedService.unitText !== service.unitText
    || confirmedService.daemonEnvironment?.AO_DATA_DIR !== dataDir
    || confirmedService.daemonEnvironment?.AO_RUN_FILE !== runFile
    || (runtimeStore != null
      && confirmedService.daemonEnvironment?.AO_PILOT_RUNTIME_STORE !== runtimeStore)
    || confirmedService.daemonExecutable !== service.daemonExecutable
    || confirmedService.daemonSha256 !== service.daemonSha256) {
    throw new Error('Installed runtime service changed during inspection; HOLD');
  }
  return {
    package_root: packageRoot,
    binary_path: report.binary_path,
    binary_sha256: report.binary_sha256,
    store_root: effectiveRuntimeStore,
    data_dir: dataDir,
    run_file: runFile,
  };
}
export function resolveDeploymentEnvironment(env = process.env) {
  if (env.AO_INSTALL_ROOT) {
    const configuration = validateInstallConfiguration(JSON.parse(fs.readFileSync(path.join(env.AO_INSTALL_ROOT, 'installation.json'), 'utf8')));
    const runFile = path.join(configuration.discoveryDir, 'running.json');
    if (configuration.installRoot !== env.AO_INSTALL_ROOT
      || (env.AO_DATA_DIR && env.AO_DATA_DIR !== configuration.dataDir)
      || (env.AO_RUN_FILE && env.AO_RUN_FILE !== runFile)) throw new Error('Unified CLI namespace drifted; HOLD');
    return { ...env, AO_DATA_DIR: configuration.dataDir, AO_RUN_FILE: runFile,
      AO_CONFIG_PATH: configuration.configPath, AO_TMUX_SOCKET: configuration.tmuxSocket,
      AO_TMUX_UNIT: `${configuration.namespace}-tmux.service`, AO_TMUX_TMPDIR: configuration.tmuxTmpdir,
      TMUX_TMPDIR: configuration.tmuxTmpdir };
  }
  // Explicit test/private runtime bindings must never be mixed with deployment.
  if (env.AO_DATA_DIR || env.AO_RUN_FILE) return env;
  if (!env.HOME && env !== process.env) return env;
  const home = env.HOME || os.homedir();
  const file = path.join(home,'.config/ao-pilot/runtime-binding.json');
  if (!fs.existsSync(file)) return env;
  const value = JSON.parse(fs.readFileSync(file,'utf8'));
  const expected = deploymentBinding(home);
  if (value.schema_version !== expected.schema_version || value.data_dir !== expected.data_dir || value.run_file !== expected.run_file) throw new Error('Invalid AO Pilot deployment binding');
  return {...env,AO_DATA_DIR:value.data_dir,AO_RUN_FILE:value.run_file};
}
