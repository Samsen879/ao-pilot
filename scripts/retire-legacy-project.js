#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {retireLegacyProject} from './ao/lib/retirement-config.js';
const [configPath, mode] = process.argv.slice(2);
if (!configPath || !path.isAbsolute(configPath) || ![undefined, '--apply'].includes(mode) || process.argv.length > 4) throw new Error('Usage: node scripts/retire-legacy-project.js <absolute-existing-config> [--apply]');
const realPath = fs.realpathSync(configPath);
const source = fs.readFileSync(realPath, 'utf8');
const pilotPath = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const result = retireLegacyProject(source, pilotPath);
const receipt = {schema_version:'ao.legacy-project-retirement.v1', config_path:realPath, retired_project:result.retiredPath, projects:Object.keys(result.config.projects), session_state_moved:false, original_config_path_preserved:true, applied:false};
if (mode === '--apply' && result.retiredPath) {
  const backup = realPath + '.backup-' + Date.now();
  fs.copyFileSync(realPath, backup, fs.constants.COPYFILE_EXCL);
  const tmp = realPath + '.ao-pilot-' + crypto.randomUUID();
  fs.writeFileSync(tmp, result.text, {mode:fs.statSync(realPath).mode & 0o777, flag:'wx'});
  try {
    if (fs.readFileSync(realPath,'utf8') !== source) throw new Error('Config changed concurrently; HOLD');
    fs.renameSync(tmp, realPath);
  } finally { if(fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  receipt.applied=true;
  receipt.backup=backup;
}
console.log(JSON.stringify(receipt,null,2));
