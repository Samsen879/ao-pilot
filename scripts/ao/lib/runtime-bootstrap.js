import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  computeBootstrapToolchainLockDigest,
  loadBootstrapToolchainLock,
} from './runtime-bootstrap-contract.js';
import { computeRuntimeLockDigest, loadRuntimeLock } from './runtime-lock.js';
import { createRuntimeProvenance, RUNTIME_PROVENANCE_FILENAME } from './runtime-provenance.js';
import { getManagedRuntimeDirectory, resolveManagedRuntime } from './runtime-resolver.js';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;

const STORE_DIRECTORY_NAME = 'runtimes';
const CACHE_DIRECTORY_NAME = 'runtime-bootstrap';
const NETWORK_ENVIRONMENT_KEYS = [
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'all_proxy', 'https_proxy', 'http_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
];
export const RUNTIME_BOOTSTRAP_RECEIPT_FILENAME = 'runtime-bootstrap.json';

export class RuntimeBootstrapError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeBootstrapError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new RuntimeBootstrapError(code, message, details);
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function assertNoAbsolutePathSymlink(target, name) {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        fail('bootstrap_path_symlink', `${name} contains a symlink`, { path: current });
      }
    } catch (error) {
      if (error instanceof RuntimeBootstrapError) throw error;
      if (error?.code === 'ENOENT') break;
      fail('bootstrap_path_unsafe', `Unable to inspect ${name}: ${error.message}`, {
        path: current,
      });
    }
  }
}

function assertManagedRoot(root, name) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) fail('bootstrap_path_unsafe', `${name} cannot be a filesystem root`);
  assertNoAbsolutePathSymlink(resolved, name);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  assertNoAbsolutePathSymlink(resolved, name);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('bootstrap_path_unsafe', `${name} must be a real directory`, { path: resolved });
  }
  return resolved;
}

function assertNoSymlinkBelow(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('bootstrap_path_unsafe', 'Managed path escapes its root', {
      root: resolvedRoot,
      target: resolvedTarget,
    });
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        fail('bootstrap_path_symlink', 'Managed bootstrap path contains a symlink', {
          path: current,
        });
      }
    } catch (error) {
      if (error instanceof RuntimeBootstrapError) throw error;
      if (error?.code === 'ENOENT') break;
      fail('bootstrap_path_unsafe', `Unable to inspect managed path: ${error.message}`, {
        path: current,
      });
    }
  }
}

function ensureManagedDirectory(root, target) {
  assertNoSymlinkBelow(root, target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertNoSymlinkBelow(root, target);
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('bootstrap_path_unsafe', 'Managed bootstrap directory is invalid', { path: target });
  }
}

function removeManagedPath(root, target) {
  assertNoSymlinkBelow(root, target);
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    fail('bootstrap_path_symlink', 'Refusing to remove a managed symlink', { path: target });
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function cleanupDeadPartials({
  root,
  parent,
  prefix,
  processAlive,
  recoveredProcessIds = [],
}) {
  if (!fs.existsSync(parent)) return;
  for (const entry of fs.readdirSync(parent)) {
    if (!entry.startsWith(prefix)) continue;
    const match = /\.partial-(\d+)-[a-f0-9]+$/.exec(entry);
    if (match == null) continue;
    const pid = Number(match[1]);
    if (!recoveredProcessIds.includes(pid) && processAlive(pid)) continue;
    removeManagedPath(root, path.join(parent, entry));
  }
}

function commandEnvironment(env, extra = {}) {
  const network = Object.fromEntries(
    NETWORK_ENVIRONMENT_KEYS
      .filter((key) => typeof env[key] === 'string' && env[key] !== '')
      .map((key) => [key, env[key]]),
  );
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    ...network,
    ...extra,
  };
}

export function runBootstrapCommand(command, args, {
  cwd,
  env = process.env,
  code = 'bootstrap_command_failed',
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(code, `Command failed: ${path.basename(command)} ${args.join(' ')}`, {
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: (result.stdout ?? '').trim().slice(-4000),
      stderr: (result.stderr ?? '').trim().slice(-4000),
    });
  }
  return (result.stdout ?? '').trim();
}

