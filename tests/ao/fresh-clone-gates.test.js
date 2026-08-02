import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from '@jest/globals';

import {
  ownerExactHeadReviewRequests,
  submittedCodexReviewEvidence,
} from '../../scripts/ao/lib/codex-review-evidence.js';
import { loadRuntimeLock } from '../../scripts/ao/lib/runtime-lock.js';
import {
  ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION,
  captureOrchestratorDoneEvidence,
} from '../../scripts/ao/lib/orchestrator-done-evidence.js';
import {
  P0_R08_RETRY_AO_DATA_DIR,
  P0_R08_RETRY_AO_RUN_FILE,
  P0_R08_RETRY_ADMISSION_COMMENT,
  P0_R08_RETRY_ADMISSION_COMMENT_SHA256,
  P0_R08_RETRY_ADMISSION_PR,
  P0_R08_RETRY_ADMITTED_MAIN,
  P0_R08_RETRY_ADMITTED_TREE,
  P0_R08_RETRY_ROOT,
  P0_R08_RETRY_RUNTIME_CACHE,
  P0_R08_RETRY_RUNTIME_STORE,
  SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
  verifySelfHostingReceipt,
} from '../../scripts/ao/lib/self-hosting-receipt.js';
import { parseArgs, removeTemporaryRoot } from '../../scripts/verify-fresh-clone.js';
import { inspectWorktreeBinding } from '../../scripts/ao/lib/worktree-evidence.js';

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
      retry_root: P0_R08_RETRY_ROOT,
      ao_data_dir: P0_R08_RETRY_AO_DATA_DIR,
      ao_run_file: P0_R08_RETRY_AO_RUN_FILE,
      runtime_store: P0_R08_RETRY_RUNTIME_STORE,
      runtime_cache: P0_R08_RETRY_RUNTIME_CACHE,
    },
    source: {
      repository: 'https://github.com/Samsen879/ao-pilot.git',
      admission_pr_number: P0_R08_RETRY_ADMISSION_PR,
      clone_path: `${P0_R08_RETRY_ROOT}/ao-pilot`,
      clone_head_sha: P0_R08_RETRY_ADMITTED_MAIN,
      clone_tree_sha: P0_R08_RETRY_ADMITTED_TREE,
      clean_before_bootstrap: true,
    },
    retry_admission: {
      issue_number: 63,
      comment_id: P0_R08_RETRY_ADMISSION_COMMENT,
      comment_body_sha256: P0_R08_RETRY_ADMISSION_COMMENT_SHA256,
      historical_pr_number: P0_R08_RETRY_ADMISSION_PR,
      historical_merge_sha: P0_R08_RETRY_ADMITTED_MAIN,
      historical_tree_sha: P0_R08_RETRY_ADMITTED_TREE,
    },
    runtime: {
      runtime_ref: runtime.runtime_ref,
      repository: runtime.artifact.repository,
      version: runtime.artifact.version,
      tag: runtime.artifact.ref.name,
      commit_sha: runtime.artifact.ref.commit_sha,
      tree_sha: runtime.artifact.ref.tree_sha,
      integrity: runtime.artifact.integrity,
      binary_path: `${P0_R08_RETRY_RUNTIME_STORE}/${runtime.runtime_ref}/linux-x64/${runtime.artifact.ref.commit_sha}/bin/ao`,
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
      worker_worktree_path: `${P0_R08_RETRY_AO_DATA_DIR}/worktrees/ao-pilot/ao-pilot-2`,
      worktree_evidence_comment_id: 88,
      worker_branch: 'ao/p0-r08/worker',
      worker_committed: true,
      worker_pushed: true,
      worker_opened_pr: true,
      orchestrator_observed_ci: true,
      orchestrator_observed_codex_review: true,
      review_repairs_same_worker_pr: true,
      github_merge_outcome_confirmed: true,
      principal_pr: {
        number: 71,
        url: 'https://github.com/Samsen879/ao-pilot/pull/71',
        head_sha: '3'.repeat(40),
        reviewed_head: '3'.repeat(40),
        ci_conclusion: 'success',
        codex_reviews: [{
          attempt: 1,
          kind: 'submitted_review',
          evidence_id: 101,
          request_comment_id: 99,
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
      orchestrator_done: true,
      orchestrator_done_evidence_comment_id: 89,
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
        number: P0_R08_RETRY_ADMISSION_PR,
        merged: true,
        merge_sha: receipt.source.clone_head_sha,
        base_ref: 'main',
      },
      retry_admission: {
        comment_id: P0_R08_RETRY_ADMISSION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-02T11:28:12.000Z',
        updated_at: '2026-08-02T11:28:12.000Z',
        body_sha256: P0_R08_RETRY_ADMISSION_COMMENT_SHA256,
      },
      principal_pr: {
        number: receipt.delivery.principal_pr.number,
        merged: true,
        merge_sha: receipt.delivery.principal_pr.merge_sha,
        head_sha: receipt.delivery.principal_pr.head_sha,
        head_ref: receipt.delivery.worker_branch,
        base_ref: 'main',
        created_at: '2026-08-02T12:00:00.000Z',
        merged_at: '2026-08-03T02:00:00.000Z',
        linked_issue_63: true,
      },
      issue_linked_prs: [{
        number: receipt.delivery.principal_pr.number,
        url: receipt.delivery.principal_pr.url,
        created_at: '2026-08-02T12:00:00.000Z',
        head_ref: receipt.delivery.worker_branch,
        base_ref: 'main',
      }],
      check_runs: ['fresh-clone-runtime', 'test (20)', 'test (22)'].map((name) => ({ name, conclusion: 'success' })),
      codex_reviews: receipt.delivery.principal_pr.codex_reviews.map((review) => ({
        kind: review.kind,
        evidence_id: review.evidence_id,
        request_comment_id: review.request_comment_id,
        request_valid: true,
        head_sha: review.head_sha,
        completed_at: review.completed_at,
        actor: 'chatgpt-codex-connector[bot]',
        completed: true,
      })),
      review_findings: [],
      worktree_capture: {
        comment_id: receipt.delivery.worktree_evidence_comment_id,
        issue_number: 63,
        author: 'Samsen879',
        created_at: '2026-08-03T01:46:00.000Z',
        updated_at: '2026-08-03T01:46:00.000Z',
        payload: {
          schema_version: 'ao.workstation-worktree-evidence.v2',
          issue_number: 63,
          captured_at: '2026-08-03T01:45:00.000Z',
          source: {
            clone_path: receipt.source.clone_path,
            head_sha: receipt.source.clone_head_sha,
            tree_sha: receipt.source.clone_tree_sha,
            git_common_dir: `${P0_R08_RETRY_ROOT}/ao-pilot/.git`,
          },
          isolation: {
            retry_root: receipt.environment.retry_root,
            ao_data_dir: receipt.environment.ao_data_dir,
            ao_run_file: receipt.environment.ao_run_file,
            runtime_store: receipt.environment.runtime_store,
            runtime_cache: receipt.environment.runtime_cache,
          },
          worker: {
            session_id: receipt.delivery.worker_session_id,
            worktree_path: receipt.delivery.worker_worktree_path,
            branch: receipt.delivery.worker_branch,
            head_sha: receipt.delivery.principal_pr.head_sha,
            git_common_dir: `${P0_R08_RETRY_ROOT}/ao-pilot/.git`,
          },
        },
      },
      orchestrator_done_capture: {
        comment_id: receipt.cleanup.orchestrator_done_evidence_comment_id,
        issue_number: 63,
        author: 'Samsen879',
        created_at: '2026-08-03T02:06:00.000Z',
        updated_at: '2026-08-03T02:06:00.000Z',
        payload: {
          schema_version: ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION,
          issue_number: 63,
          completed_at: '2026-08-03T02:05:00.000Z',
          orchestrator_session_id: receipt.delivery.orchestrator_session_id,
          command: {
            runtime_binary_path: receipt.runtime.binary_path,
            args: ['orchestrator', 'done', '--session', receipt.delivery.orchestrator_session_id],
            exit_code: 0,
            stdout: `Orchestrator ${receipt.delivery.orchestrator_session_id} marked done.`,
          },
        },
      },
    },
    publicationEvidence: {
      issue_number: 63,
      author: 'Samsen879',
      created_at: '2026-08-03T02:10:00.000Z',
      exact_bytes_match: true,
    },
  };
}

