import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WORKER_PREPARATION_CONTRACT_SCHEMA = 'ao.worker-worktree-preparation-contract.v1';
export const WORKER_PREPARATION_RECEIPT_SCHEMA = 'ao.worker-worktree-preparation-receipt.v1';
export const WORKER_PREPARATION_EXIT_CODES = Object.freeze({
  ready: 0,
  setupFailure: 20,
});

const EXPECTED_CONTRACT = Object.freeze({
  schema_version: WORKER_PREPARATION_CONTRACT_SCHEMA,
  package_manager: 'npm',
  lockfile: 'package-lock.json',
  install_command: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
  test_runner: 'node_modules/.bin/jest',
});
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const GIT_OUTPUT_BUFFER_BYTES = 32 * 1024 * 1024;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runProcess(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    ...options,
  });
}

function runGit(repoRoot, args, processRunner, { trim = true } = {}) {
  const result = processRunner('git', args, {
    cwd: repoRoot,
    env: minimalEnvironment(),
    maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result?.error || result?.status !== 0) return null;
  const stdout = String(result.stdout ?? '');
  return trim ? stdout.trim() : stdout;
}

function minimalEnvironment(extra = {}) {
  const allowedNames = process.platform === 'win32'
    ? ['PATH', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']
    : ['PATH', 'TMPDIR'];
  const env = {};
  for (const name of allowedNames) {
    if (typeof process.env[name] === 'string') env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

function failure(reasonCode, evidence = {}) {
  return {
    schema_version: WORKER_PREPARATION_RECEIPT_SCHEMA,
    status: 'setup_failed',
    ready: false,
    failure_class: 'setup',
    reason_code: reasonCode,
    install_performed: false,
    receipt_replayed: false,
    ...evidence,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function contractMatches(contract) {
  return JSON.stringify(contract) === JSON.stringify(EXPECTED_CONTRACT);
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  let descriptor = null;
  let temporaryCreated = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (descriptor != null) fs.closeSync(descriptor);
    if (temporaryCreated) fs.rmSync(temporaryPath, { force: true });
  }
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function pathIsWithin(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

function ensureRepoLocalStateRoot(repoRoot, stateRoot) {
  try {
    const resolvedRepoRoot = fs.realpathSync(repoRoot);
    const stateAncestors = [
      path.join(repoRoot, '.ao-pilot'),
      stateRoot,
    ];
    for (const ancestor of stateAncestors) {
      const stat = lstatIfPresent(ancestor);
      if (stat == null) continue;
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }

    fs.mkdirSync(stateRoot, { recursive: true });
    for (const ancestor of stateAncestors) {
      const stat = fs.lstatSync(ancestor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }

    const resolvedStateRoot = fs.realpathSync(stateRoot);
    return pathIsWithin(resolvedRepoRoot, resolvedStateRoot);
  } catch {
    return false;
  }
}

function managedStatePathsAreSafe(stateRoot, { receiptPath, npmrcPath, cacheRoot }) {
  try {
    const resolvedStateRoot = fs.realpathSync(stateRoot);
    for (const [filePath, expectedKind] of [
      [receiptPath, 'file'],
      [npmrcPath, 'file'],
      [cacheRoot, 'directory'],
    ]) {
      const stat = lstatIfPresent(filePath);
      if (stat == null) continue;
      if (stat.isSymbolicLink()) return false;
      if (expectedKind === 'file' && !stat.isFile()) return false;
      if (expectedKind === 'directory' && !stat.isDirectory()) return false;
      if (!pathIsWithin(resolvedStateRoot, fs.realpathSync(filePath))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function resetManagedInstallState(stateRoot, paths) {
  const { receiptPath, npmrcPath, cacheRoot } = paths;
  try {
    if (!managedStatePathsAreSafe(stateRoot, paths)) return false;
    fs.rmSync(receiptPath, { force: true });
    fs.rmSync(npmrcPath, { force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
    fs.mkdirSync(cacheRoot, { recursive: false, mode: 0o700 });
    const npmrcDescriptor = fs.openSync(npmrcPath, 'wx', 0o600);
    fs.closeSync(npmrcDescriptor);
    return managedStatePathsAreSafe(stateRoot, paths);
  } catch {
    return false;
  }
}

function lockfileIsClean(repoRoot, lockfilePath, processRunner) {
  const result = processRunner('git', [
    'diff', '--quiet', '--exit-code', 'HEAD', '--', lockfilePath,
  ], {
    cwd: repoRoot,
    env: minimalEnvironment(),
    maxBuffer: GIT_OUTPUT_BUFFER_BYTES,
    stdio: 'ignore',
  });
  if (result?.error || !Number.isInteger(result?.status)) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

function probeTestRunner(repoRoot, testRunnerPath, processRunner) {
  const result = processRunner(testRunnerPath, ['--version'], {
    cwd: repoRoot,
    env: minimalEnvironment(),
    stdio: 'ignore',
    timeout: PROBE_TIMEOUT_MS,
  });
  return !result?.error && result?.status === 0;
}

function resolveTestRunnerExecutable(repoRoot) {
  const declaredPath = path.join(repoRoot, EXPECTED_CONTRACT.test_runner);
  return process.platform === 'win32' ? `${declaredPath}.cmd` : declaredPath;
}

function baseEvidence(repoRoot, processRunner) {
  const commitSha = runGit(repoRoot, ['rev-parse', 'HEAD^{commit}'], processRunner);
  const treeSha = runGit(repoRoot, ['rev-parse', 'HEAD^{tree}'], processRunner);
  if (!/^[0-9a-f]{40}$/.test(commitSha ?? '') || !/^[0-9a-f]{40}$/.test(treeSha ?? '')) {
    return { error: failure('git_identity_unavailable') };
  }
  return {
    repository: {
      commit_sha: commitSha,
      tree_sha: treeSha,
    },
  };
}

export function prepareWorkerWorktree({
  repoRoot,
  processRunner = runProcess,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') {
    return failure('repository_root_required');
  }

  const identity = baseEvidence(repoRoot, processRunner);
  if (identity.error) return identity.error;

  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = readJson(packageJsonPath);
  const contract = packageJson?.ao?.worker_worktree_preparation;
  if (!contractMatches(contract)) {
    return failure('setup_contract_missing_or_changed', identity);
  }

  const lockfilePath = path.join(repoRoot, EXPECTED_CONTRACT.lockfile);
  const trackedLockfile = runGit(
    repoRoot,
    ['show', `HEAD:${EXPECTED_CONTRACT.lockfile}`],
    processRunner,
    { trim: false },
  );
  if (trackedLockfile == null || !fs.existsSync(lockfilePath)) {
    return failure('committed_lockfile_missing', identity);
  }

  const trackedDigest = sha256(trackedLockfile);
  const lockfileClean = lockfileIsClean(repoRoot, EXPECTED_CONTRACT.lockfile, processRunner);
  if (lockfileClean == null) {
    return failure('lockfile_status_unavailable', identity);
  }
  if (!lockfileClean) {
    return failure('committed_lockfile_changed', identity);
  }

  const evidence = {
    ...identity,
    lockfile: {
      path: EXPECTED_CONTRACT.lockfile,
      sha256: trackedDigest,
    },
    setup_contract: {
      schema_version: EXPECTED_CONTRACT.schema_version,
      package_manager: EXPECTED_CONTRACT.package_manager,
      command: 'npm ci',
      lifecycle_scripts: false,
    },
    test_runner: {
      path: EXPECTED_CONTRACT.test_runner,
      ready: false,
    },
  };

  if (fs.existsSync(path.join(repoRoot, '.npmrc'))) {
    return failure('project_npmrc_not_allowed', evidence);
  }

  const stateRoot = path.join(repoRoot, '.ao-pilot', 'worker-preparation');
  const receiptPath = path.join(stateRoot, 'receipt.json');
  const npmrcPath = path.join(stateRoot, 'empty-npmrc');
  const cacheRoot = path.join(stateRoot, 'npm-cache');
  const managedPaths = { receiptPath, npmrcPath, cacheRoot };
  const testRunnerPath = resolveTestRunnerExecutable(repoRoot);
  if (
    !ensureRepoLocalStateRoot(repoRoot, stateRoot)
    || !managedStatePathsAreSafe(stateRoot, managedPaths)
  ) {
    return failure('preparation_state_not_repo_local', evidence);
  }
  const expectedReceipt = {
    schema_version: WORKER_PREPARATION_RECEIPT_SCHEMA,
    status: 'ready',
    ready: true,
    failure_class: null,
    reason_code: null,
    repository: evidence.repository,
    lockfile: evidence.lockfile,
    setup_contract: evidence.setup_contract,
    test_runner: {
      ...evidence.test_runner,
      ready: true,
    },
  };

  if (
    isFile(testRunnerPath)
    && JSON.stringify(readJson(receiptPath)) === JSON.stringify(expectedReceipt)
    && probeTestRunner(repoRoot, testRunnerPath, processRunner)
  ) {
    return {
      ...expectedReceipt,
      install_performed: false,
      receipt_replayed: true,
    };
  }

  if (!resetManagedInstallState(stateRoot, managedPaths)) {
    return failure('preparation_state_unwritable', evidence);
  }
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installResult = processRunner(npmCommand, EXPECTED_CONTRACT.install_command.slice(1), {
    cwd: repoRoot,
    env: minimalEnvironment({
      npm_config_cache: cacheRoot,
      npm_config_globalconfig: process.platform === 'win32' ? 'NUL' : '/dev/null',
      npm_config_userconfig: npmrcPath,
    }),
    stdio: 'ignore',
    timeout: INSTALL_TIMEOUT_MS,
  });

  if (installResult?.error || installResult?.status !== 0) {
    return {
      ...failure('dependency_install_failed', evidence),
      install: {
        exit_code: Number.isInteger(installResult?.status) ? installResult.status : null,
        signal: installResult?.signal ?? null,
      },
    };
  }
  if (!isFile(testRunnerPath) || !probeTestRunner(repoRoot, testRunnerPath, processRunner)) {
    return {
      ...failure('test_runner_unhealthy_after_install', evidence),
      install_performed: true,
    };
  }

  try {
    atomicWriteJson(receiptPath, expectedReceipt);
  } catch {
    return {
      ...failure('preparation_receipt_write_failed', evidence),
      install_performed: true,
    };
  }
  return {
    ...expectedReceipt,
    install_performed: true,
    receipt_replayed: false,
  };
}
