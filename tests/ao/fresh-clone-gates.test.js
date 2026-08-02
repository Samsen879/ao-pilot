import { describe, expect, it } from '@jest/globals';

import { loadRuntimeLock } from '../../scripts/ao/lib/runtime-lock.js';
import {
  SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
  verifySelfHostingReceipt,
} from '../../scripts/ao/lib/self-hosting-receipt.js';
import { parseArgs } from '../../scripts/verify-fresh-clone.js';

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
    },
    bootstrap: {
      command: './scripts/bootstrap.sh',
      status: 'installed',
      doctor_runtime_status: 'verified',
    },
    delivery: {
      issue_number: 63,
      worker_created_by_new_ao: true,
      worker_worktree_path: '/fresh/ao-pilot/.worktrees/p0-r08-self-hosting',
      principal_pr: {
        number: 70,
        url: 'https://github.com/Samsen879/ao-pilot/pull/70',
        reviewed_head: '3'.repeat(40),
        ci_conclusion: 'success',
        codex_reviews: [{ id: 1, head_sha: '3'.repeat(40) }],
        merged: true,
        merge_sha: '4'.repeat(40),
      },
    },
    exact_main_replay: {
      passed: true,
      main_sha: '4'.repeat(40),
    },
    cleanup: {
      session_stopped: true,
      worker_worktree_removed: true,
      stale_ownership_absent: true,
    },
    claim: {
      workstation_self_hosting: true,
      p0_r08_satisfied: true,
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
    ])).toMatchObject({
      source: 'https://github.com/Samsen879/ao-pilot.git',
      ref: 'a'.repeat(40),
      cacheRoot: '/tmp/verified-cache',
      receiptOut: '/tmp/receipt.json',
    });
  });

  it('rejects unknown fresh-clone options before any command executes', () => {
    expect(() => parseArgs(['--trust-path-ao'])).toThrow('Unknown argument');
  });

  it('accepts a complete AO-created new-workstation receipt', () => {
    expect(verifySelfHostingReceipt(validSelfHostingReceipt())).toMatchObject({
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
    expect(() => verifySelfHostingReceipt(receipt)).toThrow();
  });
});
