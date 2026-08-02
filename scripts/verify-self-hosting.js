#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import {
  collectCodexReviewEvidence,
} from './ao/lib/codex-review-evidence.js';
import { issueLinkedPrEvidenceFromTimeline } from './ao/lib/issue-linked-pr-evidence.js';
import {
  loadSelfHostingReceipt,
  P0_R08_RETRY_ADMISSION_COMMENT,
  P0_R08_RETRY_ADMISSION_PR,
  P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT,
  P0_R08_FAILED_TERMINAL_PR,
  P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT,
  P0_R08_PRINCIPAL_PR,
  P0_R08_TERMINAL_ADMISSION_COMMENT,
  verifySelfHostingReceipt,
} from './ao/lib/self-hosting-receipt.js';

function usage() {
  return 'Usage: npm run verify:self-hosting -- --receipt <path> [--pre-merge] [--issue-comment-id <id>] [--repository-root <path>]';
}

function run(command, args, { cwd = process.cwd(), timeout = 30_000 } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Evidence command failed: ${command} ${args.join(' ')}: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

function runJson(command, args, options) {
  return JSON.parse(run(command, args, options));
}

function pullEvidence(number, repositoryRoot) {
  const value = runJson('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${number}`], { cwd: repositoryRoot });
  const body = value.body ?? '';
  const mergeTree = value.merged === true && value.merge_commit_sha != null
    ? runJson('gh', ['api', `repos/Samsen879/ao-pilot/git/commits/${value.merge_commit_sha}`], { cwd: repositoryRoot }).tree?.sha ?? null
    : null;
  return {
    number: value.number,
    merged: value.merged === true,
    merge_sha: value.merged === true ? value.merge_commit_sha : null,
    merge_tree_sha: mergeTree,
    head_sha: value.head?.sha ?? null,
    head_ref: value.head?.ref ?? null,
    base_ref: value.base?.ref ?? null,
    merged_at: value.merged_at ?? null,
    created_at: value.created_at ?? null,
    linked_issue_63: /(^|\s)#63\b/.test(body),
    auto_closes_issue_63: /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#63\b/i.test(body),
    binds_terminal_admission: /\b5158510418\b/.test(body) && /terminal[- ]recovery/i.test(body),
    binds_principal_pr_71: /(?:\bPR\s*#71\b|\bprincipal[^\n]*#71\b)/i.test(body),
    binds_failed_terminal_pr_72: /(?:\bPR\s*#72\b|\bfailed[^\n]*#72\b)/i.test(body),
  };
}

function admissionEvidence(commentId, repositoryRoot) {
  const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`], { cwd: repositoryRoot });
  return {
    comment_id: comment.id,
    issue_number: Number(comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1] ?? 0),
    author: comment.user?.login ?? null,
    author_association: comment.author_association ?? null,
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
    body_bytes: Buffer.byteLength(comment.body ?? '', 'utf8'),
    body_sha256: createHash('sha256').update(comment.body ?? '').digest('hex'),
  };
}

function codexReviewEvidence(principalPr, repositoryRoot) {
  return collectCodexReviewEvidence({
    comments: runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/${principalPr}/comments?per_page=100`], { cwd: repositoryRoot }),
    reviews: runJson('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${principalPr}/reviews`], { cwd: repositoryRoot }),
    reactionsForComment(commentId) {
      return runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}/reactions`], { cwd: repositoryRoot });
    },
  });
}

function issueLinkedPrEvidence(repositoryRoot) {
  const query = 'query { repository(owner:"Samsen879", name:"ao-pilot") { issue(number:63) { timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT]) { pageInfo { hasNextPage } nodes { ... on CrossReferencedEvent { source { __typename ... on PullRequest { repository { nameWithOwner } number url createdAt headRefName baseRefName } } } } } } } }';
  const timeline = runJson('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd: repositoryRoot })
    .data.repository.issue.timelineItems;
  return issueLinkedPrEvidenceFromTimeline(timeline);
}

function reviewFindingEvidence(principalPr, repositoryRoot) {
  const comments = runJson('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${principalPr}/comments?per_page=100`], { cwd: repositoryRoot });
  const query = `query { repository(owner:"Samsen879", name:"ao-pilot") { pullRequest(number:${principalPr}) { reviewThreads(first:100) { nodes { isResolved comments(first:100) { nodes { databaseId } } } } } } }`;
  const threads = runJson('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd: repositoryRoot })
    .data.repository.pullRequest.reviewThreads.nodes;
  const resolvedByComment = new Map();
  for (const thread of threads) {
    for (const comment of thread.comments.nodes) resolvedByComment.set(comment.databaseId, thread.isResolved);
  }
  return comments
    .filter((comment) => comment.user?.login === 'chatgpt-codex-connector[bot]')
    .map((comment) => ({
      comment_id: comment.id,
      review_id: comment.pull_request_review_id,
      resolved: resolvedByComment.get(comment.id) === true,
    }));
}

function jsonIssueCommentEvidence(commentId, repositoryRoot) {
  const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`], { cwd: repositoryRoot });
  let payload = null;
  try {
    payload = JSON.parse(comment.body ?? '');
  } catch {
    // The receipt verifier reports the bounded payload error.
  }
  return {
    comment_id: comment.id,
    issue_number: Number(comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1] ?? 0),
    author: comment.user?.login ?? null,
    author_association: comment.author_association ?? null,
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
    body_bytes: Buffer.byteLength(comment.body ?? '', 'utf8'),
    body_sha256: createHash('sha256').update(comment.body ?? '').digest('hex'),
    payload,
  };
}

function collectEvidence(receipt, repositoryRoot, { preMerge = false } = {}) {
  const sourceHead = receipt.source.clone_head_sha;
  const terminalSourceHead = receipt.terminal_remediation.source.clone_head_sha;
  const currentMain = run('git', ['rev-parse', 'HEAD^{commit}'], { cwd: repositoryRoot });
  const currentTree = run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot });
  run('git', ['cat-file', '-e', `${sourceHead}^{commit}`], { cwd: repositoryRoot });
  const sourceTree = run('git', ['rev-parse', `${sourceHead}^{tree}`], { cwd: repositoryRoot });
  run('git', ['cat-file', '-e', `${terminalSourceHead}^{commit}`], { cwd: repositoryRoot });
  const terminalSourceTree = run('git', ['rev-parse', `${terminalSourceHead}^{tree}`], { cwd: repositoryRoot });
  const principalPr = receipt.delivery.principal_pr.number;
  const headSha = receipt.delivery.principal_pr.head_sha;
  const checks = runJson('gh', ['api', `repos/Samsen879/ao-pilot/commits/${headSha}/check-runs`], { cwd: repositoryRoot });
  const remediationPr = receipt.terminal_remediation.delivery.remediation_pr.number;
  const remediationHead = receipt.terminal_remediation.delivery.remediation_pr.head_sha;
  run('git', ['cat-file', '-e', `${remediationHead}^{commit}`], { cwd: repositoryRoot });
  const terminalWorkerTree = run('git', ['rev-parse', `${remediationHead}^{tree}`], { cwd: repositoryRoot });
  run('git', ['merge-base', '--is-ancestor', terminalSourceHead, remediationHead], { cwd: repositoryRoot });
  const terminalMergeBase = run('git', ['merge-base', terminalSourceHead, remediationHead], { cwd: repositoryRoot });
  const terminalChecks = runJson('gh', ['api', `repos/Samsen879/ao-pilot/commits/${remediationHead}/check-runs`], { cwd: repositoryRoot });
  return {
    repositoryEvidence: {
      current_main_sha: currentMain,
      current_main_tree_sha: currentTree,
      source_commit_sha: sourceHead,
      source_tree_sha: sourceTree,
      terminal_source_commit_sha: terminalSourceHead,
      terminal_source_tree_sha: terminalSourceTree,
      terminal_worker_commit_sha: remediationHead,
      terminal_worker_tree_sha: terminalWorkerTree,
      terminal_source_is_ancestor: true,
      terminal_merge_base_sha: terminalMergeBase,
      release_check_passed: true,
    },
    githubEvidence: {
      issue_63: (() => {
        const issue = runJson('gh', ['api', 'repos/Samsen879/ao-pilot/issues/63'], { cwd: repositoryRoot });
        return { number: issue.number, state: issue.state };
      })(),
      admission_pr: pullEvidence(P0_R08_RETRY_ADMISSION_PR, repositoryRoot),
      retry_admission: admissionEvidence(P0_R08_RETRY_ADMISSION_COMMENT, repositoryRoot),
      principal_pr: pullEvidence(P0_R08_PRINCIPAL_PR, repositoryRoot),
      first_terminal_admission: admissionEvidence(P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT, repositoryRoot),
      failed_terminal_pr: pullEvidence(P0_R08_FAILED_TERMINAL_PR, repositoryRoot),
      failed_terminal_disposition: admissionEvidence(P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT, repositoryRoot),
      terminal_remediation_admission: admissionEvidence(P0_R08_TERMINAL_ADMISSION_COMMENT, repositoryRoot),
      terminal_remediation_pr: pullEvidence(remediationPr, repositoryRoot),
      issue_linked_prs: issueLinkedPrEvidence(repositoryRoot),
      check_runs: checks.check_runs.map((check) => ({ name: check.name, conclusion: check.conclusion })),
      codex_reviews: codexReviewEvidence(principalPr, repositoryRoot),
      failed_terminal_codex_reviews: codexReviewEvidence(P0_R08_FAILED_TERMINAL_PR, repositoryRoot),
      terminal_check_runs: terminalChecks.check_runs.map((check) => ({ name: check.name, conclusion: check.conclusion })),
      terminal_codex_reviews: codexReviewEvidence(remediationPr, repositoryRoot),
      review_findings: reviewFindingEvidence(principalPr, repositoryRoot),
      terminal_review_findings: reviewFindingEvidence(remediationPr, repositoryRoot),
      worktree_capture: jsonIssueCommentEvidence(receipt.delivery.worktree_evidence_comment_id, repositoryRoot),
      orchestrator_done_capture: jsonIssueCommentEvidence(receipt.cleanup.orchestrator_done_evidence_comment_id, repositoryRoot),
      terminal_worktree_capture: jsonIssueCommentEvidence(receipt.terminal_remediation.delivery.worktree_evidence_comment_id, repositoryRoot),
      terminal_orchestrator_done_capture: preMerge ? null : jsonIssueCommentEvidence(receipt.terminal_remediation.cleanup.orchestrator_done_evidence_comment_id, repositoryRoot),
    },
  };
}

function publicationEvidence(commentId, rawReceipt, repositoryRoot) {
  const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`], { cwd: repositoryRoot });
  return {
    issue_number: Number(comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1] ?? 0),
    author: comment.user?.login ?? null,
    created_at: comment.created_at ?? null,
    exact_bytes_match: String(comment.body ?? '').trimEnd() === rawReceipt.trimEnd(),
  };
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const receiptIndex = argv.indexOf('--receipt');
  const commentIndex = argv.indexOf('--issue-comment-id');
  const rootIndex = argv.indexOf('--repository-root');
  const preMerge = argv.includes('--pre-merge');
  const receiptPath = receiptIndex === -1 ? null : argv[receiptIndex + 1];
  const commentId = commentIndex === -1 ? null : Number(argv[commentIndex + 1]);
  const repositoryRoot = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
  const expectedLength = 2 + (preMerge ? 1 : 0) + (commentIndex === -1 ? 0 : 2) + (rootIndex === -1 ? 0 : 2);
  const invalidComment = commentIndex !== -1 && (!Number.isSafeInteger(commentId) || commentId <= 0);
  if (receiptPath == null || receiptPath.startsWith('-') || invalidComment || (preMerge && commentId != null) || repositoryRoot == null || repositoryRoot.startsWith('-') || argv.length !== expectedLength) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const resolvedReceiptPath = path.resolve(receiptPath);
      const resolvedRepositoryRoot = path.resolve(repositoryRoot);
      const rawReceipt = fs.readFileSync(resolvedReceiptPath, 'utf8');
      const receipt = loadSelfHostingReceipt(resolvedReceiptPath);
      run('npm', ['run', 'release:check'], { cwd: resolvedRepositoryRoot, timeout: 30 * 60 * 1000 });
      const evidence = collectEvidence(receipt, resolvedRepositoryRoot, { preMerge });
      const result = verifySelfHostingReceipt(receipt, {
        ...evidence,
        publicationEvidence: commentId == null ? null : publicationEvidence(commentId, rawReceipt, resolvedRepositoryRoot),
        requirePublication: preMerge ? false : commentId != null,
        stage: preMerge ? 'pre_merge' : 'final',
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'self_hosting_receipt_invalid', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
