import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function deploymentBinding(home) {
  const root = path.join(home, '.local/share/ao-pilot/cie-runtime');
  return {schema_version:'ao.runtime-deployment.v1',data_dir:path.join(root,'data'),run_file:path.join(root,'running.json')};
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
