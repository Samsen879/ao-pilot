#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import {
  ownerExactHeadReviewRequests,
  submittedCodexReviewEvidence,
} from './ao/lib/codex-review-evidence.js';
import {
  loadSelfHostingReceipt,
  P0_R08_RETRY_ADMISSION_COMMENT,
  P0_R08_RETRY_ADMISSION_PR,
  verifySelfHostingReceipt,
} from './ao/lib/self-hosting-receipt.js';

function usage() {
  return 'Usage: npm run verify:self-hosting -- --receipt <path> [--issue-comment-id <id>] [--repository-root <path>]';
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
    created_at: value.created_at ?? null,
    linked_issue_63: /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#63\b/i.test(value.body ?? ''),
  };
}

function retryAdmissionEvidence(repositoryRoot) {
  const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${P0_R08_RETRY_ADMISSION_COMMENT}`], { cwd: repositoryRoot });
  return {
    comment_id: comment.id,
    issue_number: Number(comment.issue_url?.match(/\/issues\/(\d+)$/)?.[1] ?? 0),
    author: comment.user?.login ?? null,
    author_association: comment.author_association ?? null,
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
    body_sha256: createHash('sha256').update(comment.body ?? '').digest('hex'),
  };
}

function codexReviewEvidence(principalPr, repositoryRoot) {
  const requestComments = ownerExactHeadReviewRequests(
    runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/${principalPr}/comments?per_page=100`], { cwd: repositoryRoot }),
  );
  const submitted = submittedCodexReviewEvidence(
    runJson('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${principalPr}/reviews`], { cwd: repositoryRoot }),
    requestComments,
  );
  const clean = requestComments.map((comment) => {
    const reactions = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${comment.id}/reactions`], { cwd: repositoryRoot });
    const reaction = reactions.find((item) => (
      item.user?.login === 'chatgpt-codex-connector[bot]'
      && item.content === '+1'
      && Date.parse(item.created_at) >= Date.parse(comment.requested_at)
    ));
    return {
      kind: 'clean_reaction',
      evidence_id: comment.comment_id,
      request_comment_id: comment.comment_id,
      request_valid: true,
      head_sha: comment.head_sha,
      completed_at: reaction?.created_at ?? null,
      actor: reaction?.user?.login ?? null,
      completed: reaction != null,
    };
  }).filter((review) => review.completed);
  return [...submitted, ...clean];
}

function issueLinkedPrEvidence(repositoryRoot) {
  const query = 'query { repository(owner:"Samsen879", name:"ao-pilot") { issue(number:63) { timelineItems(first:100, itemTypes:[CROSS_REFERENCED_EVENT]) { pageInfo { hasNextPage } nodes { ... on CrossReferencedEvent { source { __typename ... on PullRequest { number url createdAt headRefName baseRefName } } } } } } } }';
  const timeline = runJson('gh', ['api', 'graphql', '-f', `query=${query}`], { cwd: repositoryRoot })
    .data.repository.issue.timelineItems;
  if (timeline.pageInfo.hasNextPage) throw new Error('Issue-linked PR evidence exceeds the bounded GraphQL page');
  const linked = new Map();
  for (const event of timeline.nodes) {
    if (event.source?.__typename !== 'PullRequest') continue;
    linked.set(event.source.number, {
      number: event.source.number,
      url: event.source.url,
      created_at: event.source.createdAt,
      head_ref: event.source.headRefName,
      base_ref: event.source.baseRefName,
    });
  }
  return [...linked.values()];
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
    created_at: comment.created_at ?? null,
    updated_at: comment.updated_at ?? null,
    payload,
  };
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
      admission_pr: pullEvidence(P0_R08_RETRY_ADMISSION_PR, repositoryRoot),
      retry_admission: retryAdmissionEvidence(repositoryRoot),
      principal_pr: pullEvidence(principalPr, repositoryRoot),
      issue_linked_prs: issueLinkedPrEvidence(repositoryRoot),
      check_runs: checks.check_runs.map((check) => ({ name: check.name, conclusion: check.conclusion })),
      codex_reviews: codexReviewEvidence(principalPr, repositoryRoot),
      review_findings: reviewFindingEvidence(principalPr, repositoryRoot),
      worktree_capture: jsonIssueCommentEvidence(receipt.delivery.worktree_evidence_comment_id, repositoryRoot),
      orchestrator_done_capture: jsonIssueCommentEvidence(receipt.cleanup.orchestrator_done_evidence_comment_id, repositoryRoot),
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
  const receiptPath = receiptIndex === -1 ? null : argv[receiptIndex + 1];
  const commentId = commentIndex === -1 ? null : Number(argv[commentIndex + 1]);
  const repositoryRoot = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
  const expectedLength = 2 + (commentIndex === -1 ? 0 : 2) + (rootIndex === -1 ? 0 : 2);
  const invalidComment = commentIndex !== -1 && (!Number.isSafeInteger(commentId) || commentId <= 0);
  if (receiptPath == null || receiptPath.startsWith('-') || invalidComment || repositoryRoot == null || repositoryRoot.startsWith('-') || argv.length !== expectedLength) {
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
        publicationEvidence: commentId == null ? null : publicationEvidence(commentId, rawReceipt, resolvedRepositoryRoot),
        requirePublication: commentId != null,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'self_hosting_receipt_invalid', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
