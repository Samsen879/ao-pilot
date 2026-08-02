#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import {
  loadSelfHostingReceipt,
  P0_R07_ADMISSION_PR,
  verifySelfHostingReceipt,
} from './ao/lib/self-hosting-receipt.js';

function usage() {
  return 'Usage: npm run verify:self-hosting -- --receipt <path> --issue-comment-id <id> [--repository-root <path>]';
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
  return {
    number: value.number,
    merged: value.merged === true,
    merge_sha: value.merge_commit_sha,
    head_sha: value.head?.sha ?? null,
    head_ref: value.head?.ref ?? null,
    base_ref: value.base?.ref ?? null,
    merged_at: value.merged_at ?? null,
    linked_issue_63: /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#63\b/i.test(value.body ?? ''),
  };
}

function codexReviewEvidence(principalPr, repositoryRoot) {
  const submitted = runJson('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${principalPr}/reviews`], { cwd: repositoryRoot })
    .filter((review) => review.user?.login === 'chatgpt-codex-connector[bot]')
    .map((review) => ({
      kind: 'submitted_review',
      evidence_id: review.id,
      head_sha: review.commit_id,
      completed_at: review.submitted_at,
      actor: review.user.login,
      completed: review.submitted_at != null && ['COMMENTED', 'APPROVED', 'CHANGES_REQUESTED'].includes(review.state),
    }));
  const requestComments = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/${principalPr}/comments?per_page=100`], { cwd: repositoryRoot })
    .filter((comment) => comment.user?.login === 'Samsen879' && comment.body?.trimStart().startsWith('@codex review'));
  const clean = requestComments.map((comment) => {
    const reactions = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${comment.id}/reactions`], { cwd: repositoryRoot });
    const reaction = reactions.find((item) => item.user?.login === 'chatgpt-codex-connector[bot]' && item.content === '+1');
    const headSha = comment.body?.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase() ?? null;
    return {
      kind: 'clean_reaction',
      evidence_id: comment.id,
      head_sha: headSha,
      completed_at: reaction?.created_at ?? null,
      actor: reaction?.user?.login ?? null,
      completed: reaction != null && headSha != null,
    };
  }).filter((review) => review.completed);
  return [...submitted, ...clean];
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

function collectEvidence(receipt, repositoryRoot) {
  const sourceHead = receipt.source.clone_head_sha;
  const currentMain = run('git', ['rev-parse', 'HEAD^{commit}'], { cwd: repositoryRoot });
  const currentTree = run('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot });
  run('git', ['cat-file', '-e', `${sourceHead}^{commit}`], { cwd: repositoryRoot });
  const sourceTree = run('git', ['rev-parse', `${sourceHead}^{tree}`], { cwd: repositoryRoot });
  const principalPr = receipt.delivery.principal_pr.number;
  const headSha = receipt.delivery.principal_pr.head_sha;
  const checks = runJson('gh', ['api', `repos/Samsen879/ao-pilot/commits/${headSha}/check-runs`], { cwd: repositoryRoot });
  return {
    repositoryEvidence: {
      current_main_sha: currentMain,
      current_main_tree_sha: currentTree,
      source_commit_sha: sourceHead,
      source_tree_sha: sourceTree,
      release_check_passed: true,
    },
    githubEvidence: {
      admission_pr: pullEvidence(P0_R07_ADMISSION_PR, repositoryRoot),
      principal_pr: pullEvidence(principalPr, repositoryRoot),
      check_runs: checks.check_runs.map((check) => ({ name: check.name, conclusion: check.conclusion })),
      codex_reviews: codexReviewEvidence(principalPr, repositoryRoot),
      review_findings: reviewFindingEvidence(principalPr, repositoryRoot),
    },
  };
}

function publicationEvidence(commentId, rawReceipt, repositoryRoot) {
  const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`], { cwd: repositoryRoot });
  return {
    issue_number: Number(comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1] ?? 0),
    author: comment.user?.login ?? null,
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
  const receiptPath = receiptIndex === -1 ? null : argv[receiptIndex + 1];
  const commentId = commentIndex === -1 ? null : Number(argv[commentIndex + 1]);
  const repositoryRoot = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
  const expectedLength = rootIndex === -1 ? 4 : 6;
  if (receiptPath == null || receiptPath.startsWith('-') || !Number.isSafeInteger(commentId) || commentId <= 0 || repositoryRoot == null || repositoryRoot.startsWith('-') || argv.length !== expectedLength) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const resolvedReceiptPath = path.resolve(receiptPath);
      const resolvedRepositoryRoot = path.resolve(repositoryRoot);
      const rawReceipt = fs.readFileSync(resolvedReceiptPath, 'utf8');
      const receipt = loadSelfHostingReceipt(resolvedReceiptPath);
      run('npm', ['run', 'release:check'], { cwd: resolvedRepositoryRoot, timeout: 30 * 60 * 1000 });
      const evidence = collectEvidence(receipt, resolvedRepositoryRoot);
      const result = verifySelfHostingReceipt(receipt, {
        ...evidence,
        publicationEvidence: publicationEvidence(commentId, rawReceipt, resolvedRepositoryRoot),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'self_hosting_receipt_invalid', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