async function downloadWithCurl({ run, url, destination, env }) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'go.dev') {
    fail('toolchain_download_failed', `Untrusted toolchain download URL: ${parsed.origin}`);
  }
  run('curl', [
    '--fail', '--silent', '--show-error', '--location',
    '--proto', '=https', '--proto-redir', '=https',
    '--max-redirs', '5', '--connect-timeout', '30',
    '--retry', '3', '--retry-all-errors',
    '--user-agent', `ao-pilot/${PACKAGE_VERSION} runtime-bootstrap`,
    '--output', destination,
    url,
  ], {
    cwd: path.dirname(destination),
    env: commandEnvironment(env),
    code: 'toolchain_download_failed',
  });
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function getProcessStartToken(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(') ');
    if (commandEnd < 0) return null;
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const startTime = fieldsAfterCommand[19];
    return typeof startTime === 'string' && /^\d+$/.test(startTime)
      ? `linux-proc-start:${startTime}`
      : null;
  } catch {
    return null;
  }
}

function isLockOwnerAlive(owner, processAlive, processStartToken) {
  if (!processAlive(owner?.pid)) return false;
  // Legacy locks created before process-start binding must remain conservative:
  // an observed live PID is treated as active instead of risking overlap.
  if (typeof owner?.process_start_token !== 'string') return true;
  const observedToken = processStartToken(owner.pid);
  return observedToken != null && observedToken === owner.process_start_token;
}

