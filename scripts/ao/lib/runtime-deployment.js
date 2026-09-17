import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
export function deploymentBinding(home) {
  const root = path.join(home, '.local/share/ao-pilot/cie-runtime');
  return {schema_version:'ao.runtime-deployment.v1',data_dir:path.join(root,'data'),run_file:path.join(root,'running.json')};
}

function unitValue(source, key) {
  const match = source.match(new RegExp(`^${key}=(.+)$`, 'm'));
  if (!match) throw new Error(`Installed runtime service is missing ${key}; HOLD`);
  return match[1].replace(/^"|"$/g, '');
}

function unitEnvironment(source, key) {
  const match = source.match(new RegExp(`^Environment="${key}=([^"\\r\\n]+)"$`, 'm'));
  if (!match) throw new Error(`Installed runtime service is missing ${key}; HOLD`);
  return match[1];
}

export function resolveInstalledRuntimeServiceBinding({
  home = os.homedir(),
  env = process.env,
  readFile = fs.readFileSync,
  lstat = fs.lstatSync,
  realpath = fs.realpathSync,
  execute = childProcess.execFileSync,
  nodePath = process.execPath,
} = {}) {
  const unitPath = path.join(home, '.config/systemd/user/ao-pilot-runtime.service');
  const source = readFile(unitPath, 'utf8');
  const packageRoot = unitValue(source, 'WorkingDirectory');
  const expected = deploymentBinding(home);
  const dataDir = unitEnvironment(source, 'AO_DATA_DIR');
  const runFile = unitEnvironment(source, 'AO_RUN_FILE');
  if (
    !path.isAbsolute(packageRoot)
    || /[\r\n\x00"%\\]/.test(packageRoot)
    || realpath(packageRoot) !== packageRoot
    || dataDir !== expected.data_dir
    || runFile !== expected.run_file
  ) {
    throw new Error('Installed runtime service binding drifted; HOLD');
  }
  const cliPath = path.join(packageRoot, 'bin', 'ao-pilot.js');
  const cliStat = lstat(cliPath);
  if (!cliStat.isFile() || cliStat.isSymbolicLink()) {
    throw new Error('Installed runtime service CLI is not an immutable regular file; HOLD');
  }
  const raw = execute(nodePath, [cliPath, 'runtime-path', '--json'], {
    cwd: packageRoot,
    env: { ...env, HOME: home, AO_DATA_DIR: dataDir, AO_RUN_FILE: runFile },
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
  return {
    package_root: packageRoot,
    binary_path: report.binary_path,
    binary_sha256: report.binary_sha256,
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
