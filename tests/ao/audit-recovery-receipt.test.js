import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import {
  AUDIT_RECOVERY_ADMISSION_BYTES,
  AUDIT_RECOVERY_ADMISSION_COMMENT,
  AUDIT_RECOVERY_ADMISSION_SHA256,
  AUDIT_RECOVERY_ADMITTED_MAIN,
  AUDIT_RECOVERY_ADMITTED_TREE,
  AUDIT_RECOVERY_PREDECESSOR_HEAD,
  AUDIT_RECOVERY_RECEIPT_BYTES,
  AUDIT_RECOVERY_RECEIPT_COMMENT,
  AUDIT_RECOVERY_RECEIPT_SCHEMA_VERSION,
  AUDIT_RECOVERY_RECEIPT_SHA256,
  verifyAuditPostReview2Repair,
  verifyAuditRecoveryReceipt,
} from '../../scripts/ao/lib/audit-recovery-receipt.js';
import {
  P0_R08_RUNTIME_COMMIT,
  P0_R08_RUNTIME_REF,
  P0_R08_RUNTIME_TREE,
  P0_R08_RUNTIME_X64_SHA256,
  P0_R08_TERMINAL_RUNTIME_BINARY,
  REQUIRED_CI_CHECKS,
} from '../../scripts/ao/lib/self-hosting-receipt.js';
import {
  AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  createPremergeVerificationEvidence,
  validateAuditPremergeVerificationEvidence,
} from '../../scripts/ao/lib/premerge-verification-evidence.js';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const TREE = 'c'.repeat(40);
const REVIEW_ID = 6001;
const REQUEST_ID = 6000;
const WORKTREE_COMMENT = 6002;
const PREFLIGHT_COMMENT = 6003;
const MERGE_COMMENT = 6004;
const DONE_COMMENT = 6005;
const CLEANUP_COMMENT = 6006;

function processBinding() {
  return {
    supervisor_pid: 4242,
    supervisor_process_start_token: '987654',
    supervisor_executable_path: P0_R08_TERMINAL_RUNTIME_BINARY,
    supervisor_executable_sha256: P0_R08_RUNTIME_X64_SHA256,
    supervisor_command_sha256: 'd'.repeat(64),
    session_id: 'ao-pilot-remediation-5',
    runtime_launch_id: 'launch-audit',
    current_process_is_descendant: true,
  };
}

function publication(commentId, createdAt, bytes, digest) {
  return {
    schema_version: 'ao.workstation-orchestrator-worktree-publication.v2', issue_number: 63, comment_id: commentId,
    published_at: createdAt, read_back_at: createdAt, payload_bytes: bytes,
    payload_sha256: digest, exact_body_read_back: true,
    orchestrator_session_id: 'ao-pilot-remediation-5',
    runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
    runtime_binary_sha256: P0_R08_RUNTIME_X64_SHA256,
    process_binding: processBinding(),
  };
}

