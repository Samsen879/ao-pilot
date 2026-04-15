import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createDoctorLocalState } from './doctor-contracts.js';
import { readAoFixture } from './fixture-support.js';

const DEFAULT_UNTRACKED_SAMPLE_LIMIT = 5;
const DEFAULT_GIT_PROBE_TIMEOUT_MS = 5000;
const KNOWN_AO_ARTIFACT_PATHS = [
  '.ao-current-issue',
  'ao-queue.txt',
  'ao-task-state.json',
  'ao-artifacts',
];

function runGit(args, cwd, timeoutMs) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
  });
}

function trimOutput(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

function describeGitFailure(result, fallbackMessage) {
  const errorCode = trimOutput(result?.error?.code);
  const errorMessage = trimOutput(result?.error?.message);
  const stderr = trimOutput(result?.stderr);
  const stdout = trimOutput(result?.stdout);

  if (errorCode && errorMessage) {
    return errorMessage.includes(errorCode)
      ? errorMessage
      : `${errorCode}: ${errorMessage}`;
  }

  return errorCode ?? errorMessage ?? stderr ?? stdout ?? fallbackMessage;
}

function parseStatusPorcelain(stdout, untrackedSampleLimit) {
  const lines = String(stdout ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean);

  let stagedChanges = false;
  let unstagedChanges = false;
  const untrackedFiles = [];

  for (const line of lines) {
    if (line.startsWith('## ')) continue;
    if (line.startsWith('?? ')) {
      untrackedFiles.push(line.slice(3));
      continue;
    }

    const indexStatus = line[0] ?? ' ';
    const worktreeStatus = line[1] ?? ' ';
    if (indexStatus !== ' ') stagedChanges = true;
    if (worktreeStatus !== ' ') unstagedChanges = true;
  }

  const sortedUntracked = [...untrackedFiles].sort((left, right) => left.localeCompare(right));

  return {
    worktreeDirty: stagedChanges || unstagedChanges || sortedUntracked.length > 0,
    stagedChanges,
    unstagedChanges,
    untrackedFileCount: sortedUntracked.length,
    untrackedFileSamples: sortedUntracked.slice(0, untrackedSampleLimit),
  };
}

function collectAoArtifactPaths(repoRoot) {
  const found = [];

  for (const relativePath of KNOWN_AO_ARTIFACT_PATHS) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (!existsSync(absolutePath)) continue;

    if (relativePath === 'ao-artifacts') {
      const stats = statSync(absolutePath);
      found.push(stats.isDirectory() ? 'ao-artifacts/' : 'ao-artifacts');
      continue;
    }

    found.push(relativePath);
  }

  return found.sort((left, right) => left.localeCompare(right));
}

export async function loadDoctorLocalState({
  cwd = process.cwd(),
  untrackedSampleLimit = DEFAULT_UNTRACKED_SAMPLE_LIMIT,
  gitProbeTimeoutMs = DEFAULT_GIT_PROBE_TIMEOUT_MS,
} = {}) {
  const fixture = readAoFixture('doctor-local-state.json');
  if (fixture) {
    const parsed = JSON.parse(fixture.text || '{}');
    return createDoctorLocalState({
      cwd,
      ...parsed,
      cwd: parsed?.cwd ?? cwd,
    });
  }

  const repoRootResult = runGit(['rev-parse', '--show-toplevel'], cwd, gitProbeTimeoutMs);
  if (repoRootResult.status !== 0) {
    return createDoctorLocalState({
      cwd,
      git_observable: false,
      git_error: describeGitFailure(repoRootResult, 'git rev-parse failed'),
    });
  }

  const repoRoot = trimOutput(repoRootResult.stdout);
  const branchResult = runGit(['branch', '--show-current'], cwd, gitProbeTimeoutMs);
  const headResult = runGit(['rev-parse', 'HEAD'], cwd, gitProbeTimeoutMs);
  const upstreamResult = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd, gitProbeTimeoutMs);
  const statusResult = runGit(['status', '--porcelain=v1', '--branch'], cwd, gitProbeTimeoutMs);

  const currentBranch = branchResult.status === 0 ? trimOutput(branchResult.stdout) : null;
  const headSha = headResult.status === 0 ? trimOutput(headResult.stdout) : null;
  const upstreamBranch = upstreamResult.status === 0 ? trimOutput(upstreamResult.stdout) : null;
  const upstreamTracking = upstreamResult.status === 0
    ? 'present'
    : 'missing';
  const detachedHead = currentBranch == null;

  const statusSummary = statusResult.status === 0
    ? parseStatusPorcelain(statusResult.stdout, untrackedSampleLimit)
    : {
        worktreeDirty: null,
        stagedChanges: null,
        unstagedChanges: null,
        untrackedFileCount: null,
        untrackedFileSamples: [],
      };

  return createDoctorLocalState({
    repo_root: repoRoot,
    cwd,
    current_branch: currentBranch,
    head_sha: headSha,
    detached_head: detachedHead,
    upstream_branch: upstreamBranch,
    upstream_tracking: upstreamTracking,
    worktree_dirty: statusSummary.worktreeDirty,
    staged_changes: statusSummary.stagedChanges,
    unstaged_changes: statusSummary.unstagedChanges,
    untracked_file_count: statusSummary.untrackedFileCount,
    untracked_file_samples: statusSummary.untrackedFileSamples,
    ao_artifact_paths: repoRoot ? collectAoArtifactPaths(repoRoot) : [],
    git_observable: true,
    git_error: null,
  });
}
