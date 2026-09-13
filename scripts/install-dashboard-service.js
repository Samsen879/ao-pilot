#!/usr/bin/env node
// Deployment writes generated user service configuration, never legacy state.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboardUnits } from './ao/lib/dashboard-service.js';
import { deploymentBinding } from './ao/lib/runtime-deployment.js';
const args = process.argv.slice(2);
if (args.some(arg => !['--install', '--replace', '--dashboard-only', '--recovery-only', '--terminal-access'].includes(arg)) || (args.includes('--dashboard-only') && args.includes('--recovery-only'))) throw new Error('Usage: node scripts/install-dashboard-service.js [--install [--replace] [--dashboard-only|--recovery-only] [--terminal-access]]');
const root = fileURLToPath(new URL('../', import.meta.url));
const units = buildDashboardUnits({ packageRoot: root.replace(/\/$/, ''), nodePath: process.execPath, home: os.homedir(), terminalAccess: args.includes('--terminal-access') });
if (args.includes('--dashboard-only')) {delete units['ao-pilot-runtime.service'];delete units['ao-pilot-session-recovery.service'];}
if (args.includes('--recovery-only')) {delete units['ao-pilot-runtime.service'];delete units['ao-pilot-dashboard.service'];}
const target = path.join(os.homedir(), '.config/systemd/user');
if (!args.includes('--install')) console.log(JSON.stringify({target,units}, null, 2));
else {
  for (const name of Object.keys(units)) if (fs.existsSync(path.join(target,name)) && !args.includes('--replace')) throw new Error(`Refusing to overwrite existing ${name}; inspect it before --replace`);
  fs.mkdirSync(target, {recursive:true,mode:0o700});
  for (const [name,body] of Object.entries(units)) {
    const file = path.join(target,name);
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.backup-${Date.now()}`);
    fs.writeFileSync(file, body, {mode:0o600});
  }
  if (!args.includes('--dashboard-only') && !args.includes('--recovery-only')) {
  const bindingDir = path.join(os.homedir(),'.config/ao-pilot');
  fs.mkdirSync(bindingDir,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(bindingDir,'runtime-binding.json'),JSON.stringify(deploymentBinding(os.homedir()),null,2),{mode:0o600});
  }
  console.log('Installed localhost-only user units. Run systemctl --user daemon-reload, then enable --now both units. Windows/WSL sign-in activation is a separate gate.');
}