function receipt() {
  return {
    schema_version: AUDIT_RECOVERY_RECEIPT_SCHEMA_VERSION,
    status: 'passed',
    performed_at: '2026-08-04T04:00:00Z',
    predecessor: {
      receipt: {
        comment_id: AUDIT_RECOVERY_RECEIPT_COMMENT,
        body_bytes: AUDIT_RECOVERY_RECEIPT_BYTES,
        body_sha256: AUDIT_RECOVERY_RECEIPT_SHA256,
        created_at: '2026-08-03T17:15:46Z', updated_at: '2026-08-03T17:15:46Z',
      },
      pr: { number: 74, head_sha: AUDIT_RECOVERY_PREDECESSOR_HEAD, merge_sha: AUDIT_RECOVERY_ADMITTED_MAIN, merge_tree_sha: AUDIT_RECOVERY_ADMITTED_TREE },
      protected_workflow: {
        run_id: 30836059504, workflow_id: 325479877, event: 'workflow_dispatch',
        head_sha: AUDIT_RECOVERY_ADMITTED_MAIN, status: 'completed', conclusion: 'failure',
        run_attempt: 2, created_at: '2026-08-03T17:17:16Z', updated_at: '2026-08-03T17:21:27Z',
        attempt_jobs: [91761405074, 91762073346],
        failure: {
          failed_step: 'verify:self-hosting/npm run release:check/npm audit',
          audit_advisory: 'GHSA-rgw5-rvv9-x895', package: 'brace-expansion',
          affected_range: '>=4.0.0 <5.0.9', observed_version: '5.0.8', patched_version: '5.0.9',
          high_vulnerability_count: 1, fix_available: true,
        },
      },
    },
    audit_recovery: {
      admission: {
        comment_id: AUDIT_RECOVERY_ADMISSION_COMMENT,
        body_bytes: AUDIT_RECOVERY_ADMISSION_BYTES,
        body_sha256: AUDIT_RECOVERY_ADMISSION_SHA256,
        created_at: '2026-08-04T00:52:17Z', updated_at: '2026-08-04T00:52:17Z',
      },
      source: { repository: 'https://github.com/Samsen879/ao-pilot.git', head_sha: AUDIT_RECOVERY_ADMITTED_MAIN, tree_sha: AUDIT_RECOVERY_ADMITTED_TREE },
      runtime: { runtime_ref: P0_R08_RUNTIME_REF, commit_sha: P0_R08_RUNTIME_COMMIT, tree_sha: P0_R08_RUNTIME_TREE, binary_sha256: P0_R08_RUNTIME_X64_SHA256 },
      delivery: {
        orchestrator_session_id: 'ao-pilot-remediation-5', worker_session_id: 'ao-pilot-remediation-6',
        worker_created_by_ao: true, worker_created_from_issue: true,
        worker_worktree_path: '/home/guoqy/p0-r08-terminal-remediation/ao-state/data/worktrees/ao-pilot-remediation/ao-pilot-remediation-6',
        worker_branch: 'ao/p0-r08-audit-recovery', worktree_evidence_comment_id: WORKTREE_COMMENT,
        worktree_evidence_publication: publication(WORKTREE_COMMENT, '2026-08-04T01:10:00Z', 1000, 'e'.repeat(64)),
        pr: {
          number: 75, url: 'https://github.com/Samsen879/ao-pilot/pull/75',
          head_sha: HEAD, reviewed_head: HEAD, ci_conclusion: 'success',
          codex_reviews: [{ attempt: 1, kind: 'submitted_review', evidence_id: REVIEW_ID, request_comment_id: REQUEST_ID, head_sha: HEAD, completed_at: '2026-08-04T02:00:00Z' }],
          finding_dispositions: [], post_review_2_repair: null, merged: true,
          merge_sha: MERGE, merge_tree_sha: TREE,
        },
      },
      premerge_verification: { evidence_comment_id: PREFLIGHT_COMMENT, publication: publication(PREFLIGHT_COMMENT, '2026-08-04T02:10:00Z', 1100, 'f'.repeat(64)) },
      merge_execution: { evidence_comment_id: MERGE_COMMENT, publication: publication(MERGE_COMMENT, '2026-08-04T02:21:00Z', 1200, '1'.repeat(64)) },
      exact_main_replay: { passed: true, release_check_passed: true, audit_passed: true, main_sha: MERGE, tree_sha: TREE },
      cleanup: {
        orchestrator_done: true, orchestrator_done_evidence_comment_id: DONE_COMMENT, cleanup_evidence_comment_id: CLEANUP_COMMENT,
        orchestrator_session_stopped: true, worker_session_stopped: true, worker_worktree_removed: true,
        remote_worker_branch_removed: true, project_removed: true, daemon_stopped: true,
        leases_absent: true, stale_ownership_absent: true,
      },
    },
    claim: { workstation_self_hosting: true, p0_r08_satisfied: true },
  };
}

function comment(commentId, createdAt, bytes, digest, payload = null) {
  return { comment_id: commentId, issue_number: 63, author: 'Samsen879', author_association: 'OWNER', created_at: createdAt, updated_at: createdAt, body_bytes: bytes, body_sha256: digest, payload };
}

