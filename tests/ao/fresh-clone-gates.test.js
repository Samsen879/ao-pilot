import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { loadRuntimeLock } from '../../scripts/ao/lib/runtime-lock.js';
import {
  SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
  verifySelfHostingReceipt,
} from '../../scripts/ao/lib/self-hosting-receipt.js';
import { parseArgs, removeTemporaryRoot } from '../../scripts/verify-fresh-clone.js';

function validSelfHostingReceipt() {
  const runtime = loadRuntimeLock().lock;
  return {
    schema_version: SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
    status: 'passed',
    performed_at: '2026-08-03T00:00:00.000Z',
    environment: {
      kind: 'fresh_workstation',
      old_home_read: false,
      old_runtime_state_read: false,
      credentials_copied: false,
      credentials_user_provided: true,
      global_npm_link_used: false,
    },
    source: {
      repository: 'https://github.com/Samsen879/ao-pilot.git',
      admission_pr_number: 69,
      clone_head_sha: '1'.repeat(40),
      clone_tree_sha: '2'.repeat(40),
      clean_before_bootstrap: true,
    },
    runtime: {
      runtime_ref: runtime.runtime_ref,
      repository: runtime.artifact.repository,
      version: runtime.artifact.version,
      tag: runtime.artifact.ref.name,
      commit_sha: runtime.artifact.ref.commit_sha,
      tree_sha: runtime.artifact.ref.tree_sha,
      integrity: runtime.artifact.integrity,
      binary_path: '/isolated/runtime/bin/ao',
      binary_sha256: runtime.compatibility.platforms[0].binary_sha256,
      target: { os: 'linux', arch: 'x64' },
    },
    bootstrap: {
      command: './scripts/bootstrap.sh',
      status: 'installed',
      doctor_runtime_status: 'verified',
    },
    delivery: {
      issue_number: 63,
      orchestrator_session_id: 'or-r08',
      worker_session_id: 'worker-r08',
      worker_created_by_new_ao: true,
      worker_created_from_issue: true,
      worker_worktree_path: '/fresh/ao-pilot/.worktrees/p0-r08-self-hosting',
      worker_branch: 'ao/p0-r08/worker',
      worker_committed: true,
      worker_pushed: true,
      worker_opened_pr: true,
      orchestrator_observed_ci: true,
      orchestrator_observed_codex_review: true,
      review_repairs_same_worker_pr: true,
      github_merge_outcome_confirmed: true,
      principal_pr: {
        number: 70,
        url: 'https://github.com/Samsen879/ao-pilot/pull/70',
        head_sha: '3'.repeat(40),
        reviewed_head: '3'.repeat(40),
        ci_conclusion: 'success',
        codex_reviews: [{
          attempt: 1,
          kind: 'submitted_review',
          evidence_id: 101,
          head_sha: '3'.repeat(40),
          completed_at: '2026-08-03T01:00:00.000Z',
        }],
        post_review_2_repair: null,
        merged: true,
        merge_sha: '4'.repeat(40),
      },
    },
    exact_main_replay: {
      passed: true,
      release_check_passed: true,
      main_sha: '4'.repeat(40),
      tree_sha: '5'.repeat(40),
    },
    cleanup: {
      orchestrator_session_stopped: true,
      worker_session_stopped: true,
      worker_worktree_removed: true,
      stale_ownership_absent: true,
    },
    claim: {
      workstation_self_hosting: true,
      p0_r08_satisfied: true,
    },
  };
}

function validEvidence(receipt) {
  return {
    repositoryEvidence: {
      current_main_sha: receipt.delivery.principal_pr.merge_sha,
      current_main_tree_sha: receipt.exact_main_replay.tree_sha,
      source_commit_sha: receipt.source.clone_head_sha,
      source_tree_sha: receipt.source.clone_tree_sha,
      release_check_passed: true,
    },
    githubEvidence: {
      admission_pr: {
        number: 69,
        merged: true,
        merge_sha: receipt.source.clone_head_sha,
        base_ref: 'main',
      },
      principal_pr: {
        number: receipt.delivery.principal_pr.number,
        merged: true,
        merge_sha: receipt.delivery.principal_pr.merge_sha,
        head_sha: receipt.delivery.principal_pr.head_sha,
        head_ref: receipt.delivery.worker_branch,
        base_ref: 'main',
        merged_at: '2026-08-03T02:00:00.000Z',
        linked_issue_63: true,
      },
      check_runs: ['fresh-clone-runtime', 'test (20)', 'test (22)'].map((name) => ({ name, conclusion: 'success' })),
      codex_reviews: receipt.delivery.principal_pr.codex_reviews.map((review) => ({
        kind: review.kind,
        evidence_id: review.evidence_id,
        head_sha: review.head_sha,
        completed_at: review.completed_at,
        actor: 'chatgpt-codex-connector[bot]',
        completed: true,
      })),
      review_findings: [],
    },
    publicationEvidence: {
      issue_number: 63,
      author: 'Samsen879',
      exact_bytes_match: true,
    },
  };
}

