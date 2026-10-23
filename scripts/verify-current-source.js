#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gitIdentity, summarizeGo, summarizeVitest, commandOutcome, tmuxCleanupOutcome } from './ao/lib/current-source-evidence.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const suite = process.argv[2];
if (!['native', 'browser'].includes(suite) || process.argv.length !== 3) {
  console.error('Usage: node scripts/verify-current-source.js native|browser');
  process.exit(1);
}
const output = fs.mkdtempSync(path.join(process.env.AO_SOURCE_RECEIPT_DIR || os.tmpdir(), `source-${suite}-`));
const sandbox = fs.mkdtempSync('/tmp/ao-src-');
const home = path.join(sandbox, 'home');
fs.mkdirSync(home);
const env = { ...process.env, HOME: home, TMUX_TMPDIR: sandbox, NEXT_TELEMETRY_DISABLED: '1', GOTOOLCHAIN: 'local', CGO_ENABLED: '0', GOENV: 'off', GOWORK: 'off',
  AO_DATA_DIR: path.join(sandbox, 'data'), AO_RUN_FILE: path.join(sandbox, 'run.json'), AO_CONFIG_PATH: path.join(sandbox, 'invalid.yaml') };
for (const key of Object.keys(env)) if (key.startsWith('AO_') && !['AO_DATA_DIR', 'AO_RUN_FILE', 'AO_CONFIG_PATH'].includes(key)) delete env[key];
for (const key of ['GOFLAGS', 'GOEXPERIMENT', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'BASH_ENV', 'ENV']) delete env[key];
for (const key of Object.keys(env)) if (key.toLowerCase().startsWith('npm_config_')) delete env[key];
env.npm_config_cache = path.join(os.tmpdir(), `ao-source-npm-cache-${process.getuid()}`);
// Go module caches contain read-only directories. Keep reusable caches outside
// the disposable HOME so cleanup works for unprivileged CI users too.
env.GOMODCACHE ||= path.join(os.tmpdir(), `ao-source-gomodcache-${process.getuid()}`);
env.GOCACHE ||= path.join(os.tmpdir(), `ao-source-gocache-${process.getuid()}`);
delete env.TMUX;
delete env.TMUX_PANE;
fs.writeFileSync(env.AO_CONFIG_PATH, '[invalid yaml');
const workspaces = ['core', ...['agent-claude-code', 'agent-codex', 'agent-opencode', 'runtime-tmux', 'workspace-worktree', 'scm-github', 'tracker-github', 'tracker-linear'].map(name => `plugins/${name}`), 'web'];
const receipt = { schema_version: 'ao.current-source-check.v1', suite, platform: process.platform, scope: suite === 'native' ? 'Linux CGO=0; no Windows or race claim' : 'Linux browser source', status: 'RUNNING', started_at: new Date().toISOString(), steps: [] };
const save = () => fs.writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
function step(name, command, args, cwd, report) {
  const item = { name, command: [command, ...args], cwd: path.relative(root, cwd) || '.', status: 'NOT_RUN' };
  receipt.steps.push(item);
  return () => {
    const log = path.join(output, `${name}.log`);
    const stdout = path.join(output, `${name}.stdout`);
    const out = fs.openSync(stdout, 'wx');
    const err = fs.openSync(log, 'wx');
    item.status = 'RUNNING'; save();
    console.log(`[${suite}] ${name}: ${command} ${args.join(' ')}`);
    const childEnv = { ...env };
    // Only web's observer needs a deliberately invalid config. Core tests
    // exercise config discovery itself and must have no explicit override.
    if (cwd !== path.join(root, 'browser/packages/web')) delete childEnv.AO_CONFIG_PATH;
    let result;
    try { result = spawnSync(command, args, { cwd, env: childEnv, stdio: ['ignore', out, err], timeout: 20 * 60 * 1000, killSignal: 'SIGKILL', detached: true }); }
    finally { fs.closeSync(out); fs.closeSync(err); }
    if (result.error?.code === 'ETIMEDOUT' && result.pid) {
      try { process.kill(-result.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    Object.assign(item, commandOutcome(result, report ? () => report(stdout) : undefined));
    item.stdout = path.basename(stdout); item.stderr = path.basename(log);
    save();
    if (item.status !== 'PASS') throw new Error(`${name}: ${item.status}; ${item.report_error ?? ''}; see ${output}`);
    save();
  };
}
const commands = [];
const browser = path.join(root, 'browser');
if (suite === 'native') {
  const cwd = path.join(root, 'runtime/headless/backend');
  commands.push(step('go-version', 'go', ['version'], cwd, log => {
    const version = fs.readFileSync(log, 'utf8').trim();
    if (!version.startsWith('go version go1.25.7 ')) throw new Error(`Expected Go 1.25.7: ${version}`);
    return { toolchain: version };
  }));
  commands.push(step('go-build', 'go', ['build', './...'], cwd));
  commands.push(step('go-test', 'go', ['test', '-json', '-count=1', '-timeout=5m', './...'], cwd, log => summarizeGo(fs.readFileSync(log, 'utf8'))));
} else {
  commands.push(step('node-version', 'node', ['--version'], browser));
  commands.push(step('tmux-version', 'tmux', ['-V'], browser));
  commands.push(step('npm-ci', 'npm', ['ci', '--include=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], browser));
  commands.push(step('build-dependencies', 'npm', ['run', 'build:deps'], browser));
  for (const workspace of workspaces) {
    const name = workspace.replaceAll('/', '-');
    const cwd = path.join(browser, 'packages', workspace);
    const report = path.join(output, `${name}.json`);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const workerArgs = /^[~^]?[23]\./.test(manifest.devDependencies?.vitest ?? '') ? ['--minWorkers=1'] : [];
    commands.push(step(`${name}-typecheck`, 'npm', ['run', 'typecheck'], cwd));
    commands.push(step(`${name}-test`, 'npm', ['test', '--', '--maxWorkers=2', ...workerArgs, '--reporter=json', `--outputFile=${report}`], cwd,
      () => summarizeVitest(JSON.parse(fs.readFileSync(report, 'utf8')))));
  }
  commands.push(step('web-build', 'npm', ['run', 'build'], path.join(browser, 'packages/web')));
}
save();
try {
  if (process.platform !== 'linux') throw new Error('Current source gate currently supports Linux only');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer required');
  receipt.before = gitIdentity(root);
  if (process.env.AO_SOURCE_EXPECTED_HEAD && receipt.before.head !== process.env.AO_SOURCE_EXPECTED_HEAD) throw new Error('Source HEAD mismatch');
  if (process.env.AO_SOURCE_EXPECTED_TREE && receipt.before.tree !== process.env.AO_SOURCE_EXPECTED_TREE) throw new Error('Source tree mismatch');
  if (path.resolve(output).startsWith(path.resolve(root) + path.sep)) throw new Error('Source evidence output must be outside checkout');
  receipt.source_tree = spawnSync('git', ['rev-parse', `HEAD:${suite === 'native' ? 'runtime/headless/backend' : 'browser'}`], { cwd: root, encoding: 'utf8' }).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(receipt.source_tree)) throw new Error('Missing source subtree identity');
  if (suite === 'browser') for (const workspace of workspaces) {
    const cwd = path.join(browser, 'packages', workspace);
    for (const generated of ['dist', 'dist-server', '.next', 'tsconfig.tsbuildinfo', 'tsconfig.build.tsbuildinfo', 'tsconfig.server.tsbuildinfo']) {
      fs.rmSync(path.join(cwd, generated), { recursive: true, force: true });
    }
  }
  for (const command of commands) command();
  receipt.after = gitIdentity(root);
  if (JSON.stringify(receipt.before) !== JSON.stringify(receipt.after)) throw new Error('Source identity drifted during verification');
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = error.message;
  console.error(error.message); process.exitCode = 1;
} finally {
  // Never target the user's tmux server. Only this private socket can be removed.
  const socket = path.join(sandbox, `tmux-${process.getuid()}`, 'default');
  if (fs.existsSync(socket)) {
    const cleanup = spawnSync('tmux', ['-S', socket, 'kill-server'], { env, encoding: 'utf8', timeout: 10000 });
    const status = tmuxCleanupOutcome(cleanup, socket);
    receipt.tmux_cleanup = { status, exit_code: cleanup.status, stderr: cleanup.stderr };
    if (status === 'FAIL') { receipt.status = 'FAIL'; process.exitCode = 1; }
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
    receipt.sandbox_cleanup = { status: 'PASS' };
  } catch (error) {
    receipt.sandbox_cleanup = { status: 'FAIL', error: error.message };
    receipt.status = 'FAIL'; process.exitCode = 1;
  }
  receipt.finished_at = new Date().toISOString(); save();
  console.log(`Current source ${receipt.status}: ${path.join(output, 'receipt.json')}`);
}