function evidence(value) {
  const provenance = {
    schema_version: 'ao.workstation-orchestrator-worktree-provenance.v2',
    session_id: 'ao-pilot-remediation-5', worker_session_id: 'ao-pilot-remediation-6',
    project_id: 'ao-pilot-remediation', issue_number: 63, kind: 'orchestrator',
    activity_state: 'active', is_terminated: false, runtime_launch_id: 'launch-audit',
    runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY, runtime_binary_sha256: P0_R08_RUNTIME_X64_SHA256,
    process_binding: processBinding(), session_get: {}, operation: {},
  };
  const priorPayload = {
    schema_version: 'ao.workstation-self-hosting-receipt.v7', status: 'passed',
    terminal_remediation: { delivery: { remediation_pr: { number: 74, head_sha: AUDIT_RECOVERY_PREDECESSOR_HEAD, merge_sha: AUDIT_RECOVERY_ADMITTED_MAIN, merge_tree_sha: AUDIT_RECOVERY_ADMITTED_TREE } } },
  };
  const failedJob = (runAttempt, id) => ({
    run_attempt: runAttempt, id, name: 'verify-self-hosting-receipt', conclusion: 'failure', head_sha: AUDIT_RECOVERY_ADMITTED_MAIN,
    steps: [
      { name: 'Run npm ci', conclusion: 'success', number: 4 },
      { name: 'Materialize bounded workstation receipt', conclusion: 'success', number: 5 },
      { name: 'Run npm run verify:self-hosting -- --receipt fixture', conclusion: 'failure', number: 6 },
    ],
  });
  const cleanupPayload = {
    schema_version: 'ao.workstation-audit-recovery-cleanup.v1', issue_number: 63, pr_number: 75,
    orchestrator_session_stopped: true, worker_session_stopped: true, worker_worktree_removed: true,
    remote_worker_branch_removed: true, project_removed: true, daemon_stopped: true,
    leases_absent: true, stale_ownership_absent: true,
  };
  return {
    repositoryEvidence: {
      current_commit_sha: MERGE, current_tree_sha: TREE,
      source_commit_sha: AUDIT_RECOVERY_ADMITTED_MAIN, source_tree_sha: AUDIT_RECOVERY_ADMITTED_TREE,
      source_is_ancestor: true, merge_base_sha: AUDIT_RECOVERY_ADMITTED_MAIN,
      reviewed_head_is_ancestor: true, reviewed_head_merge_base_sha: HEAD,
      release_check_passed: true, brace_expansion_override: '5.0.9',
      brace_expansion_lock_version: '5.0.9',
      brace_expansion_lock_integrity: 'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==',
      audit_vulnerability_total: 0,
    },
    githubEvidence: {
      issue_63: { number: 63, state: 'open' },
      predecessor_receipt: comment(AUDIT_RECOVERY_RECEIPT_COMMENT, '2026-08-03T17:15:46Z', AUDIT_RECOVERY_RECEIPT_BYTES, AUDIT_RECOVERY_RECEIPT_SHA256, priorPayload),
      predecessor_pr: { number: 74, merged: true, head_sha: AUDIT_RECOVERY_PREDECESSOR_HEAD, merge_sha: AUDIT_RECOVERY_ADMITTED_MAIN, merge_tree_sha: AUDIT_RECOVERY_ADMITTED_TREE },
      failed_protected_run: { id: 30836059504, workflow_id: 325479877, event: 'workflow_dispatch', head_sha: AUDIT_RECOVERY_ADMITTED_MAIN, status: 'completed', conclusion: 'failure', run_attempt: 2, created_at: '2026-08-03T17:17:16Z', updated_at: '2026-08-03T17:21:27Z' },
      failed_protected_jobs: [failedJob(2, 91762073346), failedJob(1, 91761405074)],
      failed_protected_audit_evidence: {
        job_id: 91762073346, run_attempt: 2, log_bytes: 10000, log_sha256: '4'.repeat(64),
        npm_ci_high_vulnerability_count: 1, audit_advisory: 'GHSA-rgw5-rvv9-x895', package: 'brace-expansion',
        affected_range: '>=4.0.0 <5.0.9', observed_version: '5.0.8', patched_version: '5.0.9',
        fix_available: true, evidence_source: 'immutable_job_log_plus_exact_head_lock_audit',
      },
      audit_recovery_admission: comment(AUDIT_RECOVERY_ADMISSION_COMMENT, '2026-08-04T00:52:17Z', AUDIT_RECOVERY_ADMISSION_BYTES, AUDIT_RECOVERY_ADMISSION_SHA256),
      audit_recovery_pr: {
        number: 75, base_ref: 'main', head_ref: 'ao/p0-r08-audit-recovery', head_sha: HEAD,
        created_at: '2026-08-04T01:00:00Z', merged: true, merged_at: '2026-08-04T02:20:00Z',
        merge_sha: MERGE, merge_tree_sha: TREE, linked_issue_63: true, auto_closes_issue_63: false,
        binds_audit_admission: true, binds_predecessor_receipt: true, binds_failed_workflow: true, binds_predecessor_pr_74: true,
      },
      issue_linked_prs: [{ repository: 'Samsen879/ao-pilot', number: 75, created_at: '2026-08-04T01:00:00Z' }],
      audit_check_runs: REQUIRED_CI_CHECKS.map((name) => ({ name, conclusion: 'success' })),
      audit_codex_reviews: [{ kind: 'submitted_review', evidence_id: REVIEW_ID, request_comment_id: REQUEST_ID, request_valid: true, head_sha: HEAD, completed_at: '2026-08-04T02:00:00Z', actor: 'chatgpt-codex-connector[bot]', completed: true }],
      audit_codex_review_requests: [{ comment_id: REQUEST_ID, head_sha: HEAD, requested_at: '2026-08-04T01:59:00Z' }],
      audit_review_findings: [],
      audit_worktree_capture: comment(WORKTREE_COMMENT, '2026-08-04T01:10:00Z', 1000, 'e'.repeat(64), { schema_version: 'ao.workstation-worktree-evidence.v7', source: { head_sha: AUDIT_RECOVERY_ADMITTED_MAIN, tree_sha: AUDIT_RECOVERY_ADMITTED_TREE }, worker: { session_id: 'ao-pilot-remediation-6', worktree_path: '/home/guoqy/p0-r08-terminal-remediation/ao-state/data/worktrees/ao-pilot-remediation/ao-pilot-remediation-6', branch: 'ao/p0-r08-audit-recovery', head_sha: HEAD }, git_relationship: { branch_creation_at: '2026-08-04T00:54:25Z' }, recovery_chain: { attempt: 4, standing_admission_comment_id: AUDIT_RECOVERY_ADMISSION_COMMENT, prior_attempt_pr_number: 74, admitted_main_sha: AUDIT_RECOVERY_ADMITTED_MAIN, admitted_tree_sha: AUDIT_RECOVERY_ADMITTED_TREE }, orchestrator_provenance: provenance }),
      audit_premerge_capture: comment(PREFLIGHT_COMMENT, '2026-08-04T02:10:00Z', 1100, 'f'.repeat(64), { schema_version: 'ao.workstation-premerge-verification-evidence.v3', status: 'premerge_verified', recovery_attempt: 4, standing_admission_comment_id: AUDIT_RECOVERY_ADMISSION_COMMENT, remediation_pr: { number: 75, head_sha: HEAD, review_evidence_ids: [REVIEW_ID], resolved_finding_comment_ids: [] }, release_check: { passed: true, checkout_head_sha: HEAD, checkout_tree_sha: TREE }, orchestrator_provenance: provenance }),
      audit_merge_capture: comment(MERGE_COMMENT, '2026-08-04T02:21:00Z', 1200, '1'.repeat(64), {
        schema_version: 'ao.workstation-terminal-merge-evidence.v2', issue_number: 63,
        completed_at: '2026-08-04T02:20:30Z', orchestrator_session_id: 'ao-pilot-remediation-5', recovery_attempt: 4,
        premerge_evidence: { comment_id: PREFLIGHT_COMMENT, payload_sha256: 'f'.repeat(64) },
        command: { runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY, runtime_binary_sha256: P0_R08_RUNTIME_X64_SHA256, args: ['pr', 'merge', '75'], exit_code: 0, stdout: `merged PR #75 using squash (head ${HEAD}, merge commit ${MERGE})` },
        effect: { provider_mutation: 'github_squash_merge', exact_head_guarded: true, ao_merge_executed: true, github_readback_confirmed: true, pr_number: 75, method: 'squash', head_sha: HEAD, merge_commit_sha: MERGE, main_sha: MERGE, main_tree_sha: TREE },
        execution_binding: {
          schema_version: 'ao.workstation-terminal-merge-operation.v1', helper: 'publish:self-hosting-merge',
          helper_source_sha256: createHash('sha256').update(fs.readFileSync('scripts/ao/lib/terminal-merge-publication.js')).digest('hex'),
          guarded_head_sha: HEAD, premerge_payload_sha256: 'f'.repeat(64),
          subprocess_stdout_sha256: createHash('sha256').update(`merged PR #75 using squash (head ${HEAD}, merge commit ${MERGE})`).digest('hex'),
          premerge_read_back_at: '2026-08-04T02:10:30Z', subprocess_started_at: '2026-08-04T02:19:00Z', subprocess_completed_at: '2026-08-04T02:20:00Z', github_read_back_at: '2026-08-04T02:20:30Z', process_binding: processBinding(),
        },
        orchestrator_provenance: provenance,
      }),
      audit_orchestrator_done_capture: comment(DONE_COMMENT, '2026-08-04T02:30:00Z', 500, '2'.repeat(64), { schema_version: 'ao.orchestrator-done-evidence.v1', issue_number: 63, completed_at: '2026-08-04T02:29:00Z', orchestrator_session_id: 'ao-pilot-remediation-5', command: { runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY, args: ['orchestrator', 'done', '--session', 'ao-pilot-remediation-5'], exit_code: 0, stdout: 'Orchestrator ao-pilot-remediation-5 marked done.' } }),
      audit_cleanup_capture: comment(CLEANUP_COMMENT, '2026-08-04T02:40:00Z', 600, '3'.repeat(64), cleanupPayload),
    },
    publicationEvidence: { issue_number: 63, author: 'Samsen879', created_at: '2026-08-04T04:00:00Z', exact_bytes_match: true },
  };
}