describe('fresh-clone and protected self-hosting gates', () => {
  it('parses bounded fresh-clone orchestration options', () => {
    expect(parseArgs([
      '--source', 'https://github.com/Samsen879/ao-pilot.git',
      '--ref', 'a'.repeat(40),
      '--cache', '/tmp/verified-cache',
      '--receipt-out', '/tmp/receipt.json',
      '--expected-head', 'b'.repeat(40),
    ])).toMatchObject({
      source: 'https://github.com/Samsen879/ao-pilot.git',
      ref: 'a'.repeat(40),
      cacheRoot: '/tmp/verified-cache',
      receiptOut: '/tmp/receipt.json',
      expectedHead: 'b'.repeat(40),
    });
  });

  it('rejects unknown fresh-clone options before any command executes', () => {
    expect(() => parseArgs(['--trust-path-ao'])).toThrow('Unknown argument');
  });

  it('rejects a non-immutable expected CI head', () => {
    expect(() => parseArgs(['--expected-head', 'main'])).toThrow('Invalid value for --expected-head');
  });

  it('cleans verifier-owned read-only module-cache directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-fresh-cleanup-test-'));
    const readonly = path.join(root, 'module', '.github');
    fs.mkdirSync(readonly, { recursive: true });
    fs.writeFileSync(path.join(readonly, 'fixture'), 'read-only\n');
    fs.chmodSync(readonly, 0o500);
    fs.chmodSync(path.dirname(readonly), 0o500);

    removeTemporaryRoot(root);

    expect(fs.existsSync(root)).toBe(false);
  });

  it('accepts a complete AO-created new-workstation receipt', () => {
    const receipt = validSelfHostingReceipt();
    expect(verifySelfHostingReceipt(receipt, validEvidence(receipt))).toMatchObject({
      status: 'verified',
      issue_number: 63,
      principal_pr: 70,
      review_count: 1,
    });
  });

  it.each([
    ['manual worker substitution', (receipt) => { receipt.delivery.worker_created_by_new_ao = false; }],
    ['copied credential state', (receipt) => { receipt.environment.credentials_copied = true; }],
    ['runtime drift', (receipt) => { receipt.runtime.commit_sha = 'f'.repeat(40); }],
    ['missing exact-head review', (receipt) => { receipt.delivery.principal_pr.codex_reviews[0].head_sha = 'e'.repeat(40); }],
    ['failed cleanup', (receipt) => { receipt.cleanup.worker_worktree_removed = false; }],
  ])('fails closed for %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    mutate(receipt);
    expect(() => verifySelfHostingReceipt(receipt, validEvidence(receipt))).toThrow();
  });

  it('rejects fabricated or incomplete Codex Review evidence', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.codex_reviews[0].completed = false;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('not completed');
  });

  it('rejects an unrelated source commit and tree', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.repositoryEvidence.source_tree_sha = 'f'.repeat(40);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('commit-to-tree');
  });

  it('allows only the authorized Review-2 finding repair exception for a later final HEAD', () => {
    const receipt = validSelfHostingReceipt();
    receipt.delivery.principal_pr.codex_reviews.push({
      attempt: 2,
      kind: 'submitted_review',
      evidence_id: 202,
      head_sha: '6'.repeat(40),
      completed_at: '2026-08-03T01:30:00.000Z',
    });
    receipt.delivery.principal_pr.reviewed_head = '6'.repeat(40);
    receipt.delivery.principal_pr.head_sha = '7'.repeat(40);
    receipt.delivery.principal_pr.post_review_2_repair = {
      authorization_ref: 'https://github.com/Samsen879/ao-pilot/issues/55',
      final_head_sha: '7'.repeat(40),
      finding_comment_ids: [303],
    };
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.review_findings = [{ comment_id: 303, review_id: 202, resolved: true }];
    expect(verifySelfHostingReceipt(receipt, evidence)).toMatchObject({
      status: 'verified',
      reviewed_head: '6'.repeat(40),
      review_count: 2,
    });
  });

  it('rejects review completion after the GitHub merge time', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.principal_pr.merged_at = '2026-08-03T00:30:00.000Z';
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('completed after merge');
  });

  it('rejects a receipt not published byte-for-byte to issue #63', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.publicationEvidence.exact_bytes_match = false;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('exact_bytes_match');
  });
});
