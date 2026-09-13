#!/usr/bin/env node
// Build a committed snapshot before touching the existing Dashboard service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || args[0] !== '--deploy') throw new Error('Usage: node scripts/deploy-original-dashboard.js --deploy');
const run = (command, commandArgs, cwd = root) => execFileSync(command, commandArgs, {
  cwd, stdio: 'inherit', env: {...process.env, NODE_ENV: 'production'},
});
const git = gitArgs => execFileSync('git', gitArgs, {cwd: root, encoding: 'utf8'}).trim();
if (git(['status', '--porcelain', '--untracked-files=no'])) throw new Error('Commit tracked changes before deployment');
const commit = git(['rev-parse', 'HEAD']);
const tree = git(['rev-parse', 'HEAD^{tree}']);
const target = path.join(os.homedir(), '.local/share/ao-pilot/apps', `original-dashboard-${commit}`);
if (fs.existsSync(target)) throw new Error(`Refusing to overwrite existing installation: ${target}`);
const archive = execFileSync('git', ['archive', '--format=tar', commit], {cwd: root, maxBuffer: 32 * 1024 * 1024});
fs.mkdirSync(target, {recursive: true, mode: 0o700});
execFileSync('tar', ['-xf', '-', '-C', target], {input: archive});
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], target);
const browser = path.join(target, 'browser');
// Browser devDependencies are required for its TypeScript/Next.js build.
run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], browser);
run('npm', ['run', 'build:deps'], browser);
run('npm', ['run', 'build'], browser);
run(process.execPath, ['scripts/verify-browser-source.js'], target);
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const receipt = {
  schema_version: 'ao.original-dashboard-deployment.v1', commit, tree,
  installed_at: new Date().toISOString(), package_root: target,
  browser_lock_sha256: digest(path.join(browser, 'package-lock.json')),
  source_import_sha256: digest(path.join(browser, 'SOURCE_IMPORT.json')),
  next_build_id: fs.readFileSync(path.join(browser, 'packages/web/.next/BUILD_ID'), 'utf8').trim(),
  read_only: true, automation_enabled: false,
};
fs.writeFileSync(path.join(target, 'DEPLOYMENT.json'), JSON.stringify(receipt, null, 2) + '\n', {mode: 0o600});
run(process.execPath, ['scripts/install-dashboard-service.js', '--install', '--replace', '--dashboard-only'], target);
run('systemctl', ['--user', 'daemon-reload']);
run('systemctl', ['--user', 'restart', 'ao-pilot-dashboard.service']);
run('systemctl', ['--user', 'is-active', 'ao-pilot-dashboard.service']);
console.log(JSON.stringify(receipt, null, 2));