describe('fresh-clone and protected self-hosting gates', () => {
  it('pins the retry receipt template to PR #70 and the owner admission comment', () => {
    const template = JSON.parse(fs.readFileSync(
      'docs/runtime-portability/p0-r08-workstation-self-hosting-receipt.template.json',
      'utf8',
    ));
    expect(template).toMatchObject({
      schema_version: SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
      source: {
        admission_pr_number: P0_R08_RETRY_ADMISSION_PR,
        clone_head_sha: P0_R08_RETRY_ADMITTED_MAIN,
        clone_tree_sha: P0_R08_RETRY_ADMITTED_TREE,
      },
      retry_admission: {
        issue_number: 63,
        comment_id: P0_R08_RETRY_ADMISSION_COMMENT,
        comment_body_sha256: P0_R08_RETRY_ADMISSION_COMMENT_SHA256,
        historical_pr_number: P0_R08_RETRY_ADMISSION_PR,
        historical_merge_sha: P0_R08_RETRY_ADMITTED_MAIN,
        historical_tree_sha: P0_R08_RETRY_ADMITTED_TREE,
      },
      environment: {
        retry_root: P0_R08_RETRY_ROOT,
        ao_data_dir: P0_R08_RETRY_AO_DATA_DIR,
        ao_run_file: P0_R08_RETRY_AO_RUN_FILE,
        runtime_store: P0_R08_RETRY_RUNTIME_STORE,
        runtime_cache: P0_R08_RETRY_RUNTIME_CACHE,
      },
    });
  });

  it('routes pre-merge worktree capture through the Worker package', () => {
    const handoff = fs.readFileSync(
      'docs/runtime-portability/P0-R08_NEW_WORKSTATION_HANDOFF.md',
      'utf8',
    );
    expect(handoff).toContain('BOOTSTRAP_CLONE_ROOT="$(pwd -P)"');
    expect(handoff).toContain("WORKER_WORKTREE_ROOT='<WORKER-WORKTREE-ABSOLUTE-PATH>'");
    expect(handoff).toContain('npm --prefix "$WORKER_WORKTREE_ROOT" run capture:self-hosting-worktree');
    expect(handoff).toContain('--source-root "$BOOTSTRAP_CLONE_ROOT"');
    expect(handoff).toContain('Do not use `ao review trigger`');
    expect(handoff).toContain('comment `5157524210`');
    expect(handoff).toContain('invoke `orchestrator done`');
    expect(handoff).toContain('npm run capture:orchestrator-done');
    expect(handoff).not.toContain('npm run capture:self-hosting-worktree --');

    const bootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-bootstrap-routing-'));
    try {
      const output = execFileSync('npm', [
        '--prefix', process.cwd(),
        'run', 'capture:self-hosting-worktree',
        '--', '--help',
      ], {
        cwd: bootstrapRoot,
        encoding: 'utf8',
      });
      expect(output).toContain('Usage: npm run capture:self-hosting-worktree');
    } finally {
      removeTemporaryRoot(bootstrapRoot);
    }
  });

  it('captures durable Orchestrator completion through the pinned binary', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-done-evidence-'));
    const runtimeBinary = path.join(root, 'ao');
    fs.writeFileSync(runtimeBinary, 'fixture\n');
    let invocation = null;
    try {
      const evidence = captureOrchestratorDoneEvidence({
        runtimeBinary,
        orchestratorSessionId: 'or-r08',
        completedAt: '2026-08-03T02:05:00.000Z',
        execute(binary, args) {
          invocation = { binary, args };
          return 'Orchestrator or-r08 marked done.\n';
        },
      });
      expect(invocation).toEqual({
        binary: fs.realpathSync(runtimeBinary),
        args: ['orchestrator', 'done', '--session', 'or-r08'],
      });
      expect(evidence).toMatchObject({
        schema_version: ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION,
        orchestrator_session_id: 'or-r08',
        command: { exit_code: 0 },
      });
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('rejects an Orchestrator done command without the exact success confirmation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-done-failure-'));
    const runtimeBinary = path.join(root, 'ao');
    fs.writeFileSync(runtimeBinary, 'fixture\n');
    try {
      expect(() => captureOrchestratorDoneEvidence({
        runtimeBinary,
        orchestratorSessionId: 'or-r08',
        execute: () => 'Orchestrator still active.\n',
      })).toThrow('did not confirm durable Orchestrator completion');
    } finally {
      removeTemporaryRoot(root);
    }
  });

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
      principal_pr: 71,
      retry_admission_comment: P0_R08_RETRY_ADMISSION_COMMENT,
      review_count: 1,
    });
  });

  it('supports the handoff pre-publication verification stage', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    delete evidence.publicationEvidence;
    expect(verifySelfHostingReceipt(receipt, {
      ...evidence,
      requirePublication: false,
    })).toMatchObject({
      status: 'prepublication_verified',
      admitted_main: P0_R08_RETRY_ADMITTED_MAIN,
    });
  });

  it('captures the actual independent Git worktree binding before cleanup', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-worktree-evidence-'));
    const sourceRoot = path.join(root, 'source');
    const workerRoot = path.join(root, 'worker');
    try {
      fs.mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.name', 'AO Test'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.email', 'ao-test@example.invalid'], { cwd: sourceRoot });
      fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'worktree evidence fixture\n');
      execFileSync('git', ['add', 'fixture.txt'], { cwd: sourceRoot });
      execFileSync('git', ['commit', '--quiet', '-m', 'test: seed worktree evidence'], { cwd: sourceRoot });
      const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
      const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
      execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'ao/p0-r08/evidence-test', workerRoot], { cwd: sourceRoot });
      const evidence = inspectWorktreeBinding({
        sourceRoot,
        workerRoot,
        workerSessionId: 'worker-r08',
        capturedAt: '2026-08-03T01:45:00.000Z',
      });
      expect(evidence).toMatchObject({
        schema_version: 'ao.workstation-worktree-evidence.v2',
        source: {
          clone_path: fs.realpathSync(sourceRoot),
          head_sha: sourceHead,
          tree_sha: sourceTree,
        },
        worker: {
          session_id: 'worker-r08',
          worktree_path: fs.realpathSync(workerRoot),
          branch: 'ao/p0-r08/evidence-test',
          head_sha: sourceHead,
        },
      });
      expect(evidence.worker.git_common_dir).toBe(evidence.source.git_common_dir);
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it.each([
    ['manual worker substitution', (receipt) => { receipt.delivery.worker_created_by_new_ao = false; }],
    ['copied credential state', (receipt) => { receipt.environment.credentials_copied = true; }],
    ['runtime drift', (receipt) => { receipt.runtime.commit_sha = 'f'.repeat(40); }],
    ['wrong admitted main', (receipt) => { receipt.source.clone_head_sha = 'f'.repeat(40); }],
    ['wrong historical PR', (receipt) => { receipt.retry_admission.historical_pr_number = 69; }],
    ['wrong retry-admission comment', (receipt) => { receipt.retry_admission.comment_id = 5157524604; }],
    ['wrong retry-admission digest', (receipt) => { receipt.retry_admission.comment_body_sha256 = 'f'.repeat(64); }],
    ['shared Orchestrator and Worker session', (receipt) => { receipt.delivery.worker_session_id = receipt.delivery.orchestrator_session_id; }],
    ['missing exact-head review', (receipt) => { receipt.delivery.principal_pr.codex_reviews[0].head_sha = 'e'.repeat(40); }],
    ['failed cleanup', (receipt) => { receipt.cleanup.worker_worktree_removed = false; }],
  ])('fails closed for %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    mutate(receipt);
    expect(() => verifySelfHostingReceipt(receipt, validEvidence(receipt))).toThrow();
  });

  it('rejects receipt-controlled paths that disagree with pre-cleanup Git evidence', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    receipt.delivery.worker_worktree_path = `${P0_R08_RETRY_AO_DATA_DIR}/worktrees/ao-pilot/different-worktree`;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('captured Git evidence');
  });

  it('rejects a receipt-controlled source path that disagrees with pre-cleanup Git evidence', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    receipt.source.clone_path = `${P0_R08_RETRY_ROOT}/fabricated-bootstrap-clone`;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('admitted retry clone');
  });

  it('rejects captured evidence that reuses the bootstrap worktree', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.worktree_capture.payload.worker.worktree_path = receipt.source.clone_path;
    receipt.delivery.worker_worktree_path = receipt.source.clone_path;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('outside retry-specific AO_DATA_DIR');
  });

  it('rejects fabricated or incomplete Codex Review evidence', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.codex_reviews[0].completed = false;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('not completed');
  });

  it.each([
    ['missing owner exact-head request', (_receipt, evidence) => { evidence.githubEvidence.codex_reviews[0].request_valid = false; }],
    ['mismatched request comment', (receipt) => { receipt.delivery.principal_pr.codex_reviews[0].request_comment_id = 98; }],
  ])('rejects a submitted connector review with %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
  });

  it('preserves generic connector review objects as non-attempt audit evidence', () => {
    const head = '3'.repeat(40);
    const requests = ownerExactHeadReviewRequests([{
      id: 99,
      user: { login: 'Samsen879' },
      author_association: 'OWNER',
      body: `@codex review\n\nTarget HEAD: ${head}`,
      created_at: '2026-08-03T00:00:00.000Z',
      updated_at: '2026-08-03T00:00:00.000Z',
    }]);
    const evidence = submittedCodexReviewEvidence([{
      id: 101,
      user: { login: 'chatgpt-codex-connector[bot]' },
      body: '### Codex Review\n\nFindings follow.',
      commit_id: head,
      submitted_at: '2026-08-03T00:01:00.000Z',
      state: 'COMMENTED',
    }, {
      id: 102,
      user: { login: 'chatgpt-codex-connector[bot]' },
      body: '',
      commit_id: head,
      submitted_at: '2026-08-03T00:02:00.000Z',
      state: 'COMMENTED',
    }], requests);

    expect(evidence).toEqual([
      expect.objectContaining({ evidence_id: 101, request_valid: true, formal_review: true, completed: true }),
      expect.objectContaining({ evidence_id: 102, request_valid: true, formal_review: false, completed: false }),
    ]);
  });

  it('does not count a request, connector setup/error comment, or generic bot comment as review evidence', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.codex_reviews = [];
    evidence.githubEvidence.generic_comments = [
      { id: 5157524604, actor: 'chatgpt-codex-connector', body: 'connector setup required' },
      { id: 5157524605, actor: 'chatgpt-codex-connector[bot]', body: 'review request failed' },
      { id: 5157524606, actor: 'Samsen879', body: `@codex review ${receipt.delivery.principal_pr.head_sha}` },
    ];
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('no live completion evidence');
  });

  it('accepts only an exact-head connector +1 as clean-reaction evidence', () => {
    const receipt = validSelfHostingReceipt();
    receipt.delivery.principal_pr.codex_reviews[0].kind = 'clean_reaction';
    const evidence = validEvidence(receipt);
    expect(verifySelfHostingReceipt(receipt, evidence)).toMatchObject({ review_count: 1 });

    evidence.githubEvidence.codex_reviews[0].head_sha = 'f'.repeat(40);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('head mismatch');
  });

  it.each([
    ['non-owner authorization', (evidence) => { evidence.githubEvidence.retry_admission.author_association = 'NONE'; }],
    ['edited authorization', (evidence) => { evidence.githubEvidence.retry_admission.updated_at = '2026-08-02T11:29:00.000Z'; }],
    ['authorization body drift', (evidence) => { evidence.githubEvidence.retry_admission.body_sha256 = 'f'.repeat(64); }],
    ['pre-admission retry PR', (evidence) => { evidence.githubEvidence.principal_pr.created_at = '2026-08-02T11:00:00.000Z'; }],
    ['pre-admission worktree capture', (evidence) => { evidence.githubEvidence.worktree_capture.payload.captured_at = '2026-08-02T11:00:00.000Z'; }],
  ])('rejects %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
  });

  it.each([
    ['AO_DATA_DIR drift', (receipt) => { receipt.environment.ao_data_dir = '/failed-attempt/.ao'; }],
    ['AO_RUN_FILE drift', (receipt) => { receipt.environment.ao_run_file = `${P0_R08_RETRY_ROOT}/ao-state/../failed.run`; }],
    ['runtime store drift', (receipt) => { receipt.environment.runtime_store = `${P0_R08_RETRY_ROOT}/failed-runtime-store`; }],
    ['runtime cache drift', (receipt) => { receipt.environment.runtime_cache = `${P0_R08_RETRY_ROOT}/failed-runtime-cache`; }],
    ['runtime binary escape', (receipt) => { receipt.runtime.binary_path = '/failed-attempt/bin/ao'; }],
    ['Worker worktree escape', (receipt) => { receipt.delivery.worker_worktree_path = '/failed-attempt/worktree'; }],
  ])('rejects retry isolation failure: %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    mutate(receipt);
    expect(() => verifySelfHostingReceipt(receipt, validEvidence(receipt))).toThrow();
  });

  it('rejects captured Worker environment paths that disagree with the receipt', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.worktree_capture.payload.isolation.ao_data_dir = '/failed-attempt/.ao';
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('Captured AO_DATA_DIR');
  });

  it('rejects multiple post-admission issue-linked retry PRs', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.issue_linked_prs.push({
      number: 72,
      url: 'https://github.com/Samsen879/ao-pilot/pull/72',
      created_at: '2026-08-02T12:30:00.000Z',
      head_ref: 'ao/p0-r08-extra-retry',
      base_ref: 'main',
    });
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('exactly one post-admission retry principal PR');
  });

  it.each([
    ['missing done claim', (receipt) => { receipt.cleanup.orchestrator_done = false; }],
    ['wrong done comment', (receipt) => { receipt.cleanup.orchestrator_done_evidence_comment_id = 90; }],
    ['wrong done session', (_receipt, evidence) => { evidence.githubEvidence.orchestrator_done_capture.payload.orchestrator_session_id = 'other-or'; }],
    ['failed done command', (_receipt, evidence) => { evidence.githubEvidence.orchestrator_done_capture.payload.command.exit_code = 1; }],
    ['pre-merge done command', (_receipt, evidence) => { evidence.githubEvidence.orchestrator_done_capture.payload.completed_at = '2026-08-03T01:59:00.000Z'; }],
  ])('rejects durable Orchestrator completion failure: %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
  });

  it('rejects historical failed PR #70 as the retry principal', () => {
    const receipt = validSelfHostingReceipt();
    receipt.delivery.principal_pr.number = 70;
    receipt.delivery.principal_pr.url = 'https://github.com/Samsen879/ao-pilot/pull/70';
    const evidence = validEvidence(receipt);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('cannot serve as the retry principal PR');
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
      request_comment_id: 199,
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