describe('P0-R08 audit-only recovery receipt', () => {
  it('binds the failed protected predecessor and verifies the final PR #75 lifecycle', () => {
    const value = receipt();
    expect(verifyAuditRecoveryReceipt(value, evidence(value))).toMatchObject({ status: 'verified', audit_recovery_pr: 75 });
  });

  it('sorts protected workflow jobs by run attempt', () => {
    const value = receipt();
    expect(verifyAuditRecoveryReceipt(value, evidence(value))).toMatchObject({ status: 'verified' });
  });

  it('supports exact-head pre-merge verification without post-merge claims', () => {
    const value = receipt();
    value.status = 'pending';
    value.audit_recovery.delivery.pr.merged = false;
    value.audit_recovery.delivery.pr.merge_sha = null;
    value.audit_recovery.delivery.pr.merge_tree_sha = null;
    value.audit_recovery.premerge_verification = null;
    value.audit_recovery.merge_execution = null;
    value.audit_recovery.exact_main_replay = { passed: false, release_check_passed: false, audit_passed: false, main_sha: null, tree_sha: null };
    value.audit_recovery.cleanup = {
      orchestrator_done: false, orchestrator_done_evidence_comment_id: 0, cleanup_evidence_comment_id: 0,
      orchestrator_session_stopped: false, worker_session_stopped: false, worker_worktree_removed: false,
      remote_worker_branch_removed: false, project_removed: false, daemon_stopped: false,
      leases_absent: false, stale_ownership_absent: false,
    };
    value.claim = { workstation_self_hosting: false, p0_r08_satisfied: false };
    const observed = evidence(value);
    observed.repositoryEvidence.current_commit_sha = HEAD;
    observed.repositoryEvidence.current_tree_sha = '9'.repeat(40);
    observed.githubEvidence.audit_recovery_pr.merged = false;
    observed.githubEvidence.audit_recovery_pr.merged_at = null;
    observed.githubEvidence.audit_recovery_pr.merge_sha = null;
    observed.githubEvidence.audit_recovery_pr.merge_tree_sha = null;
    delete observed.publicationEvidence;
    expect(verifyAuditRecoveryReceipt(value, { ...observed, requirePublication: false, stage: 'pre_merge' })).toMatchObject({
      status: 'premerge_verified', audit_recovery_pr: 75,
    });
    const prematureClaim = structuredClone(value);
    prematureClaim.claim.workstation_self_hosting = true;
    expect(() => verifyAuditRecoveryReceipt(prematureClaim, { ...observed, requirePublication: false, stage: 'pre_merge' })).toThrow('claim.workstation_self_hosting');
    const result = verifyAuditRecoveryReceipt(value, { ...observed, requirePublication: false, stage: 'pre_merge' });
    const artifact = createPremergeVerificationEvidence({ receipt: value, result, evidence: observed, verifiedAt: '2026-08-04T02:05:00Z' });
    expect(artifact).toMatchObject({
      schema_version: AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      standing_admission_comment_id: AUDIT_RECOVERY_ADMISSION_COMMENT,
      final_admission_comment_id: AUDIT_RECOVERY_ADMISSION_COMMENT,
      recovery_attempt: 4,
      remediation_pr: { number: 75, head_sha: HEAD },
    });
    const authority = {
      worker: { head_sha: HEAD, tree_sha: observed.repositoryEvidence.current_tree_sha },
      orchestrator_provenance: observed.githubEvidence.audit_worktree_capture.payload.orchestrator_provenance,
    };
    const authenticated = {
      status: 'premerge_verified', head_sha: HEAD, tree_sha: observed.repositoryEvidence.current_tree_sha,
      review_evidence_ids: [REVIEW_ID], resolved_finding_comment_ids: [], all_finding_comment_ids: [],
      required_ci_green: true, release_check_passed: true, source_is_ancestor: true,
    };
    expect(validateAuditPremergeVerificationEvidence(artifact, authority, authenticated)).toBe(artifact);
    const failedRelease = structuredClone(artifact);
    failedRelease.release_check.passed = false;
    expect(() => validateAuditPremergeVerificationEvidence(failedRelease, authority, authenticated)).toThrow('release check');
    const forgedReviews = structuredClone(authenticated);
    forgedReviews.review_evidence_ids = [999];
    expect(() => validateAuditPremergeVerificationEvidence(artifact, authority, forgedReviews)).toThrow('review IDs');
  });

  it('permits a post-Review-2 descendant only when it binds every resolved Review-2 finding', () => {
    const base = {
      repair: { authorization_ref: 'https://github.com/Samsen879/ao-pilot/issues/63#issuecomment-5173330402', review_id: 7002, final_head_sha: MERGE, finding_comment_ids: [12, 11] },
      finalHead: MERGE, reviewedHead: HEAD,
      completedReviews: [
        { kind: 'submitted_review', evidence_id: REVIEW_ID },
        { kind: 'submitted_review', evidence_id: 7002 },
      ],
      liveFindings: [
        { comment_id: 11, review_id: 7002, resolved: true },
        { comment_id: 12, review_id: 7002, resolved: true },
      ],
      repository: { reviewed_head_is_ancestor: true, reviewed_head_merge_base_sha: HEAD },
    };
    expect(() => verifyAuditPostReview2Repair(base)).not.toThrow();
    const missing = structuredClone(base);
    missing.repair.finding_comment_ids = [11];
    expect(() => verifyAuditPostReview2Repair(missing)).toThrow('every resolved Review 2 finding');
    const clean = structuredClone(base);
    clean.liveFindings = [];
    clean.repair.finding_comment_ids = [];
    expect(() => verifyAuditPostReview2Repair(clean)).toThrow('requires submitted Review 2 findings');
  });

  it.each([
    ['edited predecessor receipt', (_value, observed) => { observed.githubEvidence.predecessor_receipt.updated_at = '2026-08-03T17:16:00Z'; }],
    ['successful predecessor workflow rewrite', (value) => { value.predecessor.protected_workflow.conclusion = 'success'; }],
    ['predecessor audit reason absent from live log-bound evidence', (_value, observed) => { observed.githubEvidence.failed_protected_audit_evidence.audit_advisory = 'GHSA-other'; }],
    ['missing live connector finding disposition', (value, observed) => { observed.githubEvidence.audit_review_findings.push({ comment_id: 99, review_id: REVIEW_ID, resolved: true }); }],
    ['reviewed head not bound to final connector review', (value) => { value.audit_recovery.delivery.pr.reviewed_head = '8'.repeat(40); }],
    ['extra PR #76', (_value, observed) => { observed.githubEvidence.issue_linked_prs.push({ repository: 'Samsen879/ao-pilot', number: 76, created_at: '2026-08-04T01:01:00Z' }); }],
    ['worktree supervisor drift', (_value, observed) => { observed.githubEvidence.audit_worktree_capture.payload.orchestrator_provenance.process_binding.supervisor_process_start_token = 'other'; }],
    ['fabricated AO merge helper identity', (_value, observed) => { observed.githubEvidence.audit_merge_capture.payload.execution_binding.helper = 'owner-authored-json'; }],
    ['incomplete Orchestrator-done payload', (_value, observed) => { delete observed.githubEvidence.audit_orchestrator_done_capture.payload.command.stdout; }],
    ['Orchestrator-done comment published outside issue 63', (_value, observed) => { observed.githubEvidence.audit_orchestrator_done_capture.issue_number = 75; }],
    ['cleanup boolean without live evidence', (value) => { value.audit_recovery.cleanup.leases_absent = false; }],
  ])('fails closed for %s', (_name, mutate) => {
    const value = receipt();
    const observed = evidence(value);
    mutate(value, observed);
    expect(() => verifyAuditRecoveryReceipt(value, observed)).toThrow();
  });
});
