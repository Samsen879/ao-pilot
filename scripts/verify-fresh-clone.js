#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStartToken } from './ao/lib/release-lock.js';
import { copyCustodyTree, probeExclusiveLock, validateInstallConfiguration } from './ao/lib/release-systemd.js';
import { fileSha256, verifyReleaseTree } from './ao/lib/release-manifest.js';
import { assertRuntimeLockArtifact, resolveUnifiedRuntime } from './ao/lib/release-runtime.js';
import { requiredPackageFiles, verifyPackedRelease } from './ao/lib/release-tarball.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const NETWORK_KEYS = [
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
];

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function requiredValue(argv, index, option) {
  const value = argv[index + 1];
  if (value == null || value.startsWith('-')) fail('fresh_clone_usage', `Missing value for ${option}`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    source: REPOSITORY_ROOT,
    ref: 'HEAD',
    cacheRoot: null,
    tempRoot: os.tmpdir(),
    receiptOut: null,
    expectedHead: null,
    keepOnFailure: false,
    tarball: process.env.AO_RELEASE_TARBALL ?? null,
    tarballSha256: process.env.AO_RELEASE_TARBALL_SHA256 ?? null,
    releasePayload: process.env.AO_RELEASE_BUNDLE ? path.join(process.env.AO_RELEASE_BUNDLE, 'payload') : null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--release-payload') {
      options.releasePayload = path.resolve(requiredValue(argv, index, argument)); index += 1;
    } else if (argument === '--tarball') {
      options.tarball = path.resolve(requiredValue(argv, index, argument)); index += 1;
    } else if (argument === '--sha256') {
      options.tarballSha256 = requiredValue(argv, index, argument); index += 1;
    } else if (argument === '--source') {
      options.source = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === '--ref') {
      options.ref = requiredValue(argv, index, argument);
      index += 1;
    } else if (argument === '--cache') {
      options.cacheRoot = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument === '--temp-root') {
      options.tempRoot = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument === '--receipt-out') {
      options.receiptOut = path.resolve(requiredValue(argv, index, argument));
      index += 1;
    } else if (argument === '--expected-head') {
      options.expectedHead = requiredValue(argv, index, argument).toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(options.expectedHead)) fail('fresh_clone_usage', 'Invalid value for --expected-head');
      index += 1;
    } else if (argument === '--keep-on-failure') {
      options.keepOnFailure = true;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      fail('fresh_clone_usage', `Unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return [
    'Usage: npm run verify:fresh-clone -- [options]',
    '',
    'Options:',
    '  --source <path|url>    Git source. Default: current exact repository',
    '  --release-payload <p> Complete frozen payload for supplied release tarball',
    '  --ref <ref>            Commit/ref to detach after clone. Default: HEAD',
    '  --cache <path>         Reusable verified runtime cache',
    '  --temp-root <path>     Parent for the isolated workspace',
    '  --receipt-out <path>   Persist the machine-readable gate receipt',
    '  --expected-head <sha>  Require the cloned exact commit (CI binding)',
    '  --keep-on-failure      Retain the isolated workspace for diagnosis',
    '  -h, --help             Show this help',
  ].join('\n');
}

function findExecutable(name, env = process.env) {
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    if (directory === '') continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Continue looking for an executable in the inherited toolchain only.
    }
  }
  fail('fresh_clone_tool_missing', `Required host tool is unavailable: ${name}`);
}

function createSafeToolPath(root, env = process.env) {
  const directory = path.join(root, 'safe-bin');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tools = {
    node: fs.realpathSync(process.execPath),
    npm: findExecutable('npm', env),
    git: findExecutable('git', env),
    curl: findExecutable('curl', env),
    tar: findExecutable('tar', env),
    gzip: findExecutable('gzip', env),
    dirname: findExecutable('dirname', env),
    sh: findExecutable('sh', env),
    flock: findExecutable('flock', env),
  };
  for (const [name, target] of Object.entries(tools)) {
    fs.symlinkSync(target, path.join(directory, name));
  }
  return { directory, tools };
}

function makeTemporaryTreeWritable(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o700);
    for (const entry of fs.readdirSync(target)) {
      makeTemporaryTreeWritable(path.join(target, entry));
    }
    return;
  }
  fs.chmodSync(target, 0o600);
}

export function removeTemporaryRoot(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error?.code) || !fs.existsSync(root)) throw error;
    makeTemporaryTreeWritable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function isolatedEnvironment(root, safePath, cacheRoot, inherited = process.env) {
  const home = path.join(root, 'home');
  const xdg = {
    config: path.join(root, 'xdg-config'),
    data: path.join(root, 'xdg-data'),
    state: path.join(root, 'xdg-state'),
    cache: path.join(root, 'xdg-cache'),
    runtime: path.join(root, 'xdg-runtime'),
  };
  for (const directory of [home, ...Object.values(xdg), cacheRoot]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const network = Object.fromEntries(NETWORK_KEYS
    .filter((key) => typeof inherited[key] === 'string' && inherited[key] !== '')
    .map((key) => [key, inherited[key]]));
  return {
    PATH: safePath,
    HOME: home,
    XDG_CONFIG_HOME: xdg.config,
    XDG_DATA_HOME: xdg.data,
    XDG_STATE_HOME: xdg.state,
    XDG_CACHE_HOME: xdg.cache,
    XDG_RUNTIME_DIR: xdg.runtime,
    AO_DATA_DIR: path.join(root, 'native-data'),
    AO_RUN_FILE: path.join(root, 'discovery/running.json'),
    NPM_CONFIG_CACHE: path.join(xdg.cache, 'npm'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
    CI: inherited.CI ?? 'true',
    LANG: 'C',
    LC_ALL: 'C',
    ...network,
  };
}

function run(command, args, {
  cwd,
  env,
  allowFailure = false,
  timeout = 20 * 60 * 1000,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
  const normalized = {
    status: Number.isInteger(result.status) ? result.status : null,
    signal: result.signal ?? null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? null,
  };
  if (!allowFailure && (normalized.status !== 0 || normalized.error != null)) {
    fail('fresh_clone_command_failed', `Command failed: ${path.basename(command)} ${args.join(' ')}`, {
      status: normalized.status,
      signal: normalized.signal,
      error: normalized.error,
      stdout: normalized.stdout.trim().slice(-4000),
      stderr: normalized.stderr.trim().slice(-4000),
    });
  }
  return normalized;
}

function parseJsonOutput(result, stream = 'stdout') {
  const value = result[stream].trim();
  try {
    return JSON.parse(value);
  } catch {
    fail('fresh_clone_output_invalid', `Expected JSON on ${stream}`, {
      status: result.status,
      output: value.slice(-4000),
    });
  }
}

function assertEqual(actual, expected, code, message) {
  if (actual !== expected) fail(code, message, { expected, observed: actual });
}

function snapshotTree(root) {
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .flatMap((entry) => {
        const resolved = path.join(directory, entry.name);
        const relative = path.relative(root, resolved).replaceAll('\\', '/');
        if (entry.isSymbolicLink()) return [`symlink:${relative}:${fs.readlinkSync(resolved)}`];
        if (entry.isDirectory()) return [`directory:${relative}`, ...walk(resolved)];
        const digest = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
        return [`file:${relative}:${digest}`];
      });
  }
  return walk(root);
}

function createInterruptedBootstrapFixture(firstBootstrap) {
  const runtimeDirectory = firstBootstrap.runtime.runtime_directory;
  const targetParent = path.dirname(runtimeDirectory);
  const commitSha = firstBootstrap.runtime.source.commit_sha;
  const deadPid = 2_000_000_000;
  const lockPath = path.join(targetParent, `.bootstrap-${commitSha}.lock`);
  const stagePath = path.join(targetParent, `.staging-${commitSha}-${deadPid}-freshclone`);
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), `${JSON.stringify({
    schema_version: 'ao.runtime-bootstrap-owner.v1',
    pid: deadPid,
    process_start_token: 'dead-fresh-clone-fixture',
    started_at: '2000-01-01T00:00:00.000Z',
    commit_sha: commitSha,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.mkdirSync(stagePath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stagePath, 'interrupted'), 'bounded fixture\n', { mode: 0o600 });
  return { lockPath, stagePath };
}

function commandPath(tools, name) {
  return tools[name] ?? fail('fresh_clone_tool_missing', `Missing safe tool: ${name}`);
}

export function assertStrictReady(output) {
  const explicit = output?.state === 'ready' || output?.ready === true || output?.ready === 'ready';
  if (!explicit || (output?.ready != null && output.ready !== true && output.ready !== 'ready')
    || (output?.status != null && output.status !== 'ready') || (output?.state != null && output.state !== 'ready')
    || ['reasons', 'degraded_reasons'].some((name) => output?.[name] != null && (!Array.isArray(output[name]) || output[name].length !== 0))) {
    fail('fresh_clone_daemon_not_ready', 'Runtime lacks explicit non-degraded readiness');
  }
  return true;
}
export function assertOwnedDaemonGone({ pid, startToken, lockFiles }, {
  readStartToken = processStartToken, probeLock = (file) => probeExclusiveLock(file, { expectHeld: false }),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !startToken || !Array.isArray(lockFiles) || lockFiles.length !== 2) {
    fail('fresh_clone_exit_unknown', 'Owned daemon identity or lock evidence is unavailable');
  }
  try {
    if (readStartToken(pid) === startToken) fail('fresh_clone_daemon_leaked', 'Owned daemon is still present after stop');
  } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  if (!lockFiles.every((file) => probeLock(file) === true)) fail('fresh_clone_exit_unknown', 'Daemon ownership locks were not proven available');
  return true;
}

// Bootstrap exercises the archived lock. Lifecycle acceptance for a supplied
// release must instead execute the exact daemon carried by that package.
export function bindPackedRuntime({ root, packageRoot, installedPackageRoot, env, expectedHead, expectedTree }) {
  const manifest = verifyReleaseTree(packageRoot);
  if (manifest.commit !== expectedHead || manifest.tree !== expectedTree) fail('fresh_clone_package_source_mismatch', 'Package does not match the exact cloned source');
  assertRuntimeLockArtifact(packageRoot, manifest);
  if (fileSha256(path.join(installedPackageRoot, 'release.json')) !== fileSha256(path.join(packageRoot, 'release.json'))) fail('fresh_clone_installed_package_drift', 'Installed manifest differs from verified release');
  for (const entry of requiredPackageFiles(manifest)) {
    const installed = path.join(installedPackageRoot, entry.path);
    const stat = fs.lstatSync(installed);
    const matches = entry.type === 'file' ? stat.isFile() && fileSha256(installed) === entry.sha256
      && Boolean(stat.mode & 0o111) === Boolean(entry.mode & 0o111)
      : stat.isSymbolicLink() && fs.readlinkSync(installed) === entry.target;
    if (!matches) fail('fresh_clone_installed_package_drift', 'Installed package differs from verified release');
  }
  const installRoot = path.join(root, 'packed-install');
  const releaseRoot = path.join(installRoot, 'releases', manifest.release_id);
  const config = validateInstallConfiguration({
    schema_version: 'ao.install-config.v1', namespace: 'ao-pilot-staging-fresh',
    installRoot, stateRoot: root, unitRoot: path.join(root, 'units'),
    dataDir: env.AO_DATA_DIR, discoveryDir: path.dirname(env.AO_RUN_FILE),
    configPath: path.join(root, 'ao.yaml'), controlPlaneRoot: path.join(root, 'control'),
    trustedHostDirectory: path.join(root, 'trusted-host'), tmuxTmpdir: path.join(root, 'tmux'),
    tmuxSocket: 'ao-pilot-staging-fresh', terminalTokenFile: path.join(root, 'terminal-token'),
    daemonURL: 'http://127.0.0.1:43101', terminalURL: 'ws://127.0.0.1:43102/terminal',
    terminalOrigin: 'http://127.0.0.1:43102', terminalCanaryPrefix: 'canary:',
    listenPorts: [43101, 43100, 43102, 43103, 43104], cliPath: path.join(root, 'cli'),
  });
  fs.mkdirSync(path.dirname(releaseRoot), { recursive: true, mode: 0o700 });
  copyCustodyTree(packageRoot, releaseRoot);
  fs.symlinkSync(path.relative(installRoot, releaseRoot), path.join(installRoot, 'current'));
  fs.writeFileSync(path.join(installRoot, 'installation.json'), JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(config.configPath, JSON.stringify({ defaults: { agent: 'claude-code' }, projects: {} }), { mode: 0o600 });
  fs.mkdirSync(config.tmuxTmpdir, { mode: 0o700 });
  const boundEnv = { ...env, AO_INSTALL_ROOT: installRoot, AO_CONFIG_PATH: config.configPath,
    AO_PORT: String(config.listenPorts[0]), AO_TMUX_SOCKET: config.tmuxSocket,
    AO_TMUX_UNIT: `${config.namespace}-tmux.service`, AO_TMUX_TMPDIR: config.tmuxTmpdir,
    TMUX_TMPDIR: config.tmuxTmpdir, AO_INSTALL_NAMESPACE: config.namespace,
    AO_MANAGED_RUNTIME_DATA_DIR: config.dataDir, AO_MANAGED_RUNTIME_RUN_FILE: env.AO_RUN_FILE,
    AO_MANAGED_RUNTIME_BINARY: path.join(releaseRoot, manifest.components.daemon.entrypoint),
    AO_MANAGED_RUNTIME_BINARY_SHA256: manifest.runtime_lock.binary_sha256,
    AO_RELEASE_ID: manifest.release_id, AO_RELEASE_ROOT: releaseRoot };
  const runtime = resolveUnifiedRuntime({ env: boundEnv });
  if (runtime.source.commit_sha !== expectedHead || runtime.source.tree_sha !== expectedTree) fail('fresh_clone_package_source_mismatch', 'Runtime provenance does not match the cloned source');
  return { env: boundEnv, storeRoot: installRoot, cli: path.join(installedPackageRoot, 'bin/ao-pilot.js'), runtime };
}

export async function verifyFreshClone(options, {
  inheritedEnv = process.env,
  now = () => new Date().toISOString(),
} = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    fail('fresh_clone_platform_unsupported', 'Fresh-clone runtime gate supports locked Linux targets only', {
      platform: process.platform,
      arch: process.arch,
    });
  }
  if (options.tarball && !options.releasePayload) fail('fresh_clone_release_payload_required', 'Supplied release requires its complete frozen payload');
  fs.mkdirSync(options.tempRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(options.tempRoot, 'ao-pilot-fresh-clone-'));
  const cloneRoot = path.join(root, 'clone');
  let storeRoot = path.join(root, 'runtime-store');
  const cacheRoot = options.cacheRoot ?? path.join(root, 'runtime-cache');
  const fixtureWorktree = path.join(root, 'worker-worktree-fixture');
  let started = false;
  let runtimeStopRequired = false;
  let passed = false;
  let env;
  let node;
  let cli;
  try {
    const safe = createSafeToolPath(root, inheritedEnv);
    env = isolatedEnvironment(root, safe.directory, cacheRoot, inheritedEnv);
    node = commandPath(safe.tools, 'node');
    const git = commandPath(safe.tools, 'git');
    const npm = commandPath(safe.tools, 'npm');

    run(git, ['-c', 'protocol.file.allow=always', 'clone', '--no-hardlinks', '--no-checkout', options.source, cloneRoot], {
      cwd: root,
      env,
    });
    run(git, ['checkout', '--detach', options.ref], { cwd: cloneRoot, env });
    const sourceHead = run(git, ['rev-parse', 'HEAD^{commit}'], { cwd: cloneRoot, env }).stdout.trim();
    const sourceTree = run(git, ['rev-parse', 'HEAD^{tree}'], { cwd: cloneRoot, env }).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sourceHead) || !/^[0-9a-f]{40}$/.test(sourceTree)) {
      fail('fresh_clone_source_invalid', 'Fresh clone did not resolve an exact commit and tree');
    }
    if (options.expectedHead != null && sourceHead !== options.expectedHead) {
      fail('fresh_clone_head_mismatch', 'Fresh clone does not match the required exact HEAD', {
        expected: options.expectedHead,
        observed: sourceHead,
      });
    }

    run(npm, ['ci'], { cwd: cloneRoot, env });
    const cleanAfterInstall = run(git, ['status', '--porcelain'], { cwd: cloneRoot, env }).stdout.trim() === '';
    if (!cleanAfterInstall) fail('fresh_clone_install_dirty', 'npm ci changed tracked or unignored source files');

    let installedPackage = cloneRoot;
    if (options.tarball) {
      if (!/^[a-f0-9]{64}$/.test(options.tarballSha256 ?? '')
        || createHash('sha256').update(fs.readFileSync(options.tarball)).digest('hex') !== options.tarballSha256) fail('fresh_clone_tarball_mismatch', 'Pinned package is unavailable or changed');
      const manifest = verifyReleaseTree(options.releasePayload);
      verifyPackedRelease(options.tarball, options.releasePayload, manifest);
      if (manifest.commit !== sourceHead || manifest.tree !== sourceTree) fail('fresh_clone_package_source_mismatch', 'Package does not match the exact cloned source');
      const consumer = path.join(root, 'packed-consumer'); fs.mkdirSync(consumer);
      fs.writeFileSync(path.join(consumer, 'package.json'), '{"private":true}');
      run(npm, ['install', '--ignore-scripts', options.tarball], { cwd: consumer, env });
      installedPackage = path.join(consumer, 'node_modules/ao-pilot');
    }
    cli = path.join(installedPackage, 'bin', 'ao-pilot.js');
    const preBootstrap = run(node, [cli, 'runtime-path', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
      allowFailure: true,
    });
    assertEqual(preBootstrap.status, 2, 'fresh_clone_missing_runtime_not_blocked', 'Missing runtime must fail closed');
    const preBootstrapFailure = parseJsonOutput(preBootstrap, 'stderr');
    assertEqual(preBootstrapFailure.code, 'runtime_missing', 'fresh_clone_missing_runtime_wrong_code', 'Missing runtime returned the wrong blocker');

    const bootstrapScript = path.join(installedPackage, 'scripts', 'bootstrap.sh');
    const firstBootstrap = parseJsonOutput(run(bootstrapScript, [
      '--store', storeRoot,
      '--cache', cacheRoot,
      '--json',
    ], { cwd: cloneRoot, env }));
    assertEqual(firstBootstrap.status, 'installed', 'fresh_clone_bootstrap_not_installed', 'First bootstrap did not install the runtime');

    const interruptedFixture = createInterruptedBootstrapFixture(firstBootstrap);
    const recoveredBootstrap = parseJsonOutput(run(bootstrapScript, [
      '--store', storeRoot,
      '--cache', cacheRoot,
      '--offline',
      '--json',
    ], { cwd: cloneRoot, env }));
    assertEqual(recoveredBootstrap.status, 'reused', 'fresh_clone_replay_not_reused', 'Offline replay did not reuse the runtime');
    assertEqual(recoveredBootstrap.offline, true, 'fresh_clone_replay_not_offline', 'Offline replay did not preserve offline mode');
    assertEqual(recoveredBootstrap.recovered_interrupted_bootstrap, true, 'fresh_clone_interruption_not_recovered', 'Interrupted bootstrap ownership was not recovered');
    if (fs.existsSync(interruptedFixture.lockPath) || fs.existsSync(interruptedFixture.stagePath)) {
      fail('fresh_clone_interruption_leaked', 'Interrupted bootstrap fixture was not cleaned');
    }

    const reinstalledBootstrap = parseJsonOutput(run(bootstrapScript, [
      '--store', storeRoot,
      '--cache', cacheRoot,
      '--offline',
      '--reinstall',
      '--json',
    ], { cwd: cloneRoot, env }));
    assertEqual(reinstalledBootstrap.status, 'reinstalled', 'fresh_clone_reinstall_failed', 'Verified offline reinstall did not complete');
    assertEqual(reinstalledBootstrap.offline, true, 'fresh_clone_reinstall_not_offline', 'Reinstall unexpectedly used the network');

    const shadowRoot = path.join(root, 'wrong-package', 'node_modules', '.bin');
    const shadowMarker = path.join(root, 'wrong-package-executed');
    fs.mkdirSync(shadowRoot, { recursive: true, mode: 0o700 });
    const shadowBinary = path.join(shadowRoot, 'ao');
    fs.writeFileSync(shadowBinary, `#!/bin/sh\nprintf invoked > ${JSON.stringify(shadowMarker)}\n`, { mode: 0o700 });
    const shadowed = run(node, [cli, 'runtime-path', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env: { ...env, PATH: `${shadowRoot}${path.delimiter}${env.PATH}` },
      allowFailure: true,
    });
    assertEqual(shadowed.status, 2, 'fresh_clone_shadow_not_blocked', 'Wrong same-name package did not fail closed');
    const shadowFailure = parseJsonOutput(shadowed, 'stderr');
    assertEqual(shadowFailure.code, 'runtime_path_shadowed', 'fresh_clone_shadow_wrong_code', 'PATH shadowing returned the wrong blocker');
    if (fs.existsSync(shadowMarker)) fail('fresh_clone_shadow_executed', 'Wrong same-name binary was executed');

    if (options.tarball) {
      const packed = bindPackedRuntime({ root, packageRoot: options.releasePayload, installedPackageRoot: installedPackage,
        env, expectedHead: sourceHead, expectedTree: sourceTree });
      env = packed.env; storeRoot = packed.storeRoot; cli = packed.cli;
    }
    const runtimePath = parseJsonOutput(run(node, [cli, 'runtime-path', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
    }));
    assertEqual(runtimePath.status, 'verified', 'fresh_clone_runtime_not_verified', 'Runtime provenance did not verify');

    const disabledStartRoot = path.join(root, 'disabled-start-boundary');
    const disabledStartPaths = {
      home: path.join(disabledStartRoot, 'home'),
      cwd: path.join(disabledStartRoot, 'cwd'),
      data: path.join(disabledStartRoot, 'data'),
      run: path.join(disabledStartRoot, 'run', 'running.json'),
      temp: path.join(disabledStartRoot, 'tmp'),
      config: path.join(disabledStartRoot, 'xdg-config'),
      cache: path.join(disabledStartRoot, 'xdg-cache'),
      state: path.join(disabledStartRoot, 'xdg-state'),
    };
    for (const directory of [
      disabledStartPaths.home,
      disabledStartPaths.cwd,
      disabledStartPaths.data,
      path.dirname(disabledStartPaths.run),
      disabledStartPaths.temp,
      disabledStartPaths.config,
      disabledStartPaths.cache,
      disabledStartPaths.state,
    ]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const disabledStartBefore = snapshotTree(disabledStartRoot);
    const disabledStart = run(runtimePath.binary_path, ['start'], {
      cwd: disabledStartPaths.cwd,
      env: {
        ...env,
        HOME: disabledStartPaths.home,
        AO_DATA_DIR: disabledStartPaths.data,
        AO_RUN_FILE: disabledStartPaths.run,
        TMPDIR: disabledStartPaths.temp,
        XDG_CONFIG_HOME: disabledStartPaths.config,
        XDG_CACHE_HOME: disabledStartPaths.cache,
        XDG_STATE_HOME: disabledStartPaths.state,
        AO_NETWORK_DISABLED: '1',
        ALL_PROXY: 'http://127.0.0.1:1',
        HTTPS_PROXY: 'http://127.0.0.1:1',
        HTTP_PROXY: 'http://127.0.0.1:1',
        NO_PROXY: '',
      },
      allowFailure: true,
      timeout: 5_000,
    });
    assertEqual(disabledStart.status, 1, 'fresh_clone_desktop_start_exit', 'Locked runtime start did not fail closed');
    assertEqual(disabledStart.signal, null, 'fresh_clone_desktop_start_signal', 'Locked runtime start was terminated by a signal');
    assertEqual(disabledStart.error, null, 'fresh_clone_desktop_start_error', 'Locked runtime start did not execute deterministically');
    if (!disabledStart.stderr.includes("desktop entrypoint disabled: use ao-pilot's governed headless lifecycle")) {
      fail('fresh_clone_desktop_start_message', 'Locked runtime start did not return the admitted fail-closed error');
    }
    const disabledStartAfter = snapshotTree(disabledStartRoot);
    if (JSON.stringify(disabledStartAfter) !== JSON.stringify(disabledStartBefore)) {
      fail('fresh_clone_desktop_start_side_effect', 'Locked runtime start mutated the isolated filesystem boundary', {
        before: disabledStartBefore,
        after: disabledStartAfter,
      });
    }

    runtimeStopRequired = true;
    const start = parseJsonOutput(run(node, [cli, 'start', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
      timeout: 30_000,
    }));
    if (start.status === 'already_running') {
      runtimeStopRequired = false;
      fail('fresh_clone_daemon_preexisting', 'Isolated HOME already had a reachable runtime daemon; refusing to stop a daemon this gate did not create');
    }
    if (start.status !== 'started') {
      fail('fresh_clone_start_failed', 'Verified runtime daemon did not start', { status: start.status });
    }
    started = true;
    const status = parseJsonOutput(run(node, [cli, 'status', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
      timeout: 30_000,
    }));
    assertEqual(status.status, 'completed', 'fresh_clone_status_failed', 'Verified runtime status command failed');
    assertStrictReady(status.output);
    const ownedPid = status.output?.pid ?? start.daemon_status?.pid;
    if (!Number.isSafeInteger(ownedPid) || ownedPid <= 0) fail('fresh_clone_exit_unknown', 'Runtime did not expose an owned PID');
    const ownedStartToken = processStartToken(ownedPid);
    if (fs.realpathSync(`/proc/${ownedPid}/exe`) !== fs.realpathSync(runtimePath.binary_path)
      || processStartToken(ownedPid) !== ownedStartToken) fail('fresh_clone_exit_unknown', 'Runtime identity changed during binding');

    const doctor = parseJsonOutput(run(node, [cli, 'doctor', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
      timeout: 30_000,
    }));
    assertEqual(doctor.runtime?.status, 'verified', 'fresh_clone_doctor_runtime_failed', 'Doctor did not verify exact runtime provenance');

    run(git, ['worktree', 'add', '--detach', fixtureWorktree, sourceHead], { cwd: cloneRoot, env });
    const listedWithFixture = run(git, ['worktree', 'list', '--porcelain'], { cwd: cloneRoot, env }).stdout;
    if (!listedWithFixture.includes(`worktree ${fixtureWorktree}`)) {
      fail('fresh_clone_worktree_missing', 'Bounded Worker worktree fixture was not observable');
    }
    run(git, ['worktree', 'remove', fixtureWorktree], { cwd: cloneRoot, env });
    run(git, ['worktree', 'prune'], { cwd: cloneRoot, env });
    const listedAfterCleanup = run(git, ['worktree', 'list', '--porcelain'], { cwd: cloneRoot, env }).stdout;
    if (fs.existsSync(fixtureWorktree) || listedAfterCleanup.includes(`worktree ${fixtureWorktree}`)) {
      fail('fresh_clone_worktree_leaked', 'Bounded Worker worktree fixture leaked after cleanup');
    }

    const stop = parseJsonOutput(run(node, [cli, 'stop', '--runtime-store', storeRoot, '--json'], {
      cwd: cloneRoot,
      env,
      timeout: 30_000,
    }));
    assertEqual(stop.status, 'completed', 'fresh_clone_stop_failed', 'Verified runtime daemon did not stop');
    const exitDeadline = Date.now() + 5000;
    while (Date.now() < exitDeadline) {
      try { if (processStartToken(ownedPid) !== ownedStartToken) break; }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) break; throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertOwnedDaemonGone({ pid: ownedPid, startToken: ownedStartToken, lockFiles: [
      path.join(env.AO_DATA_DIR, '.daemon-owner.lock'), path.join(path.dirname(env.AO_RUN_FILE), '.daemon-discovery.lock'),
    ] }, { probeLock: (file) => probeExclusiveLock(file, { expectHeld: false,
      run: (_command, args, settings) => spawnSync(commandPath(safe.tools, 'flock'), args, { ...settings, env }),
    }) });
    started = false; runtimeStopRequired = false;
    if (options.tarball && createHash('sha256').update(fs.readFileSync(options.tarball)).digest('hex') !== options.tarballSha256) fail('fresh_clone_tarball_mismatch', 'Package bytes changed during fresh-clone verification');

    const finalClean = run(git, ['status', '--porcelain'], { cwd: cloneRoot, env }).stdout.trim() === '';
    if (!finalClean) fail('fresh_clone_source_dirty', 'Fresh clone was dirty after runtime smoke');

    const receipt = {
      schema_version: 'ao.fresh-clone-release-gate.v1',
      status: 'passed',
      performed_at: now(),
      source: {
        repository: options.source,
        requested_ref: options.ref,
        head_sha: sourceHead,
        tree_sha: sourceTree,
        clean_after_install_and_smoke: finalClean,
      },
      isolation: {
        empty_home: true,
        old_home_read: false,
        old_agent_orchestrator_state_read: false,
        credential_copy_performed: false,
        global_npm_link_used: false,
        trusted_path_ao_present: false,
      },
      install: {
        command: 'npm ci',
        status: 'passed',
        ...(options.tarball ? { tarball_sha256: options.tarballSha256, runtime_source: 'verified_packed_release' } : {}),
      },
      bootstrap: {
        command: './scripts/bootstrap.sh',
        initial_status: firstBootstrap.status,
        replay_status: recoveredBootstrap.status,
        interrupted_bootstrap_recovered: recoveredBootstrap.recovered_interrupted_bootstrap,
        offline_reuse: recoveredBootstrap.offline,
        clean_reinstall_status: reinstalledBootstrap.status,
        clean_reinstall_offline: reinstalledBootstrap.offline,
      },
      runtime: {
        runtime_ref: runtimePath.runtime_ref,
        lock_digest: runtimePath.lock_digest,
        repository: runtimePath.source.repository,
        version: runtimePath.source.version,
        tag: runtimePath.source.tag,
        commit_sha: runtimePath.source.commit_sha,
        tree_sha: runtimePath.source.tree_sha,
        integrity: runtimePath.source.integrity,
        binary_path: runtimePath.binary_path,
        binary_sha256: runtimePath.binary_sha256,
      },
      negative_probes: {
        no_runtime_installed: preBootstrapFailure.code,
        wrong_same_name_package: shadowFailure.code,
        path_shadow_binary_executed: false,
        disabled_desktop_start: {
          exit_code: disabledStart.status,
          signal: disabledStart.signal,
          filesystem_mutation: false,
          network_posture: 'disabled_and_loopback_refused_proxy',
          expected_error_observed: true,
        },
        mutable_ref_wrong_integrity_incompatibility: 'covered_by_required_runtime_contract_tests',
      },
      lifecycle: {
        start: start.status,
        status: status.status,
        daemon_ready: true,
        doctor_runtime: doctor.runtime.status,
        github_auth_available: doctor.authentication?.github?.available === true,
        codex_auth_available: doctor.authentication?.codex?.available === true,
        stop: stop.status,
        daemon_leaked: false,
        ownership_locks_verified: true,
      },
      worker_worktree_fixture: {
        adapter: 'local_git',
        created: true,
        independently_bound: true,
        cleaned: true,
      },
      claim_boundary: {
        package_portability: true,
        runtime_bootstrap: true,
        fresh_clone_runtime_smoke: true,
        live_github_delivery: false,
        workstation_self_hosting: false,
        p0_r08_satisfied: false,
      },
    };
    if (options.receiptOut != null) {
      fs.mkdirSync(path.dirname(options.receiptOut), { recursive: true });
      fs.writeFileSync(options.receiptOut, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }
    passed = true;
    return receipt;
  } finally {
    if ((started || runtimeStopRequired) && node != null && env != null && fs.existsSync(cloneRoot)) {
      run(node, [cli, 'stop', '--runtime-store', storeRoot, '--json'], {
        cwd: cloneRoot,
        env,
        allowFailure: true,
        timeout: 30_000,
      });
    }
    if (passed || !options.keepOnFailure) removeTemporaryRoot(root);
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const receipt = await verifyFreshClone(options);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: error.code ?? 'fresh_clone_gate_failed',
      message: error.message,
      details: error.details ?? {},
    }, null, 2)}\n`);
    process.exitCode = error.code === 'fresh_clone_usage' ? 4 : 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) await main();
