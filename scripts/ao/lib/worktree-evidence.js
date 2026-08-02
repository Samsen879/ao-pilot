import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  P0_R07_ADMITTED_MAIN,
  P0_R07_ADMITTED_TREE,
} from './self-hosting-receipt.js';

export const WORKTREE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-worktree-evidence.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(repositoryRoot, args) {
  return execFileSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function realGitPath(repositoryRoot, gitPath) {
  const absolute = path.isAbsolute(gitPath) ? gitPath : path.resolve(repositoryRoot, gitPath);
  return fs.realpathSync(absolute);
}

export function inspectWorktreeBinding({
  sourceRoot,
  workerRoot,
  workerSessionId,
  capturedAt = new Date().toISOString(),
}) {
  assert(typeof workerSessionId === 'string' && workerSessionId.trim() !== '', 'Worker session ID is required');
  assert(!Number.isNaN(Date.parse(capturedAt)), 'Invalid capture timestamp');

  const sourceTopLevel = fs.realpathSync(git(sourceRoot, ['rev-parse', '--show-toplevel']));
  const workerTopLevel = fs.realpathSync(git(workerRoot, ['rev-parse', '--show-toplevel']));
  const sourceCommonDir = realGitPath(sourceTopLevel, git(sourceTopLevel, ['rev-parse', '--git-common-dir']));
  const workerCommonDir = realGitPath(workerTopLevel, git(workerTopLevel, ['rev-parse', '--git-common-dir']));
  const sourceHead = git(sourceTopLevel, ['rev-parse', 'HEAD^{commit}']);
  const sourceTree = git(sourceTopLevel, ['rev-parse', 'HEAD^{tree}']);
  const workerHead = git(workerTopLevel, ['rev-parse', 'HEAD^{commit}']);
  const workerBranch = git(workerTopLevel, ['branch', '--show-current']);

  assert(sourceTopLevel !== workerTopLevel, 'Worker reused the bootstrap source worktree');
  assert(sourceCommonDir === workerCommonDir, 'Worker is not an independently bound worktree of the bootstrap clone');
  assert(/^ao\//.test(workerBranch), 'Worker branch is not AO-owned');

  return {
    schema_version: WORKTREE_EVIDENCE_SCHEMA_VERSION,
    issue_number: 63,
    captured_at: capturedAt,
    source: {
      clone_path: sourceTopLevel,
      head_sha: sourceHead,
      tree_sha: sourceTree,
      git_common_dir: sourceCommonDir,
    },
    worker: {
      session_id: workerSessionId.trim(),
      worktree_path: workerTopLevel,
      branch: workerBranch,
      head_sha: workerHead,
      git_common_dir: workerCommonDir,
    },
  };
}

export function captureWorktreeEvidence(options) {
  const evidence = inspectWorktreeBinding(options);
  assert(evidence.source.head_sha === P0_R07_ADMITTED_MAIN, 'Source worktree is not at the admitted P0-R07 main');
  assert(evidence.source.tree_sha === P0_R07_ADMITTED_TREE, 'Source worktree tree is not the admitted P0-R07 tree');
  return evidence;
}
