import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  P0_R08_TERMINAL_AO_DATA_DIR,
  P0_R08_TERMINAL_AO_RUN_FILE,
  P0_R08_FINAL_ADMITTED_MAIN,
  P0_R08_FINAL_ADMITTED_TREE,
  P0_R08_FAILED_MERGE_PATH_PR,
  P0_R08_FINAL_ADMISSION_COMMENT,
  P0_R08_TERMINAL_ADMISSION_COMMENT,
  P0_R08_TERMINAL_ROOT,
} from './self-hosting-receipt.js';

export const WORKTREE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-worktree-evidence.v6';

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
  workerSession,
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
  const workerTree = git(workerTopLevel, ['rev-parse', 'HEAD^{tree}']);
  const workerBranch = git(workerTopLevel, ['branch', '--show-current']);
  const mergeBase = git(workerTopLevel, ['merge-base', sourceHead, workerHead]);
  const reflogLines = git(workerTopLevel, [
    'reflog', 'show', '--date=iso-strict', '--format=%H%x09%gD%x09%gs', `refs/heads/${workerBranch}`,
  ]).split('\n');
  const creationFields = reflogLines.at(-1)?.split('\t') ?? [];
  const branchCreatedAt = creationFields[1]?.match(/@\{(.+)\}$/)?.[1] ?? null;
  const branchCreatedFrom = creationFields.slice(2).join('\t');

  assert(sourceTopLevel !== workerTopLevel, 'Worker reused the bootstrap source worktree');
  assert(sourceCommonDir === workerCommonDir, 'Worker is not an independently bound worktree of the bootstrap clone');
  assert(/^ao\//.test(workerBranch), 'Worker branch is not AO-owned');
  assert(mergeBase === sourceHead, 'Worker did not fork from the admitted source HEAD');
  assert(creationFields[0] === sourceHead && branchCreatedFrom.startsWith('branch: Created from '), 'Worker branch creation reflog does not start at the admitted source HEAD');
  assert(branchCreatedAt != null && !Number.isNaN(Date.parse(branchCreatedAt)), 'Worker branch creation timestamp is unavailable');
  assert(workerSession?.id === workerSessionId && workerSession?.kind === 'worker', 'Worker branch creation is not bound to the declared AO Worker session');
  assert(workerSession?.projectId === 'ao-pilot-remediation' && String(workerSession?.issueId) === '63', 'AO Worker session is outside the admitted project/issue');
  const workerSessionCreatedAt = workerSession.createdAt;
  assert(!Number.isNaN(Date.parse(workerSessionCreatedAt)), 'AO Worker session creation timestamp is unavailable');
  assert(Math.abs(Date.parse(branchCreatedAt) - Date.parse(workerSessionCreatedAt)) < 2_000, 'Worker branch creation does not coincide with AO Worker session creation');

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
      tree_sha: workerTree,
      git_common_dir: workerCommonDir,
    },
    git_relationship: {
      source_is_ancestor: true,
      merge_base_sha: mergeBase,
      branch_creation_sha: creationFields[0],
      branch_creation_at: branchCreatedAt,
      branch_creation_subject: branchCreatedFrom,
      worker_session_created_at: workerSessionCreatedAt,
    },
  };
}

export function captureWorktreeEvidence({ env = process.env, ...options }) {
  const evidence = inspectWorktreeBinding(options);
  assert(evidence.source.head_sha === P0_R08_FINAL_ADMITTED_MAIN, 'Source worktree is not at the final admitted terminal-remediation main');
  assert(evidence.source.tree_sha === P0_R08_FINAL_ADMITTED_TREE, 'Source worktree tree is not the final admitted terminal-remediation tree');
  assert(evidence.git_relationship.merge_base_sha === P0_R08_FINAL_ADMITTED_MAIN, 'Worker merge base is not the final-admission baseline');
  assert(evidence.git_relationship.branch_creation_sha === P0_R08_FINAL_ADMITTED_MAIN, 'Worker branch was not created at the final-admission baseline');
  assert(path.dirname(evidence.source.clone_path) === P0_R08_TERMINAL_ROOT, 'Source worktree is outside the terminal-remediation root');
  assert(env.AO_DATA_DIR === P0_R08_TERMINAL_AO_DATA_DIR, 'AO_DATA_DIR is not terminal-remediation-specific');
  assert(env.AO_RUN_FILE === P0_R08_TERMINAL_AO_RUN_FILE, 'AO_RUN_FILE is not terminal-remediation-specific');
  return {
    ...evidence,
    isolation: {
      remediation_root: P0_R08_TERMINAL_ROOT,
      ao_data_dir: env.AO_DATA_DIR,
      ao_run_file: env.AO_RUN_FILE,
    },
    recovery_chain: {
      standing_admission_comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
      final_admission_comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
      attempt: 3,
      prior_attempt_pr_number: P0_R08_FAILED_MERGE_PATH_PR,
      admitted_main_sha: P0_R08_FINAL_ADMITTED_MAIN,
      admitted_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
    },
  };
}
