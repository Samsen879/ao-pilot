import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
export function deploymentBinding(home) {
  const root = path.join(home, '.local/share/ao-pilot/cie-runtime');
  return {schema_version:'ao.runtime-deployment.v1',data_dir:path.join(root,'data'),run_file:path.join(root,'running.json')};
}

function inspectActiveRuntimeService(execute, readFile, realpath) {
  const property = name => String(execute('systemctl', [
    '--user', 'show', 'ao-pilot-runtime.service', `--property=${name}`, '--value',
  ], {encoding:'utf8',stdio:['ignore','pipe','pipe']})).trim();
  const activeState = property('ActiveState');
  const mainPid = property('MainPID');
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
  const children = readFile(path.join(procRoot, 'task', mainPid, 'children'), 'utf8')
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
  return {
    activeState,mainPid,packageRoot:realpath(path.join(procRoot, 'cwd')),argv,environment,
    daemonPid,daemonArgv,daemonEnvironment,daemonExecutable,daemonSha256,
  };
}

export function resolveInstalledRuntimeServiceBinding({
  home = os.homedir(),
  env = process.env,
  readFile = fs.readFileSync,
  lstat = fs.lstatSync,
  realpath = fs.realpathSync,
  execute = childProcess.execFileSync,
  inspectService = () => inspectActiveRuntimeService(execute, readFile, realpath),
} = {}) {
  const service = inspectService();
  const packageRoot = service.packageRoot;
  const expected = deploymentBinding(home);
  const dataDir = service.environment.AO_DATA_DIR;
  const runFile = service.environment.AO_RUN_FILE;
  const runtimeStore = service.environment.AO_PILOT_RUNTIME_STORE;
  const effectiveRuntimeStore = runtimeStore ?? path.join(home, '.local/share/ao-pilot/runtimes');
  const nodePath = service.argv[0];
  const foregroundPath = path.join(packageRoot, 'scripts', 'ao-runtime-foreground.js');
  if (
    service.activeState !== 'active'
    || !/^[1-9][0-9]*$/.test(String(service.mainPid))
    || !path.isAbsolute(packageRoot)
    || /[\r\n\x00"%\\]/.test(packageRoot)
    || realpath(packageRoot) !== packageRoot
    || service.argv.length !== 2
    || !path.isAbsolute(nodePath ?? '')
    || service.argv[1] !== foregroundPath
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
