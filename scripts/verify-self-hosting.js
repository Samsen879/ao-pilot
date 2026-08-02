#!/usr/bin/env node

import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  loadSelfHostingReceipt,
  P0_R07_ADMISSION_PR,
  verifySelfHostingReceipt,
} from './ao/lib/self-hosting-receipt.js';

function usage() {
  return 'Usage: npm run verify:self-hosting -- --receipt <path> [--repository-root <path>]';
}

function run(command, args, { cwd = process.cwd() } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
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
    base_ref: value.base?.ref ?? null,
  };
}

function codexReviewEvidence(receiptReviews, principalPr, repositoryRoot) {
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
  const clean = receiptReviews.filter((review) => review.kind === 'clean_reaction').map((review) => {
    const comment = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${review.evidence_id}`], { cwd: repositoryRoot });
    const reactions = runJson('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${review.evidence_id}/reactions`], { cwd: repositoryRoot });
    const reaction = reactions.find((item) => item.user?.login === 'chatgpt-codex-connector[bot]' && item.content === '+1');
    return {
      kind: 'clean_reaction',
      evidence_id: comment.id,
      head_sha: comment.body?.includes(review.head_sha) ? review.head_sha : null,
      completed_at: reaction?.created_at ?? null,
      actor: reaction?.user?.login ?? null,
      completed: reaction != null && comment.user?.login === 'Samsen879' && comment.body?.includes('@codex review'),
    };
  });
  return [...submitted, ...clean];
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
    },
    githubEvidence: {
      admission_pr: pullEvidence(P0_R07_ADMISSION_PR, repositoryRoot),
      principal_pr: pullEvidence(principalPr, repositoryRoot),
      check_runs: checks.check_runs.map((check) => ({ name: check.name, conclusion: check.conclusion })),
      codex_reviews: codexReviewEvidence(receipt.delivery.principal_pr.codex_reviews, principalPr, repositoryRoot),
    },
  };
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${usage()}\n`);
} else {
  const receiptIndex = argv.indexOf('--receipt');
  const rootIndex = argv.indexOf('--repository-root');
  const receiptPath = receiptIndex === -1 ? null : argv[receiptIndex + 1];
  const repositoryRoot = rootIndex === -1 ? process.cwd() : argv[rootIndex + 1];
  const expectedLength = rootIndex === -1 ? 2 : 4;
  if (receiptPath == null || receiptPath.startsWith('-') || repositoryRoot == null || repositoryRoot.startsWith('-') || argv.length !== expectedLength) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 4;
  } else {
    try {
      const receipt = loadSelfHostingReceipt(path.resolve(receiptPath));
      const evidence = collectEvidence(receipt, path.resolve(repositoryRoot));
      const result = verifySelfHostingReceipt(receipt, evidence);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'blocked', code: 'self_hosting_receipt_invalid', message: error.message }, null, 2)}\n`);
      process.exitCode = 2;
    }
  }
}
