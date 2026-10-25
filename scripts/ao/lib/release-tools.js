import fs from 'node:fs';
import path from 'node:path';
import { releaseError } from './release-manifest.js';
export const INSTALL_TOOLS = Object.freeze(['node', 'flock', 'systemctl', 'sqlite3', 'loginctl', 'ss', 'tmux', 'git']);
export function executableOnPath(name, env = process.env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); }
    catch { /* inspect every candidate without executing it */ }
  }
  return null;
}
export function checkInstallTools({ env = process.env, resolve = executableOnPath } = {}) {
  const tools = {}, missing = [];
  for (const name of INSTALL_TOOLS) {
    const file = resolve(name, env);
    if (!file || !path.isAbsolute(file)) missing.push(name); else tools[name] = file;
  }
  if (missing.length) throw Object.assign(releaseError('install_required_tools_missing', `Missing required tools: ${missing.join(', ')}`), { details: { missing, resolved: tools } });
  return Object.freeze(tools);
}