function acquireBootstrapLock({
  storeRoot,
  targetParent,
  commitSha,
  now,
  processId,
  processAlive,
  processStartToken,
}) {
  const lockPath = path.join(targetParent, `.bootstrap-${commitSha}.lock`);
  const stagePrefix = `.staging-${commitSha}-`;
  let recovered = false;
  const recoveredProcessIds = [];
  const ownerStartToken = processStartToken(processId);
  if (ownerStartToken == null) {
    fail('bootstrap_process_identity_unavailable', 'Cannot bind bootstrap owner to a Linux process start token', {
      pid: processId,
    });
  }
  const claim = () => {
    const candidate = `${lockPath}.candidate-${processId}-${randomBytes(6).toString('hex')}`;
    fs.mkdirSync(candidate, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(candidate, 'owner.json'), `${JSON.stringify({
        schema_version: 'ao.runtime-bootstrap-owner.v1',
        pid: processId,
        process_start_token: ownerStartToken,
        started_at: now(),
        commit_sha: commitSha,
      }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fs.renameSync(candidate, lockPath);
      return true;
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error;
      return false;
    } finally {
      if (fs.existsSync(candidate)) removeManagedPath(storeRoot, candidate);
    }
  };
  if (!claim()) {
    assertNoSymlinkBelow(storeRoot, lockPath);
    const stat = fs.lstatSync(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('bootstrap_lock_invalid', 'Bootstrap lock is not a real directory', { lock_path: lockPath });
    }
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
    } catch (readError) {
      fail('bootstrap_lock_invalid', `Bootstrap lock owner is unreadable: ${readError.message}`, {
        lock_path: lockPath,
      });
    }
    if (isLockOwnerAlive(owner, processAlive, processStartToken)) {
      fail('bootstrap_in_progress', 'Another runtime bootstrap owns this target', {
        lock_path: lockPath,
        owner_pid: owner.pid,
        owner_started_at: owner.started_at ?? null,
      });
    }
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      recoveredProcessIds.push(owner.pid);
    }
    removeManagedPath(storeRoot, lockPath);
    if (!claim()) {
      fail('bootstrap_in_progress', 'Another runtime bootstrap acquired the recovered target', {
        lock_path: lockPath,
      });
    }
    // The recovered lock is ours before any cleanup occurs. Restrict cleanup
    // to the verified dead owner's PID so a racing live owner can never lose
    // its staging directory.
    if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
      const recoveredStagePrefix = `${stagePrefix}${owner.pid}-`;
      for (const entry of fs.readdirSync(targetParent)) {
        if (!entry.startsWith(recoveredStagePrefix)) continue;
        removeManagedPath(storeRoot, path.join(targetParent, entry));
      }
    }
    recovered = true;
  }
  return {
    lockPath,
    stagePrefix,
    recovered,
    recoveredProcessIds,
    release() {
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      } catch (error) {
        fail('bootstrap_lock_lost', `Bootstrap lock owner changed or disappeared: ${error.message}`, {
          lock_path: lockPath,
        });
      }
      if (owner.pid !== processId || owner.process_start_token !== ownerStartToken) {
        fail('bootstrap_lock_lost', 'Bootstrap lock ownership changed before release', {
          lock_path: lockPath,
        });
      }
      removeManagedPath(storeRoot, lockPath);
    },
  };
}

function recoverInterruptedPromotion({
  storeRoot,
  runtimeDirectory,
  recoveredProcessIds,
  verifyRuntime,
}) {
  if (recoveredProcessIds.length === 0) return { recoveredBackup: false };
  const parent = path.dirname(runtimeDirectory);
  const basename = path.basename(runtimeDirectory);
  const backups = fs.readdirSync(parent).filter((entry) => {
    const match = new RegExp(`^${basename}\\.backup-(\\d+)-[a-f0-9]+$`).exec(entry);
    return match != null && recoveredProcessIds.includes(Number(match[1]));
  });
  if (backups.length > 1) {
    fail('bootstrap_recovery_ambiguous', 'Multiple interrupted runtime backups require inspection', {
      backup_paths: backups.map((entry) => path.join(parent, entry)),
    });
  }
  if (backups.length === 0) return { recoveredBackup: false };
  const backupPath = path.join(parent, backups[0]);
  assertNoSymlinkBelow(storeRoot, backupPath);

  if (fs.existsSync(runtimeDirectory)) {
    try {
      verifyRuntime();
    } catch (error) {
      fail('bootstrap_recovery_ambiguous', 'Interrupted promotion has an invalid target and a preserved backup', {
        runtime_directory: runtimeDirectory,
        backup_path: backupPath,
        cause_code: error.code ?? error.name,
        cause: error.message,
      });
    }
    removeManagedPath(storeRoot, backupPath);
    return { recoveredBackup: true, restored: false };
  }

  fs.renameSync(backupPath, runtimeDirectory);
  try {
    verifyRuntime();
  } catch (error) {
    fs.renameSync(runtimeDirectory, backupPath);
    fail('bootstrap_backup_invalid', 'Interrupted runtime backup failed verification', {
      backup_path: backupPath,
      cause_code: error.code ?? error.name,
      cause: error.message,
    });
  }
  return { recoveredBackup: true, restored: true };
}

function gitEnvironment(env, isolatedHome) {
  return commandEnvironment(env, {
    HOME: isolatedHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'Never',
  });
}

function validateSourceCache({ run, cachePath, lock, env }) {
  if (!fs.existsSync(cachePath)) return false;
  const isolatedHome = path.join(path.dirname(cachePath), '.git-home');
  ensureManagedDirectory(path.dirname(cachePath), isolatedHome);
  const gitEnv = gitEnvironment(env, isolatedHome);
  try {
    const tagObject = run('git', ['rev-parse', 'refs/ao-pilot/locked-tag'], {
      cwd: cachePath, env: gitEnv, code: 'runtime_source_cache_invalid',
    });
    const type = run('git', ['cat-file', '-t', tagObject], {
      cwd: cachePath, env: gitEnv, code: 'runtime_source_cache_invalid',
    });
    const commit = run('git', ['rev-parse', `${tagObject}^{}`], {
      cwd: cachePath, env: gitEnv, code: 'runtime_source_cache_invalid',
    });
    const tree = run('git', ['rev-parse', `${commit}^{tree}`], {
      cwd: cachePath, env: gitEnv, code: 'runtime_source_cache_invalid',
    });
    if (
      tagObject !== lock.artifact.ref.tag_object_sha
      || type !== 'tag'
      || commit !== lock.artifact.ref.commit_sha
      || tree !== lock.artifact.ref.tree_sha
    ) return false;
    run('git', ['fsck', '--strict', '--no-dangling', tagObject], {
      cwd: cachePath, env: gitEnv, code: 'runtime_source_cache_invalid',
    });
    return true;
  } catch (error) {
    if (error instanceof RuntimeBootstrapError) return false;
    throw error;
  }
}

function populateSourceCache({ run, cachePath, lock, env }) {
  const parent = path.dirname(cachePath);
  ensureManagedDirectory(parent, parent);
  const temporary = `${cachePath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  assertNoSymlinkBelow(parent, temporary);
  const isolatedHome = path.join(parent, '.git-home');
  ensureManagedDirectory(parent, isolatedHome);
  const gitEnv = gitEnvironment(env, isolatedHome);
  try {
    run('git', ['init', '--bare', temporary], {
      cwd: parent, env: gitEnv, code: 'runtime_source_fetch_failed',
    });
    run('git', [
      '-c', 'protocol.version=2',
      'fetch', '--depth=1', '--force', '--no-tags', lock.artifact.repository,
      `refs/tags/${lock.artifact.ref.name}:refs/ao-pilot/locked-tag`,
    ], {
      cwd: temporary, env: gitEnv, code: 'runtime_source_fetch_failed',
    });
    if (!validateSourceCache({ run, cachePath: temporary, lock, env })) {
      fail('runtime_source_identity_mismatch', 'Fetched runtime source does not match the lock');
    }
    try {
      fs.renameSync(temporary, cachePath);
    } catch (error) {
      if (
        !['EEXIST', 'ENOTEMPTY'].includes(error?.code)
        || !validateSourceCache({ run, cachePath, lock, env })
      ) throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) removeManagedPath(parent, temporary);
  }
}

function ensureSourceCache({
  run,
  cacheRoot,
  lock,
  env,
  offline,
  processAlive,
  recoveredProcessIds,
}) {
  const sourceRoot = path.join(
    cacheRoot,
    'sources',
    shortHash(lock.artifact.repository),
    lock.artifact.ref.tag_object_sha,
  );
  ensureManagedDirectory(cacheRoot, path.dirname(sourceRoot));
  cleanupDeadPartials({
    root: cacheRoot,
    parent: path.dirname(sourceRoot),
    prefix: `${lock.artifact.ref.tag_object_sha}.partial-`,
    processAlive,
    recoveredProcessIds,
  });
  assertNoSymlinkBelow(cacheRoot, sourceRoot);
  if (validateSourceCache({ run, cachePath: sourceRoot, lock, env })) {
    return { path: sourceRoot, reused: true };
  }
  if (fs.existsSync(sourceRoot)) {
    if (offline) fail('runtime_source_cache_invalid', 'Offline runtime source cache is invalid', {
      source_cache: sourceRoot,
    });
    removeManagedPath(cacheRoot, sourceRoot);
  }
  if (offline) fail('runtime_source_cache_missing', 'Offline runtime source cache is missing', {
    source_cache: sourceRoot,
  });
  populateSourceCache({ run, cachePath: sourceRoot, lock, env });
  return { path: sourceRoot, reused: false };
}

async function ensureToolchainArchive({
  cacheRoot,
  contract,
  offline,
  download,
  processAlive,
  recoveredProcessIds,
}) {
  const downloads = path.join(cacheRoot, 'downloads', 'go', contract.version);
  ensureManagedDirectory(cacheRoot, downloads);
  const archivePath = path.join(downloads, `${contract.sha256}-${contract.filename}`);
  cleanupDeadPartials({
    root: cacheRoot,
    parent: downloads,
    prefix: `${contract.sha256}-${contract.filename}.partial-`,
    processAlive,
    recoveredProcessIds,
  });
  assertNoSymlinkBelow(cacheRoot, archivePath);
  if (fs.existsSync(archivePath)) {
    const stat = fs.lstatSync(archivePath);
    if (stat.isFile() && !stat.isSymbolicLink() && sha256File(archivePath) === contract.sha256) {
      return { path: archivePath, reused: true };
    }
    if (offline) fail('toolchain_cache_invalid', 'Offline toolchain archive is invalid', {
      archive_path: archivePath,
    });
    removeManagedPath(cacheRoot, archivePath);
  }
  if (offline) fail('toolchain_cache_missing', 'Offline toolchain archive is missing', {
    archive_path: archivePath,
  });
  const temporary = `${archivePath}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await download(contract.url, temporary);
    if (sha256File(temporary) !== contract.sha256) {
      fail('toolchain_integrity_mismatch', 'Downloaded toolchain SHA-256 does not match the lock', {
        archive_path: temporary,
      });
    }
    fs.chmodSync(temporary, 0o400);
    fs.renameSync(temporary, archivePath);
  } catch (error) {
    if (error instanceof RuntimeBootstrapError) throw error;
    fail('toolchain_download_failed', error.message, { url: contract.url });
  } finally {
    if (fs.existsSync(temporary)) removeManagedPath(cacheRoot, temporary);
  }
  return { path: archivePath, reused: false };
}

function checkoutSource({ run, cachePath, destination, lock, env, isolatedHome }) {
  const gitEnv = gitEnvironment(env, isolatedHome);
  run('git', ['init', '--quiet', destination], {
    cwd: path.dirname(destination), env: gitEnv, code: 'runtime_source_checkout_failed',
  });
  // The cache intentionally exposes only a private exact-object ref. Fetch it
  // explicitly so checkout does not depend on default branches or tag discovery.
  run('git', [
    'fetch', '--update-shallow', '--no-tags', cachePath, 'refs/ao-pilot/locked-tag',
  ], {
    cwd: destination, env: gitEnv, code: 'runtime_source_checkout_failed',
  });
  run('git', ['checkout', '--detach', lock.artifact.ref.commit_sha], {
    cwd: destination, env: gitEnv, code: 'runtime_source_checkout_failed',
  });
  const head = run('git', ['rev-parse', 'HEAD'], {
    cwd: destination, env: gitEnv, code: 'runtime_source_checkout_failed',
  });
  const tree = run('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: destination, env: gitEnv, code: 'runtime_source_checkout_failed',
  });
  if (head !== lock.artifact.ref.commit_sha || tree !== lock.artifact.ref.tree_sha) {
    fail('runtime_source_identity_mismatch', 'Checked-out runtime source does not match the lock', {
      observed_commit: head,
      observed_tree: tree,
    });
  }
}

function extractToolchain({ run, archivePath, destination, contract, env }) {
  ensureManagedDirectory(path.dirname(destination), destination);
  if (sha256File(archivePath) !== contract.sha256) {
    fail('toolchain_integrity_mismatch', 'Cached toolchain changed before extraction', {
      archive_path: archivePath,
    });
  }
  run('tar', ['-xzf', archivePath, '--no-same-owner', '-C', destination], {
    cwd: destination,
    env: commandEnvironment(env),
    code: 'toolchain_extract_failed',
  });
  const goBinary = path.join(destination, 'go', 'bin', 'go');
  const version = run(goBinary, ['version'], {
    cwd: destination,
    env: commandEnvironment(env, { GOTOOLCHAIN: 'local' }),
    code: 'toolchain_version_failed',
  });
  const expected = `go version go${contract.version} linux/${contract.goarch}`;
  if (version !== expected) {
    fail('toolchain_version_mismatch', 'Extracted toolchain version does not match the lock', {
      expected,
      observed: version,
    });
  }
  return goBinary;
}

function buildRuntime({
  run,
  sourceRoot,
  goBinary,
  runtimeStage,
  lock,
  cacheRoot,
  platform,
  arch,
  toolchainContract,
  env,
  offline,
}) {
  const binaryPath = path.join(runtimeStage, lock.binary.relative_path);
  ensureManagedDirectory(runtimeStage, path.dirname(binaryPath));
  const buildCache = path.join(
    cacheRoot,
    'go-build',
    lock.artifact.ref.commit_sha,
    `${platform}-${arch}`,
  );
  const moduleCache = path.join(cacheRoot, 'go-modules', lock.artifact.ref.commit_sha);
  const goPath = path.join(cacheRoot, 'go-path', lock.artifact.ref.commit_sha);
  const isolatedHome = path.join(cacheRoot, 'go-home');
  for (const directory of [buildCache, moduleCache, goPath, isolatedHome]) {
    ensureManagedDirectory(cacheRoot, directory);
  }
  const buildArgs = lock.build.command.slice(1).map((item) => (
    item === '{binary_path}' ? binaryPath : item
  ));
  const buildEnv = commandEnvironment(env, {
    HOME: isolatedHome,
    CGO_ENABLED: lock.build.environment.CGO_ENABLED,
    GOOS: platform,
    GOARCH: toolchainContract.goarch,
    GOTOOLCHAIN: 'local',
    GOCACHE: buildCache,
    GOMODCACHE: moduleCache,
    GOPATH: goPath,
    GOPROXY: offline ? 'off' : 'https://proxy.golang.org,direct',
    GOSUMDB: 'sum.golang.org',
  });
  run(goBinary, buildArgs, {
    cwd: path.join(sourceRoot, lock.build.working_directory),
    env: buildEnv,
    code: 'runtime_build_failed',
  });
  const expected = lock.compatibility.platforms.find(
    (item) => item.os === platform && item.arch === arch,
  ).binary_sha256;
  const observed = sha256File(binaryPath);
  if (observed !== expected) {
    fail('runtime_binary_integrity_mismatch', 'Built runtime binary does not match the lock', {
      binary_path: binaryPath,
      expected_sha256: expected,
      observed_sha256: observed,
    });
  }
  fs.chmodSync(binaryPath, 0o500);
  return { binaryPath, sha256: observed };
}

export function getDefaultRuntimeStore({ env = process.env, homedir = os.homedir() } = {}) {
  const dataRoot = env.XDG_DATA_HOME?.trim() || path.join(homedir, '.local', 'share');
  return path.resolve(dataRoot, 'ao-pilot', STORE_DIRECTORY_NAME);
}

export function getDefaultRuntimeCache({ env = process.env, homedir = os.homedir() } = {}) {
  const cacheRoot = env.XDG_CACHE_HOME?.trim() || path.join(homedir, '.cache');
  return path.resolve(cacheRoot, 'ao-pilot', CACHE_DIRECTORY_NAME);
}

function getToolchainContract(lock, platform, arch) {
  const contract = lock.platforms.find((item) => item.os === platform && item.arch === arch);
  if (!contract) fail('toolchain_platform_unsupported', 'No locked bootstrap toolchain for platform', {
    platform,
    arch,
  });
  return contract;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value == null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function sameJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

export function verifyRuntimeBootstrapReceipt({
  runtimeDirectory,
  runtimeLock,
  toolchainLock,
  platform,
  arch,
} = {}) {
  const receiptPath = path.join(runtimeDirectory, RUNTIME_BOOTSTRAP_RECEIPT_FILENAME);
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    fail('bootstrap_receipt_invalid', `Unable to read runtime bootstrap receipt: ${error.message}`, {
      receipt_path: receiptPath,
    });
  }
  if (receipt == null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    fail('bootstrap_receipt_invalid', 'Runtime bootstrap receipt must be an object');
  }
  const expectedKeys = [
    'schema_version', 'runtime_ref', 'runtime_lock_digest', 'installed_at',
    'target', 'source', 'toolchain', 'cache_reuse',
  ].sort();
  if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys)) {
    fail('bootstrap_receipt_invalid', 'Runtime bootstrap receipt keys are invalid');
  }
  const toolchain = getToolchainContract(toolchainLock, platform, arch);
  const expected = {
    schema_version: 'ao.runtime-bootstrap-receipt.v1',
    runtime_ref: runtimeLock.runtime_ref,
    runtime_lock_digest: computeRuntimeLockDigest(runtimeLock),
    target: { os: platform, arch },
    source: {
      repository: runtimeLock.artifact.repository,
      tag: runtimeLock.artifact.ref.name,
      tag_object_sha: runtimeLock.artifact.ref.tag_object_sha,
      commit_sha: runtimeLock.artifact.ref.commit_sha,
      tree_sha: runtimeLock.artifact.ref.tree_sha,
    },
    toolchain: {
      lock_digest: computeBootstrapToolchainLockDigest(toolchainLock),
      name: toolchainLock.name,
      version: toolchainLock.version,
      archive_url: toolchain.url,
      archive_sha256: toolchain.sha256,
    },
  };
  if (
    receipt.schema_version !== expected.schema_version
    || receipt.runtime_ref !== expected.runtime_ref
    || receipt.runtime_lock_digest !== expected.runtime_lock_digest
    || !sameJson(receipt.target, expected.target)
    || !sameJson(receipt.source, expected.source)
    || !sameJson(receipt.toolchain, expected.toolchain)
    || typeof receipt.installed_at !== 'string'
    || Number.isNaN(new Date(receipt.installed_at).getTime())
    || typeof receipt.cache_reuse?.source !== 'boolean'
    || typeof receipt.cache_reuse?.toolchain_archive !== 'boolean'
    || typeof receipt.cache_reuse?.offline !== 'boolean'
    || Object.keys(receipt.cache_reuse ?? {}).sort().join(',')
      !== 'offline,source,toolchain_archive'
  ) {
    fail('bootstrap_receipt_mismatch', 'Runtime bootstrap receipt does not match the locks', {
      receipt_path: receiptPath,
    });
  }
  return { path: receiptPath, receipt };
}

function resolveInternal({
  lock,
  toolchainLock,
  storeRoot,
  platform,
  arch,
  aoPilotVersion,
}) {
  const runtimeDirectory = getManagedRuntimeDirectory({ lock, storeRoot, platform, arch });
  const binaryPath = path.join(runtimeDirectory, lock.binary.relative_path);
  const resolved = resolveManagedRuntime({
    lock,
    storeRoot,
    platform,
    arch,
    aoPilotVersion,
    env: { PATH: path.dirname(binaryPath) },
    cwd: runtimeDirectory,
  });
  const bootstrapReceipt = verifyRuntimeBootstrapReceipt({
    runtimeDirectory,
    runtimeLock: lock,
    toolchainLock,
    platform,
    arch,
  });
  return {
    ...resolved,
    bootstrap_receipt_path: bootstrapReceipt.path,
  };
}

export async function bootstrapManagedRuntime({
  runtimeLock = loadRuntimeLock().lock,
  toolchainLock = loadBootstrapToolchainLock().lock,
  storeRoot = getDefaultRuntimeStore(),
  cacheRoot = getDefaultRuntimeCache(),
  aoPilotVersion = PACKAGE_VERSION,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  cwd = process.cwd(),
  offline = false,
  reinstall = false,
  now = () => new Date().toISOString(),
  processId = process.pid,
  processAlive = isProcessAlive,
  processStartToken = getProcessStartToken,
  run = runBootstrapCommand,
  download = null,
  buildOverride = null,
} = {}) {
  const normalizedStore = assertManagedRoot(storeRoot, 'runtime store');
  const normalizedCache = assertManagedRoot(cacheRoot, 'runtime cache');
  const toolchainContract = getToolchainContract(toolchainLock, platform, arch);
  const toolchainLockDigest = computeBootstrapToolchainLockDigest(toolchainLock);
  const effectiveDownload = download ?? ((url, destination) => downloadWithCurl({
    run,
    url,
    destination,
    env,
  }));
  if (toolchainLock.version !== runtimeLock.build.toolchain.version) {
    fail('toolchain_lock_mismatch', 'Bootstrap and runtime lock toolchain versions differ');
  }
  const runtimeDirectory = getManagedRuntimeDirectory({
    lock: runtimeLock,
    storeRoot: normalizedStore,
    platform,
    arch,
  });
  const targetParent = path.dirname(runtimeDirectory);
  ensureManagedDirectory(normalizedStore, targetParent);

  const lock = acquireBootstrapLock({
    storeRoot: normalizedStore,
    targetParent,
    commitSha: runtimeLock.artifact.ref.commit_sha,
    now,
    processId,
    processAlive,
    processStartToken,
  });
  const stageRoot = path.join(
    targetParent,
    `${lock.stagePrefix}${processId}-${randomBytes(6).toString('hex')}`,
  );
  const runtimeStage = path.join(stageRoot, 'runtime');
  const backupPath = `${runtimeDirectory}.backup-${processId}-${randomBytes(6).toString('hex')}`;
  let previousMoved = false;
  let installed = false;
  let installationCommitted = false;
  try {
    const verifyInstalledRuntime = () => resolveInternal({
      lock: runtimeLock,
      toolchainLock,
      storeRoot: normalizedStore,
      platform,
      arch,
      aoPilotVersion,
    });
    const promotionRecovery = recoverInterruptedPromotion({
      storeRoot: normalizedStore,
      runtimeDirectory,
      recoveredProcessIds: lock.recoveredProcessIds,
      verifyRuntime: verifyInstalledRuntime,
    });
    if (fs.existsSync(runtimeDirectory) && !reinstall) {
      let verified;
      try {
        verified = verifyInstalledRuntime();
      } catch (error) {
        fail('runtime_existing_invalid', 'Existing managed runtime is invalid; use --reinstall', {
          runtime_directory: runtimeDirectory,
          cause_code: error.code ?? error.name,
          cause: error.message,
        });
      }
      const pathVerified = {
        ...resolveManagedRuntime({
          lock: runtimeLock,
          storeRoot: normalizedStore,
          platform,
          arch,
          aoPilotVersion,
          env,
          cwd,
        }),
        bootstrap_receipt_path: verified.bootstrap_receipt_path,
      };
      return {
        status: 'reused',
        offline,
        reinstall,
        recovered_interrupted_bootstrap: lock.recovered || promotionRecovery.recoveredBackup,
        store_root: normalizedStore,
        cache_root: normalizedCache,
        runtime: pathVerified,
        internal_verification: verified.status,
      };
    }
    ensureManagedDirectory(normalizedStore, runtimeStage);
    const sourceCache = ensureSourceCache({
      run,
      cacheRoot: normalizedCache,
      lock: runtimeLock,
      env,
      offline,
      processAlive,
      recoveredProcessIds: lock.recoveredProcessIds,
    });
    const toolchainArchive = await ensureToolchainArchive({
      cacheRoot: normalizedCache,
      contract: { ...toolchainContract, version: toolchainLock.version },
      offline,
      download: effectiveDownload,
      processAlive,
      recoveredProcessIds: lock.recoveredProcessIds,
    });
    const sourceRoot = path.join(stageRoot, 'source');
    const gitHome = path.join(stageRoot, 'git-home');
    ensureManagedDirectory(normalizedStore, gitHome);
    checkoutSource({
      run,
      cachePath: sourceCache.path,
      destination: sourceRoot,
      lock: runtimeLock,
      env,
      isolatedHome: gitHome,
    });
    const extractedToolchain = path.join(stageRoot, 'toolchain');
    const goBinary = extractToolchain({
      run,
      archivePath: toolchainArchive.path,
      destination: extractedToolchain,
      contract: { ...toolchainContract, version: toolchainLock.version },
      env,
    });
    const built = buildOverride == null
      ? buildRuntime({
        run,
        sourceRoot,
        goBinary,
        runtimeStage,
        lock: runtimeLock,
        cacheRoot: normalizedCache,
        platform,
        arch,
        toolchainContract,
        env,
        offline,
      })
      : await buildOverride({
        runtimeStage,
        runtimeLock,
        toolchainLock,
        sourceRoot,
        goBinary,
        cacheRoot: normalizedCache,
        platform,
        arch,
        offline,
      });
    const binaryPath = path.join(runtimeStage, runtimeLock.binary.relative_path);
    const binarySha256 = built?.sha256 ?? sha256File(binaryPath);
    const expectedSha256 = runtimeLock.compatibility.platforms.find(
      (item) => item.os === platform && item.arch === arch,
    ).binary_sha256;
    if (binarySha256 !== expectedSha256 || sha256File(binaryPath) !== expectedSha256) {
      fail('runtime_binary_integrity_mismatch', 'Staged runtime binary does not match the lock');
    }
    fs.chmodSync(binaryPath, 0o500);
    const installedAt = now();
    const provenance = createRuntimeProvenance({
      lock: runtimeLock,
      binary_sha256: binarySha256,
      installed_at: installedAt,
      platform,
      arch,
    });
    fs.writeFileSync(
      path.join(runtimeStage, RUNTIME_PROVENANCE_FILENAME),
      `${JSON.stringify(provenance, null, 2)}\n`,
      { flag: 'wx', mode: 0o400 },
    );
    fs.writeFileSync(
      path.join(runtimeStage, RUNTIME_BOOTSTRAP_RECEIPT_FILENAME),
      `${JSON.stringify({
        schema_version: 'ao.runtime-bootstrap-receipt.v1',
        runtime_ref: runtimeLock.runtime_ref,
        runtime_lock_digest: provenance.lock_digest,
        installed_at: installedAt,
        target: { os: platform, arch },
        source: {
          repository: runtimeLock.artifact.repository,
          tag: runtimeLock.artifact.ref.name,
          tag_object_sha: runtimeLock.artifact.ref.tag_object_sha,
          commit_sha: runtimeLock.artifact.ref.commit_sha,
          tree_sha: runtimeLock.artifact.ref.tree_sha,
        },
        toolchain: {
          lock_digest: toolchainLockDigest,
          name: toolchainLock.name,
          version: toolchainLock.version,
          archive_url: toolchainContract.url,
          archive_sha256: toolchainContract.sha256,
        },
        cache_reuse: {
          source: sourceCache.reused,
          toolchain_archive: toolchainArchive.reused,
          offline,
        },
      }, null, 2)}\n`,
      { flag: 'wx', mode: 0o400 },
    );

    if (fs.existsSync(runtimeDirectory)) {
      assertNoSymlinkBelow(normalizedStore, runtimeDirectory);
      fs.renameSync(runtimeDirectory, backupPath);
      previousMoved = true;
    }
    fs.renameSync(runtimeStage, runtimeDirectory);
    installed = true;
    const internal = resolveInternal({
      lock: runtimeLock,
      toolchainLock,
      storeRoot: normalizedStore,
      platform,
      arch,
      aoPilotVersion,
    });
    if (previousMoved) {
      removeManagedPath(normalizedStore, backupPath);
      previousMoved = false;
    }
    installationCommitted = true;
    const pathVerified = {
      ...resolveManagedRuntime({
        lock: runtimeLock,
        storeRoot: normalizedStore,
        platform,
        arch,
        aoPilotVersion,
        env,
        cwd,
      }),
      bootstrap_receipt_path: internal.bootstrap_receipt_path,
    };
    return {
      status: reinstall ? 'reinstalled' : 'installed',
      offline,
      reinstall,
      recovered_interrupted_bootstrap: lock.recovered,
      store_root: normalizedStore,
      cache_root: normalizedCache,
      runtime: pathVerified,
      internal_verification: internal.status,
      source_cache: {
        path: sourceCache.path,
        reused: sourceCache.reused,
      },
      toolchain_cache: {
        archive_path: toolchainArchive.path,
        reused: toolchainArchive.reused,
        sha256: toolchainContract.sha256,
        lock_digest: toolchainLockDigest,
      },
    };
  } catch (error) {
    if (!installationCommitted && installed && previousMoved) {
      removeManagedPath(normalizedStore, runtimeDirectory);
      fs.renameSync(backupPath, runtimeDirectory);
      installed = false;
      previousMoved = false;
    } else if (!installationCommitted && installed) {
      removeManagedPath(normalizedStore, runtimeDirectory);
      installed = false;
    } else if (!installationCommitted && !installed && previousMoved) {
      fs.renameSync(backupPath, runtimeDirectory);
      previousMoved = false;
    }
    throw error;
  } finally {
    if (fs.existsSync(stageRoot)) removeManagedPath(normalizedStore, stageRoot);
    if (fs.existsSync(backupPath) && !previousMoved) removeManagedPath(normalizedStore, backupPath);
    lock.release();
  }
}
