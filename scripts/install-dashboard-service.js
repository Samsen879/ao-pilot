#!/usr/bin/env node
// Deployment writes generated user service configuration, never legacy state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardUnits } from './ao/lib/dashboard-service.js';
import { deploymentBinding } from './ao/lib/runtime-deployment.js';
const args = process.argv.slice(2);
if (args.some(arg => !['--install', '--replace'].includes(arg))) throw new Error('Usage: node scripts/install-dashboard-service.js [--install [--replace]]');
const root = fileURLToPath(new URL('../', import.meta.url));
const units = buildDashboardUnits({ packageRoot: root.replace(/\/$/, ''), nodePath: process.execPath, home: os.homedir() });
const target = path.join(os.homedir(), '.config/systemd/user');
if (!args.includes('--install')) console.log(JSON.stringify({target,units}, null, 2));
else {
  for (const name of Object.keys(units)) if (fs.existsSync(path.join(target,name)) && !args.includes('--replace')) throw new Error(`Refusing to overwrite existing ${name}; inspect it before --replace`);
  fs.mkdirSync(target, {recursive:true,mode:0o700});
  for (const [name,body] of Object.entries(units)) fs.writeFileSync(path.join(target,name), body, {mode:0o600});
  const bindingDir = path.join(os.homedir(),'.config/ao-pilot');
  fs.mkdirSync(bindingDir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(bindingDir,'runtime-binding.json'),JSON.stringify(deploymentBinding(os.homedir()),null,2),{mode:0o600});
  console.log('Installed localhost-only user units. Run systemctl --user daemon-reload, then enable --now both units. Windows/WSL sign-in activation is a separate gate.');
}
