import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from '@jest/globals';

import {
  ownerExactHeadReviewRequests,
  submittedCodexReviewEvidence,
  cleanCodexReviewCommentEvidence,
  collectCodexReviewEvidence,
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
  P0_R08_PRINCIPAL_PR,
  P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT,
  P0_R08_FAILED_TERMINAL_DISPOSITION_SHA256,
  P0_R08_FAILED_TERMINAL_HEAD,
  P0_R08_FAILED_TERMINAL_PR,
  P0_R08_FAILED_MERGE_PATH_DISPOSITION_BYTES,
  P0_R08_FAILED_MERGE_PATH_DISPOSITION_COMMENT,
  P0_R08_FAILED_MERGE_PATH_DISPOSITION_SHA256,
  P0_R08_FAILED_MERGE_PATH_HEAD,
  P0_R08_FAILED_MERGE_PATH_PR,
  P0_R08_FAILED_MERGE_PATH_REVIEWED_HEAD,
  P0_R08_ARCHITECTURAL_BLOCKER_BYTES,
  P0_R08_ARCHITECTURAL_BLOCKER_COMMENT,
  P0_R08_ARCHITECTURAL_BLOCKER_SHA256,
  P0_R08_FINAL_ADMISSION_BYTES,
  P0_R08_FINAL_ADMISSION_COMMENT,
  P0_R08_FINAL_ADMISSION_SHA256,
  P0_R08_FINAL_ADMITTED_MAIN,
  P0_R08_FINAL_ADMITTED_TREE,
  P0_R08_FINAL_RECOVERY_PR,
  P0_R08_PRINCIPAL_RUNTIME_ARM64_SHA256,
  P0_R08_PRINCIPAL_RUNTIME_COMMIT,
  P0_R08_PRINCIPAL_RUNTIME_REF,
  P0_R08_PRINCIPAL_RUNTIME_TAG,
  P0_R08_PRINCIPAL_RUNTIME_TREE,
  P0_R08_PRINCIPAL_RUNTIME_X64_SHA256,
  P0_R08_RUNTIME_ARM64_SHA256,
  P0_R08_RUNTIME_COMMIT,
  P0_R08_RUNTIME_PR,
  P0_R08_RUNTIME_REF,
  P0_R08_RUNTIME_TAG,
  P0_R08_RUNTIME_TAG_OBJECT,
  P0_R08_RUNTIME_TREE,
  P0_R08_RUNTIME_X64_SHA256,
  P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT,
  P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256,
  P0_R08_FIRST_TERMINAL_ADMITTED_MAIN,
  P0_R08_FIRST_TERMINAL_ADMITTED_TREE,
  P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES,
  P0_R08_TERMINAL_ADMISSION_COMMENT,
  P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256,
  P0_R08_TERMINAL_ADMITTED_MAIN,
  P0_R08_TERMINAL_ADMITTED_TREE,
  P0_R08_TERMINAL_AO_DATA_DIR,
  P0_R08_TERMINAL_AO_RUN_FILE,
  P0_R08_TERMINAL_ROOT,
  P0_R08_TERMINAL_RUNTIME_BINARY,
  P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
  SELF_HOSTING_RECEIPT_SCHEMA_VERSION,
  TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION,
  TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION,
  TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION,
  assertPathResolvesWithin,
  resolvePathThroughFilesystem,
  verifySelfHostingReceipt,
} from '../../scripts/ao/lib/self-hosting-receipt.js';
import { issueLinkedPrEvidenceFromTimeline } from '../../scripts/ao/lib/issue-linked-pr-evidence.js';
import { parseArgs, removeTemporaryRoot } from '../../scripts/verify-fresh-clone.js';
import { inspectWorktreeBinding } from '../../scripts/ao/lib/worktree-evidence.js';
import {
  ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION,
  ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION,
  captureOrchestratorBoundWorktreeEvidence,
  inspectAoSupervisorProcess,
  publishOrchestratorBoundWorktreeEvidence,
} from '../../scripts/ao/lib/orchestrator-worktree-publication.js';
import {
  PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION,
  createPremergeVerificationEvidence,
  publishOrchestratorBoundPremergeEvidence,
} from '../../scripts/ao/lib/premerge-verification-evidence.js';

function validSupervisorProcessBinding(sessionId = 'or-terminal') {
  return {
    supervisor_pid: 4242,
    supervisor_process_start_token: '987654',
    supervisor_executable_path: P0_R08_TERMINAL_RUNTIME_BINARY,
    supervisor_executable_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    supervisor_command_sha256: 'c'.repeat(64),
    session_id: sessionId,
    runtime_launch_id: 'launch-or-terminal',
    current_process_is_descendant: true,
  };
}

function validPremergePublicationAuthority(payload) {
  return {
    sourceRoot: '/source',
    workerRoot: '/worker',
    workerSessionId: 'worker-terminal',
    orchestratorSessionId: 'or-terminal',
    runtimeBinary: P0_R08_TERMINAL_RUNTIME_BINARY,
    env: {
      AO_SESSION_ID: 'or-terminal',
      AO_PROJECT_ID: 'ao-pilot-remediation',
      AO_ISSUE_ID: '63',
      AO_RUNTIME_LAUNCH_ID: 'launch-or-terminal',
    },
    sessionGet: (_binary, args) => ({ session: args[2] === 'worker-terminal' ? {
      id: 'worker-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind: 'worker', createdAt: '2026-08-02T14:29:56.794Z',
    } : {
      id: 'or-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind: 'orchestrator', activity: { state: 'active' }, isTerminated: false,
    } }),
    probes: {
      resolveRuntimeBinary: () => P0_R08_TERMINAL_RUNTIME_BINARY,
      runtimeDigest: () => P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
      inspectAoSupervisorProcess: () => validSupervisorProcessBinding(),
      captureWorktreeEvidence: () => ({ worker: { head_sha: payload.remediation_pr.head_sha, tree_sha: payload.remediation_pr.tree_sha } }),
    },
  };
}

function validSelfHostingReceipt() {
  const successorRuntime = loadRuntimeLock().lock;
  const runtime = {
    runtime_ref: P0_R08_PRINCIPAL_RUNTIME_REF,
    artifact: {
      repository: 'https://github.com/Samsen879/agent-orchestrator.git',
      version: '0.11.2-p0.1',
      ref: { name: P0_R08_PRINCIPAL_RUNTIME_TAG, commit_sha: P0_R08_PRINCIPAL_RUNTIME_COMMIT, tree_sha: P0_R08_PRINCIPAL_RUNTIME_TREE },
      integrity: { algorithm: 'git-tree-sha1', digest: P0_R08_PRINCIPAL_RUNTIME_TREE },
    },
    compatibility: { platforms: [
      { os: 'linux', arch: 'x64', binary_sha256: P0_R08_PRINCIPAL_RUNTIME_X64_SHA256 },
      { os: 'linux', arch: 'arm64', binary_sha256: P0_R08_PRINCIPAL_RUNTIME_ARM64_SHA256 },
    ] },
  };
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
        merge_sha: P0_R08_FIRST_TERMINAL_ADMITTED_MAIN,
      },
    },
    exact_main_replay: {
      passed: true,
      release_check_passed: true,
      main_sha: P0_R08_FIRST_TERMINAL_ADMITTED_MAIN,
      tree_sha: P0_R08_FIRST_TERMINAL_ADMITTED_TREE,
    },
    cleanup: {
      orchestrator_done: true,
      orchestrator_done_evidence_comment_id: 89,
      orchestrator_session_stopped: true,
      worker_session_stopped: true,
      worker_worktree_removed: true,
      stale_ownership_absent: true,
    },
    terminal_recovery_chain: {
      schema_version: TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION,
      standing_admission: {
        issue_number: 63,
        comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
        comment_body_bytes: P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES,
        comment_body_sha256: P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256,
        created_at: '2026-08-02T14:24:49Z',
        updated_at: '2026-08-02T14:24:49Z',
        principal_pr_number: P0_R08_PRINCIPAL_PR,
        max_additional_recovery_attempts: 2,
        admitted_main_sha: P0_R08_TERMINAL_ADMITTED_MAIN,
        admitted_tree_sha: P0_R08_TERMINAL_ADMITTED_TREE,
      },
      attempts: [{
        attempt: 1,
        kind: 'terminal_recovery_delivery',
        disposition: 'failed_premerge_gates',
        admission: {
          comment_id: P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT,
          comment_body_sha256: P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256,
          admitted_main_sha: P0_R08_FIRST_TERMINAL_ADMITTED_MAIN,
          admitted_tree_sha: P0_R08_FIRST_TERMINAL_ADMITTED_TREE,
        },
        pr: {
          number: P0_R08_FAILED_TERMINAL_PR,
          url: 'https://github.com/Samsen879/ao-pilot/pull/72',
          head_sha: P0_R08_FAILED_TERMINAL_HEAD,
          reviewed_head: P0_R08_FAILED_TERMINAL_HEAD,
          codex_reviews: [{
            attempt: 1,
            kind: 'clean_comment',
            evidence_id: 5158396828,
            request_comment_id: 5158376025,
            head_sha: '0724ab9882846314e39845292ab86ef4aefb3c2b',
            completed_at: '2026-08-02T14:03:57Z',
          }, {
            attempt: 2,
            kind: 'clean_comment',
            evidence_id: 5158456834,
            request_comment_id: 5158426324,
            head_sha: P0_R08_FAILED_TERMINAL_HEAD,
            completed_at: '2026-08-02T14:15:06Z',
          }],
          merge_sha: P0_R08_TERMINAL_ADMITTED_MAIN,
          merge_tree_sha: P0_R08_TERMINAL_ADMITTED_TREE,
          merged_at: '2026-08-02T14:15:52Z',
        },
        failure: {
          disposition_comment_id: P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT,
          disposition_comment_body_sha256: P0_R08_FAILED_TERMINAL_DISPOSITION_SHA256,
          disposition_created_at: '2026-08-02T14:29:13Z',
          disposition_updated_at: '2026-08-02T14:29:13Z',
          collector_review_2_recognized: false,
          premerge_worktree_evidence_published: false,
          terminal_receipt_published: false,
          reason_codes: ['review_2_clean_comment_unrecognized', 'premerge_worktree_evidence_missing'],
        },
      }, {
        attempt: 2,
        kind: 'terminal_recovery_delivery',
        disposition: 'failed_merge_path_provenance',
        predecessor_pr_number: P0_R08_FAILED_TERMINAL_PR,
        admission_comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
        pr: {
          number: P0_R08_FAILED_MERGE_PATH_PR,
          url: 'https://github.com/Samsen879/ao-pilot/pull/73',
          head_sha: P0_R08_FAILED_MERGE_PATH_HEAD,
          reviewed_head: P0_R08_FAILED_MERGE_PATH_REVIEWED_HEAD,
          codex_reviews: [{
            attempt: 1,
            kind: 'submitted_review',
            evidence_id: 4838853686,
            request_comment_id: 5158629433,
            head_sha: 'e3108ca40061fb314cc5f54fc8039656d2f89dc0',
            completed_at: '2026-08-02T14:52:10Z',
          }, {
            attempt: 2,
            kind: 'submitted_review',
            evidence_id: 4840588410,
            request_comment_id: 5161943701,
            head_sha: P0_R08_FAILED_MERGE_PATH_REVIEWED_HEAD,
            completed_at: '2026-08-03T03:27:03Z',
          }],
          finding_comment_ids: [3699415314, 3699415317, 3699415320, 3701145692, 3701145696, 3701145702, 3701145705, 3701145707, 3701145710],
          worktree_evidence_comment_id: 5163418525,
          premerge_evidence_comment_id: 5163443629,
          merge_sha: P0_R08_FINAL_ADMITTED_MAIN,
          merge_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
          merged_at: '2026-08-03T07:23:43Z',
        },
        failure: {
          disposition_comment_id: P0_R08_FAILED_MERGE_PATH_DISPOSITION_COMMENT,
          disposition_comment_body_bytes: P0_R08_FAILED_MERGE_PATH_DISPOSITION_BYTES,
          disposition_comment_body_sha256: P0_R08_FAILED_MERGE_PATH_DISPOSITION_SHA256,
          disposition_created_at: '2026-08-03T07:32:36Z',
          disposition_updated_at: '2026-08-03T07:32:36Z',
          architectural_blocker_comment_id: P0_R08_ARCHITECTURAL_BLOCKER_COMMENT,
          provider_mutation: 'gh_pr_merge_exact_head_guarded',
          ao_merge_executed: false,
          reason_codes: ['pinned_ao_merge_route_not_implemented', 'provider_mutation_not_executed_by_ao'],
        },
      }, {
        attempt: 3,
        kind: 'terminal_recovery_delivery',
        disposition: 'passed',
        predecessor_pr_number: P0_R08_FAILED_MERGE_PATH_PR,
        admission_comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
        pr_number: P0_R08_FINAL_RECOVERY_PR,
        worktree_evidence_comment_id: 188,
      }],
    },
    runtime_transition: {
      architectural_blocker: {
        comment_id: P0_R08_ARCHITECTURAL_BLOCKER_COMMENT,
        comment_body_bytes: P0_R08_ARCHITECTURAL_BLOCKER_BYTES,
        comment_body_sha256: P0_R08_ARCHITECTURAL_BLOCKER_SHA256,
        created_at: '2026-08-03T07:40:30Z',
        updated_at: '2026-08-03T07:40:30Z',
      },
      admission: {
        comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
        comment_body_bytes: P0_R08_FINAL_ADMISSION_BYTES,
        comment_body_sha256: P0_R08_FINAL_ADMISSION_SHA256,
        created_at: '2026-08-03T08:23:19Z',
        updated_at: '2026-08-03T08:23:19Z',
      },
      predecessor: {
        runtime_ref: 'runtime.agent_orchestrator.v0_11_2_p0_1',
        commit_sha: '711178ebe07d436db36020eb08f0c4e29613f97b',
        tree_sha: '479fba6fd44f251f0c66fafc5cb5d638a6ff590a',
        linux_x64_binary_sha256: 'a403e096203e68e94dde5f45922b0880a4a2dd662c38aab3f0af6d47ec56aa34',
      },
      successor: {
        runtime_ref: P0_R08_RUNTIME_REF,
        runtime_pr_number: P0_R08_RUNTIME_PR,
        runtime_pr_base: 'runtime-baseline/v0.11.2',
        bootstrap_merge_exception: 'owner_gh_pr_merge_runtime_pr_8_only',
        tag: P0_R08_RUNTIME_TAG,
        tag_object_sha: P0_R08_RUNTIME_TAG_OBJECT,
        commit_sha: P0_R08_RUNTIME_COMMIT,
        tree_sha: P0_R08_RUNTIME_TREE,
        integrity: { algorithm: 'git-tree-sha1', digest: P0_R08_RUNTIME_TREE },
        linux_x64_binary_sha256: P0_R08_RUNTIME_X64_SHA256,
        linux_arm64_binary_sha256: P0_R08_RUNTIME_ARM64_SHA256,
      },
    },
    terminal_remediation: {
      admission: {
        issue_number: 63,
        comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
        comment_body_bytes: P0_R08_FINAL_ADMISSION_BYTES,
        comment_body_sha256: P0_R08_FINAL_ADMISSION_SHA256,
        principal_pr_number: P0_R08_PRINCIPAL_PR,
        admitted_main_sha: P0_R08_FINAL_ADMITTED_MAIN,
        admitted_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
      },
      environment: {
        kind: 'isolated_terminal_remediation',
        prior_ao_state_read: false,
        verified_immutable_runtime_reused: true,
        remediation_root: P0_R08_TERMINAL_ROOT,
        ao_data_dir: P0_R08_TERMINAL_AO_DATA_DIR,
        ao_run_file: P0_R08_TERMINAL_AO_RUN_FILE,
        runtime_binary_path: `${P0_R08_RETRY_RUNTIME_STORE}/${successorRuntime.runtime_ref}/linux-x64/${successorRuntime.artifact.ref.commit_sha}/bin/ao`,
        runtime_binary_sha256: successorRuntime.compatibility.platforms[0].binary_sha256,
      },
      source: {
        repository: 'https://github.com/Samsen879/ao-pilot.git',
        clone_path: `${P0_R08_TERMINAL_ROOT}/ao-pilot`,
        clone_head_sha: P0_R08_FINAL_ADMITTED_MAIN,
        clone_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
        clean_before_bootstrap: true,
      },
      delivery: {
        orchestrator_session_id: 'or-terminal',
        worker_session_id: 'worker-terminal',
        worker_created_by_new_ao: true,
        worker_created_from_issue: true,
        worker_worktree_path: `${P0_R08_TERMINAL_AO_DATA_DIR}/worktrees/ao-pilot-remediation/ao-pilot-remediation-2`,
        worktree_evidence_comment_id: 188,
        worktree_evidence_publication: {
          schema_version: ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION,
          comment_id: 188,
          published_at: '2026-08-04T01:46:00.000Z',
          read_back_at: '2026-08-04T01:47:00.000Z',
          payload_bytes: 1234,
          payload_sha256: 'a'.repeat(64),
          exact_body_read_back: true,
          orchestrator_session_id: 'or-terminal',
          runtime_binary_path: `${P0_R08_RETRY_RUNTIME_STORE}/${successorRuntime.runtime_ref}/linux-x64/${successorRuntime.artifact.ref.commit_sha}/bin/ao`,
          runtime_binary_sha256: successorRuntime.compatibility.platforms[0].binary_sha256,
          process_binding: validSupervisorProcessBinding(),
        },
        worker_branch: 'ao/p0-r08-terminal-remediation',
        worker_committed: true,
        worker_pushed: true,
        worker_opened_pr: true,
        orchestrator_observed_ci: true,
        orchestrator_observed_codex_review: true,
        review_repairs_same_worker_pr: true,
        github_merge_outcome_confirmed: true,
        remediation_pr: {
          number: P0_R08_FINAL_RECOVERY_PR,
          url: 'https://github.com/Samsen879/ao-pilot/pull/74',
          head_sha: '6'.repeat(40),
          reviewed_head: '6'.repeat(40),
          ci_conclusion: 'success',
          codex_reviews: [{
            attempt: 1,
            kind: 'submitted_review',
            evidence_id: 201,
            request_comment_id: 199,
            head_sha: '6'.repeat(40),
            completed_at: '2026-08-04T01:00:00.000Z',
          }],
          finding_dispositions: [],
          post_review_2_repair: null,
          merged: true,
          merge_sha: '7'.repeat(40),
          merge_tree_sha: '8'.repeat(40),
        },
      },
      premerge_verification: {
        evidence_comment_id: 190,
        publication: {
          schema_version: PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION,
          issue_number: 63,
          comment_id: 190,
          published_at: '2026-08-04T01:58:00.000Z',
          read_back_at: '2026-08-04T01:59:00.000Z',
          payload_bytes: 2345,
          payload_sha256: 'b'.repeat(64),
          exact_body_read_back: true,
          orchestrator_session_id: 'or-terminal',
          runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
          runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
          process_binding: validSupervisorProcessBinding(),
        },
      },
      merge_execution: {
        evidence_comment_id: 191,
        publication: {
          schema_version: TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION,
          issue_number: 63,
          comment_id: 191,
          published_at: '2026-08-04T02:02:00.000Z',
          read_back_at: '2026-08-04T02:03:00.000Z',
          payload_bytes: 3456,
          payload_sha256: 'd'.repeat(64),
          exact_body_read_back: true,
          orchestrator_session_id: 'or-terminal',
          runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
          runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
          process_binding: validSupervisorProcessBinding(),
        },
      },
      exact_main_replay: {
        passed: true,
        release_check_passed: true,
        main_sha: '7'.repeat(40),
        tree_sha: '8'.repeat(40),
      },
      cleanup: {
        orchestrator_done: true,
        orchestrator_done_evidence_comment_id: 189,
        orchestrator_session_stopped: true,
        worker_session_stopped: true,
        worker_worktree_removed: true,
        stale_ownership_absent: true,
      },
    },
    claim: {
      workstation_self_hosting: true,
      p0_r08_satisfied: true,
    },
  };
}

function validEvidence(receipt) {
  const evidence = {
    repositoryEvidence: {
      current_main_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_sha,
      current_main_tree_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_tree_sha,
      source_commit_sha: receipt.source.clone_head_sha,
      source_tree_sha: receipt.source.clone_tree_sha,
      terminal_source_commit_sha: receipt.terminal_remediation.source.clone_head_sha,
      terminal_source_tree_sha: receipt.terminal_remediation.source.clone_tree_sha,
      terminal_worker_commit_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
      terminal_worker_tree_sha: '9'.repeat(40),
      terminal_source_is_ancestor: true,
      terminal_merge_base_sha: receipt.terminal_remediation.source.clone_head_sha,
      terminal_reviewed_head_is_ancestor: true,
      terminal_reviewed_head_merge_base_sha: receipt.terminal_remediation.delivery.remediation_pr.reviewed_head,
      terminal_branch_creation_sha: null,
      terminal_branch_creation_at: null,
      release_check_passed: true,
    },
    githubEvidence: {
      issue_63: { number: 63, state: 'open' },
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
        merge_tree_sha: receipt.exact_main_replay.tree_sha,
        head_sha: receipt.delivery.principal_pr.head_sha,
        head_ref: receipt.delivery.worker_branch,
        base_ref: 'main',
        created_at: '2026-08-02T12:00:00.000Z',
        merged_at: '2026-08-03T02:00:00.000Z',
        linked_issue_63: true,
      },
      standing_recovery_admission: {
        comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-02T14:24:49Z',
        updated_at: '2026-08-02T14:24:49Z',
        body_bytes: P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES,
        body_sha256: P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256,
      },
      terminal_remediation_admission: {
        comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-03T08:23:19Z',
        updated_at: '2026-08-03T08:23:19Z',
        body_bytes: P0_R08_FINAL_ADMISSION_BYTES,
        body_sha256: P0_R08_FINAL_ADMISSION_SHA256,
      },
      first_terminal_admission: {
        comment_id: P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-02T13:32:32Z',
        updated_at: '2026-08-02T13:32:32Z',
        body_sha256: P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256,
      },
      failed_terminal_pr: {
        number: P0_R08_FAILED_TERMINAL_PR,
        merged: true,
        merge_sha: P0_R08_TERMINAL_ADMITTED_MAIN,
        merge_tree_sha: P0_R08_TERMINAL_ADMITTED_TREE,
        head_sha: P0_R08_FAILED_TERMINAL_HEAD,
        base_ref: 'main',
        merged_at: '2026-08-02T14:15:52Z',
      },
      failed_terminal_disposition: {
        comment_id: P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-02T14:29:13Z',
        updated_at: '2026-08-02T14:29:13Z',
        body_sha256: P0_R08_FAILED_TERMINAL_DISPOSITION_SHA256,
      },
      failed_merge_path_pr: {
        number: P0_R08_FAILED_MERGE_PATH_PR,
        merged: true,
        merge_sha: P0_R08_FINAL_ADMITTED_MAIN,
        merge_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
        head_sha: P0_R08_FAILED_MERGE_PATH_HEAD,
        base_ref: 'main',
        merged_at: '2026-08-03T07:23:43Z',
      },
      failed_merge_path_disposition: {
        comment_id: P0_R08_FAILED_MERGE_PATH_DISPOSITION_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-03T07:32:36Z',
        updated_at: '2026-08-03T07:32:36Z',
        body_bytes: P0_R08_FAILED_MERGE_PATH_DISPOSITION_BYTES,
        body_sha256: P0_R08_FAILED_MERGE_PATH_DISPOSITION_SHA256,
      },
      failed_merge_path_worktree_evidence: {
        comment_id: 5163418525, issue_number: 63, author: 'Samsen879', author_association: 'OWNER',
        created_at: '2026-08-03T07:17:13Z', updated_at: '2026-08-03T07:17:13Z',
      },
      failed_merge_path_premerge_evidence: {
        comment_id: 5163443629, issue_number: 63, author: 'Samsen879', author_association: 'OWNER',
        created_at: '2026-08-03T07:20:16Z', updated_at: '2026-08-03T07:20:16Z',
      },
      architectural_blocker: {
        comment_id: P0_R08_ARCHITECTURAL_BLOCKER_COMMENT,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-03T07:40:30Z',
        updated_at: '2026-08-03T07:40:30Z',
        body_bytes: P0_R08_ARCHITECTURAL_BLOCKER_BYTES,
        body_sha256: P0_R08_ARCHITECTURAL_BLOCKER_SHA256,
      },
      runtime_pr: {
        number: P0_R08_RUNTIME_PR,
        merged: true,
        base_ref: 'runtime-baseline/v0.11.2',
        merge_sha: P0_R08_RUNTIME_COMMIT,
        merge_tree_sha: P0_R08_RUNTIME_TREE,
      },
      runtime_tag: {
        tag: P0_R08_RUNTIME_TAG,
        tag_object_sha: P0_R08_RUNTIME_TAG_OBJECT,
        commit_sha: P0_R08_RUNTIME_COMMIT,
      },
      terminal_remediation_pr: {
        number: receipt.terminal_remediation.delivery.remediation_pr.number,
        merged: true,
        merge_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_sha,
        merge_tree_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_tree_sha,
        head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
        head_ref: receipt.terminal_remediation.delivery.worker_branch,
        base_ref: 'main',
        created_at: '2026-08-03T08:30:00.000Z',
        merged_at: '2026-08-04T02:00:00.000Z',
        linked_issue_63: true,
        auto_closes_issue_63: false,
        binds_terminal_admission: true,
        binds_principal_pr_71: true,
        binds_failed_terminal_pr_72: true,
        binds_failed_merge_path_pr_73: true,
        binds_architectural_blocker: true,
        binds_final_admission: true,
      },
      issue_linked_prs: [{
        repository: 'Samsen879/ao-pilot',
        number: receipt.delivery.principal_pr.number,
        url: receipt.delivery.principal_pr.url,
        created_at: '2026-08-02T12:00:00.000Z',
        head_ref: receipt.delivery.worker_branch,
        base_ref: 'main',
      }, {
        repository: 'Samsen879/ao-pilot',
        number: P0_R08_FAILED_TERMINAL_PR,
        url: 'https://github.com/Samsen879/ao-pilot/pull/72',
        created_at: '2026-08-02T13:40:00.000Z',
        head_ref: 'ao/p0-r08-terminal-remediation',
        base_ref: 'main',
      }, {
        repository: 'Samsen879/ao-pilot',
        number: P0_R08_FAILED_MERGE_PATH_PR,
        url: 'https://github.com/Samsen879/ao-pilot/pull/73',
        created_at: '2026-08-02T14:44:39.000Z',
        head_ref: 'ao/p0-r08-standing-recovery-1',
        base_ref: 'main',
      }, {
        repository: 'Samsen879/ao-pilot',
        number: receipt.terminal_remediation.delivery.remediation_pr.number,
        url: receipt.terminal_remediation.delivery.remediation_pr.url,
        created_at: '2026-08-03T08:30:00.000Z',
        head_ref: receipt.terminal_remediation.delivery.worker_branch,
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
      failed_terminal_codex_reviews: receipt.terminal_recovery_chain.attempts[0].pr.codex_reviews.map((review) => ({
        kind: review.kind,
        evidence_id: review.evidence_id,
        request_comment_id: review.request_comment_id,
        request_valid: true,
        head_sha: review.head_sha,
        completed_at: review.completed_at,
        actor: 'chatgpt-codex-connector[bot]',
        completed: true,
      })),
      failed_merge_path_codex_reviews: receipt.terminal_recovery_chain.attempts[1].pr.codex_reviews.map((review) => ({
        kind: review.kind,
        evidence_id: review.evidence_id,
        request_comment_id: review.request_comment_id,
        request_valid: true,
        head_sha: review.head_sha,
        completed_at: review.completed_at,
        actor: 'chatgpt-codex-connector[bot]',
        completed: true,
      })),
      failed_merge_path_review_findings: receipt.terminal_recovery_chain.attempts[1].pr.finding_comment_ids.map((commentId, index) => ({
        comment_id: commentId,
        review_id: index < 3 ? 4838853686 : 4840588410,
        resolved: true,
      })),
      terminal_check_runs: ['fresh-clone-runtime', 'test (20)', 'test (22)'].map((name) => ({ name, conclusion: 'success' })),
      terminal_codex_reviews: receipt.terminal_remediation.delivery.remediation_pr.codex_reviews.map((review) => ({
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
      terminal_review_findings: [],
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
      terminal_worktree_capture: {
        comment_id: receipt.terminal_remediation.delivery.worktree_evidence_comment_id,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-04T01:46:00.000Z',
        updated_at: '2026-08-04T01:46:00.000Z',
        body_bytes: 1234,
        body_sha256: 'a'.repeat(64),
        payload: {
          schema_version: 'ao.workstation-worktree-evidence.v6',
          issue_number: 63,
          captured_at: '2026-08-04T01:45:00.000Z',
          source: {
            clone_path: receipt.terminal_remediation.source.clone_path,
            head_sha: receipt.terminal_remediation.source.clone_head_sha,
            tree_sha: receipt.terminal_remediation.source.clone_tree_sha,
            git_common_dir: `${P0_R08_TERMINAL_ROOT}/ao-pilot/.git`,
          },
          isolation: {
            remediation_root: P0_R08_TERMINAL_ROOT,
            ao_data_dir: P0_R08_TERMINAL_AO_DATA_DIR,
            ao_run_file: P0_R08_TERMINAL_AO_RUN_FILE,
          },
          recovery_chain: {
            standing_admission_comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
            final_admission_comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
            attempt: 3,
            prior_attempt_pr_number: P0_R08_FAILED_MERGE_PATH_PR,
            admitted_main_sha: P0_R08_FINAL_ADMITTED_MAIN,
            admitted_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
          },
          worker: {
            session_id: receipt.terminal_remediation.delivery.worker_session_id,
            worktree_path: receipt.terminal_remediation.delivery.worker_worktree_path,
            branch: receipt.terminal_remediation.delivery.worker_branch,
            head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
            tree_sha: '9'.repeat(40),
            git_common_dir: `${P0_R08_TERMINAL_ROOT}/ao-pilot/.git`,
          },
          git_relationship: {
            source_is_ancestor: true,
            merge_base_sha: receipt.terminal_remediation.source.clone_head_sha,
            branch_creation_sha: receipt.terminal_remediation.source.clone_head_sha,
            branch_creation_at: '2026-08-02T14:29:56.000Z',
            branch_creation_subject: 'branch: Created from origin/main',
            worker_session_created_at: '2026-08-02T14:29:56.794Z',
          },
          orchestrator_provenance: {
            schema_version: ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION,
            session_id: receipt.terminal_remediation.delivery.orchestrator_session_id,
            worker_session_id: receipt.terminal_remediation.delivery.worker_session_id,
            project_id: 'ao-pilot-remediation',
            issue_number: 63,
            kind: 'orchestrator',
            activity_state: 'active',
            is_terminated: false,
            runtime_launch_id: 'launch-or-terminal',
            runtime_binary_path: receipt.terminal_remediation.environment.runtime_binary_path,
            runtime_binary_sha256: receipt.terminal_remediation.environment.runtime_binary_sha256,
            process_binding: validSupervisorProcessBinding(),
            session_get: {
              args: ['session', 'get', receipt.terminal_remediation.delivery.orchestrator_session_id, '--json'],
              worker_args: ['session', 'get', receipt.terminal_remediation.delivery.worker_session_id, '--json'],
            },
            operation: {
              capture: true,
              publish_issue_comment: true,
              read_back_exact_body: true,
            },
          },
        },
      },
      terminal_premerge_capture: null,
      terminal_merge_capture: receipt.terminal_remediation.merge_execution == null ? null : {
        comment_id: receipt.terminal_remediation.merge_execution.evidence_comment_id,
        issue_number: 63,
        author: 'Samsen879',
        author_association: 'OWNER',
        created_at: '2026-08-04T02:02:00.000Z',
        updated_at: '2026-08-04T02:02:00.000Z',
        body_bytes: 3456,
        body_sha256: 'd'.repeat(64),
        payload: {
          schema_version: TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION,
          issue_number: 63,
          completed_at: '2026-08-04T02:01:00.000Z',
          orchestrator_session_id: receipt.terminal_remediation.delivery.orchestrator_session_id,
          recovery_attempt: 3,
          premerge_evidence: {
            comment_id: receipt.terminal_remediation.premerge_verification.evidence_comment_id,
            payload_sha256: 'b'.repeat(64),
          },
          command: {
            runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
            runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
            args: ['pr', 'merge', String(receipt.terminal_remediation.delivery.remediation_pr.number)],
            exit_code: 0,
            stdout: `merged PR #${receipt.terminal_remediation.delivery.remediation_pr.number} using squash (head ${receipt.terminal_remediation.delivery.remediation_pr.head_sha}, merge commit ${receipt.terminal_remediation.delivery.remediation_pr.merge_sha})`,
          },
          effect: {
            provider_mutation: 'github_squash_merge',
            exact_head_guarded: true,
            ao_merge_executed: true,
            github_readback_confirmed: true,
            pr_number: receipt.terminal_remediation.delivery.remediation_pr.number,
            method: 'squash',
            head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
            merge_commit_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_sha,
            main_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_sha,
            main_tree_sha: receipt.terminal_remediation.delivery.remediation_pr.merge_tree_sha,
          },
          orchestrator_provenance: null,
        },
      },
      terminal_orchestrator_done_capture: {
        comment_id: receipt.terminal_remediation.cleanup.orchestrator_done_evidence_comment_id,
        issue_number: 63,
        author: 'Samsen879',
        created_at: '2026-08-04T02:06:00.000Z',
        updated_at: '2026-08-04T02:06:00.000Z',
        payload: {
          schema_version: ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION,
          issue_number: 63,
          completed_at: '2026-08-04T02:05:00.000Z',
          orchestrator_session_id: receipt.terminal_remediation.delivery.orchestrator_session_id,
          command: {
            runtime_binary_path: receipt.terminal_remediation.environment.runtime_binary_path,
            args: ['orchestrator', 'done', '--session', receipt.terminal_remediation.delivery.orchestrator_session_id],
            exit_code: 0,
            stdout: `Orchestrator ${receipt.terminal_remediation.delivery.orchestrator_session_id} marked done.`,
          },
        },
      },
    },
    publicationEvidence: {
      issue_number: 63,
      author: 'Samsen879',
      created_at: '2026-08-04T02:10:00.000Z',
      exact_bytes_match: true,
    },
  };
  const terminalCapture = evidence.githubEvidence.terminal_worktree_capture;
  if (evidence.githubEvidence.terminal_merge_capture) {
    evidence.githubEvidence.terminal_merge_capture.payload.orchestrator_provenance = terminalCapture.payload.orchestrator_provenance;
  }
  if (receipt.terminal_remediation.premerge_verification == null) return evidence;
  evidence.githubEvidence.terminal_premerge_capture = {
    comment_id: receipt.terminal_remediation.premerge_verification.evidence_comment_id,
    issue_number: 63,
    author: 'Samsen879',
    author_association: 'OWNER',
    created_at: '2026-08-04T01:58:00.000Z',
    updated_at: '2026-08-04T01:58:00.000Z',
    body_bytes: 2345,
    body_sha256: 'b'.repeat(64),
    payload: {
      schema_version: PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      issue_number: 63,
      verified_at: '2026-08-04T01:57:00.000Z',
      status: 'premerge_verified',
      standing_admission_comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
      final_admission_comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
      recovery_attempt: 3,
      remediation_pr: {
        number: receipt.terminal_remediation.delivery.remediation_pr.number,
        head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
        tree_sha: evidence.repositoryEvidence.terminal_worker_tree_sha,
        reviewed_head: receipt.terminal_remediation.delivery.remediation_pr.reviewed_head,
        review_evidence_ids: receipt.terminal_remediation.delivery.remediation_pr.codex_reviews.map((review) => review.evidence_id),
        resolved_finding_comment_ids: receipt.terminal_remediation.delivery.remediation_pr.finding_dispositions.map((finding) => finding.comment_id),
      },
      release_check: {
        command: 'npm run release:check',
        checkout_head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
        checkout_tree_sha: evidence.repositoryEvidence.terminal_worker_tree_sha,
        passed: true,
      },
      git_relationship: {
        reviewed_head_is_ancestor: true,
        reviewed_head_merge_base_sha: receipt.terminal_remediation.delivery.remediation_pr.reviewed_head,
        source_is_ancestor: true,
        source_merge_base_sha: receipt.terminal_remediation.source.clone_head_sha,
        branch_creation_sha: receipt.terminal_remediation.source.clone_head_sha,
        branch_creation_at: terminalCapture.payload.git_relationship.branch_creation_at,
      },
      worktree_evidence: {
        comment_id: terminalCapture.comment_id,
        published_at: terminalCapture.created_at,
        payload_bytes: terminalCapture.body_bytes,
        payload_sha256: terminalCapture.body_sha256,
        publication_schema_version: receipt.terminal_remediation.delivery.worktree_evidence_publication.schema_version,
        publication_read_back_at: receipt.terminal_remediation.delivery.worktree_evidence_publication.read_back_at,
        publication_process_binding: receipt.terminal_remediation.delivery.worktree_evidence_publication.process_binding,
      },
      orchestrator_provenance: terminalCapture.payload.orchestrator_provenance,
    },
  };
  return evidence;
}

function validPreMergeReceipt() {
  const receipt = validSelfHostingReceipt();
  receipt.status = 'pending';
  receipt.terminal_recovery_chain.attempts[2].disposition = 'pending';
  receipt.terminal_remediation.delivery.github_merge_outcome_confirmed = false;
  receipt.terminal_remediation.delivery.remediation_pr.merged = false;
  receipt.terminal_remediation.delivery.remediation_pr.merge_sha = null;
  receipt.terminal_remediation.delivery.remediation_pr.merge_tree_sha = null;
  receipt.terminal_remediation.premerge_verification = null;
  receipt.terminal_remediation.merge_execution = null;
  receipt.terminal_remediation.exact_main_replay = {
    passed: false,
    release_check_passed: false,
    main_sha: null,
    tree_sha: null,
  };
  receipt.terminal_remediation.cleanup = {
    orchestrator_done: false,
    orchestrator_done_evidence_comment_id: 0,
    orchestrator_session_stopped: false,
    worker_session_stopped: false,
    worker_worktree_removed: false,
    stale_ownership_absent: false,
  };
  receipt.claim = {
    workstation_self_hosting: false,
    p0_r08_satisfied: false,
  };
  return receipt;
}

function validPreMergeEvidence(receipt) {
  const evidence = validEvidence(receipt);
  delete evidence.publicationEvidence;
  evidence.githubEvidence.terminal_remediation_pr.merged = false;
  evidence.githubEvidence.terminal_remediation_pr.merge_sha = null;
  evidence.githubEvidence.terminal_remediation_pr.merge_tree_sha = null;
  evidence.githubEvidence.terminal_remediation_pr.merged_at = null;
  evidence.githubEvidence.terminal_orchestrator_done_capture = null;
  evidence.githubEvidence.terminal_premerge_capture = null;
  evidence.repositoryEvidence.current_main_sha = receipt.terminal_remediation.delivery.remediation_pr.head_sha;
  evidence.repositoryEvidence.current_main_tree_sha = evidence.repositoryEvidence.terminal_worker_tree_sha;
  evidence.repositoryEvidence.terminal_branch_creation_sha = receipt.terminal_remediation.source.clone_head_sha;
  evidence.repositoryEvidence.terminal_branch_creation_at = evidence.githubEvidence.terminal_worktree_capture.payload.git_relationship.branch_creation_at;
  return evidence;
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
      runtime: {
        runtime_ref: P0_R08_PRINCIPAL_RUNTIME_REF,
        tag: P0_R08_PRINCIPAL_RUNTIME_TAG,
        commit_sha: P0_R08_PRINCIPAL_RUNTIME_COMMIT,
        tree_sha: P0_R08_PRINCIPAL_RUNTIME_TREE,
      },
      delivery: {
        worktree_evidence_comment_id: 5157857462,
        principal_pr: { number: 71 },
      },
      cleanup: { orchestrator_done_evidence_comment_id: 5157899599 },
      terminal_remediation: {
        admission: {
          comment_id: P0_R08_FINAL_ADMISSION_COMMENT,
          comment_body_bytes: P0_R08_FINAL_ADMISSION_BYTES,
          comment_body_sha256: P0_R08_FINAL_ADMISSION_SHA256,
          principal_pr_number: P0_R08_PRINCIPAL_PR,
          admitted_main_sha: P0_R08_FINAL_ADMITTED_MAIN,
          admitted_tree_sha: P0_R08_FINAL_ADMITTED_TREE,
        },
        environment: {
          runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
          runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
        },
        merge_execution: null,
      },
      terminal_recovery_chain: {
        schema_version: TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION,
        standing_admission: {
          comment_id: P0_R08_TERMINAL_ADMISSION_COMMENT,
          comment_body_bytes: P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES,
          comment_body_sha256: P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256,
          admitted_main_sha: P0_R08_TERMINAL_ADMITTED_MAIN,
          admitted_tree_sha: P0_R08_TERMINAL_ADMITTED_TREE,
          principal_pr_number: P0_R08_PRINCIPAL_PR,
          max_additional_recovery_attempts: 2,
        },
        attempts: [
          expect.objectContaining({ attempt: 1, disposition: 'failed_premerge_gates', pr: { number: 72, url: 'https://github.com/Samsen879/ao-pilot/pull/72', head_sha: P0_R08_FAILED_TERMINAL_HEAD, reviewed_head: P0_R08_FAILED_TERMINAL_HEAD, codex_reviews: expect.any(Array), merge_sha: P0_R08_TERMINAL_ADMITTED_MAIN, merge_tree_sha: P0_R08_TERMINAL_ADMITTED_TREE, merged_at: '2026-08-02T14:15:52Z' } }),
          expect.objectContaining({ attempt: 2, disposition: 'failed_merge_path_provenance', predecessor_pr_number: 72, pr: expect.objectContaining({ number: 73 }) }),
          expect.objectContaining({ attempt: 3, predecessor_pr_number: 73, pr_number: 74 }),
        ],
      },
      runtime_transition: {
        architectural_blocker: { comment_id: P0_R08_ARCHITECTURAL_BLOCKER_COMMENT },
        admission: { comment_id: P0_R08_FINAL_ADMISSION_COMMENT },
        successor: { runtime_pr_number: P0_R08_RUNTIME_PR, tag_object_sha: P0_R08_RUNTIME_TAG_OBJECT },
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
    expect(handoff).toContain('run publish:self-hosting-worktree');
    expect(handoff).toContain('--orchestrator-session-id ao-pilot-remediation-1');
    expect(handoff).toContain('--publication-receipt-out');
    expect(handoff).toContain('--pre-merge');
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

  it('preserves p0.1 for the immutable principal/bootstrap proof and confines p0.2 to the successor transition and terminal environment', () => {
    const receipt = validSelfHostingReceipt();
    expect(receipt.runtime).toMatchObject({
      runtime_ref: P0_R08_PRINCIPAL_RUNTIME_REF,
      commit_sha: P0_R08_PRINCIPAL_RUNTIME_COMMIT,
      tree_sha: P0_R08_PRINCIPAL_RUNTIME_TREE,
      binary_sha256: P0_R08_PRINCIPAL_RUNTIME_X64_SHA256,
    });
    expect(receipt.runtime_transition.successor).toMatchObject({
      runtime_ref: P0_R08_RUNTIME_REF,
      commit_sha: P0_R08_RUNTIME_COMMIT,
      tree_sha: P0_R08_RUNTIME_TREE,
    });
    expect(receipt.terminal_remediation.environment).toMatchObject({
      runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    });
    receipt.runtime.runtime_ref = P0_R08_RUNTIME_REF;
    expect(() => verifySelfHostingReceipt(receipt, validEvidence(receipt))).toThrow('Historical principal runtime ref mismatch');
  });

  it.each([
    ['missing immutable AO merge record', (receipt) => { receipt.terminal_remediation.merge_execution = null; }],
    ['direct/manual merge substitution', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.ao_merge_executed = false; }],
    ['missing exact-HEAD guard', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.exact_head_guarded = false; }],
    ['wrong merge command', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.command.args = ['gh', 'pr', 'merge', '74']; }],
    ['p0.2 merge runtime digest drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.command.runtime_binary_sha256 = 'f'.repeat(64); }],
    ['merge effect HEAD drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.head_sha = 'f'.repeat(40); }],
    ['merge/main effect drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.main_tree_sha = 'f'.repeat(40); }],
    ['missing GitHub merge readback', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.github_readback_confirmed = false; }],
    ['edited merge evidence', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.updated_at = '2026-08-04T02:03:00.000Z'; }],
    ['missing merge evidence readback', (receipt) => { receipt.terminal_remediation.merge_execution.publication.exact_body_read_back = false; }],
    ['arbitrary merge effect field', (_receipt, evidence) => { evidence.githubEvidence.terminal_merge_capture.payload.effect.extra = true; }],
  ])('fails closed for AO merge execution/effect provenance: %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
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

  it('executes a staged pre-merge receipt verification without post-merge claims', () => {
    const receipt = validPreMergeReceipt();
    expect(verifySelfHostingReceipt(receipt, {
      ...validPreMergeEvidence(receipt),
      requirePublication: false,
      stage: 'pre_merge',
    })).toMatchObject({
      status: 'premerge_verified',
      principal_pr: 71,
      terminal_recovery_pr: 74,
      worktree_evidence_comment: 188,
      orchestrator_session_id: 'or-terminal',
    });
  });

  it('creates canonical immutable evidence from the exact-head staged verification result', () => {
    const receipt = validPreMergeReceipt();
    const evidence = validPreMergeEvidence(receipt);
    const result = verifySelfHostingReceipt(receipt, {
      ...evidence,
      requirePublication: false,
      stage: 'pre_merge',
    });
    const artifact = createPremergeVerificationEvidence({
      receipt,
      result,
      evidence,
      verifiedAt: '2026-08-04T01:57:00.000Z',
    });
    expect(artifact).toMatchObject({
      schema_version: PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      status: 'premerge_verified',
      remediation_pr: {
        head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
        tree_sha: evidence.repositoryEvidence.current_main_tree_sha,
      },
      release_check: {
        checkout_head_sha: receipt.terminal_remediation.delivery.remediation_pr.head_sha,
        passed: true,
      },
      worktree_evidence: { comment_id: 188 },
    });
  });

  it('publishes canonical preflight evidence with exact Orchestrator-bound readback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-preflight-publication-'));
    const receipt = validPreMergeReceipt();
    const evidence = validPreMergeEvidence(receipt);
    const result = verifySelfHostingReceipt(receipt, { ...evidence, requirePublication: false, stage: 'pre_merge' });
    const payload = createPremergeVerificationEvidence({ receipt, result, evidence, verifiedAt: '2026-08-04T01:57:00.000Z' });
    const evidencePath = path.join(root, 'preflight.json');
    fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
    const authorityOptions = validPremergePublicationAuthority(payload);
    let readBackCompleted = false;
    try {
      const publication = publishOrchestratorBoundPremergeEvidence({
        evidencePath,
        publicationReceiptPath: path.join(root, 'publication.json'),
        authorityOptions,
        publish: () => ({ id: 5159000003 }),
        readBack: () => {
          readBackCompleted = true;
          return {
            id: 5159000003, user: { login: 'Samsen879' }, author_association: 'OWNER',
            created_at: '2026-08-04T01:58:00.000Z', updated_at: '2026-08-04T01:58:00.000Z',
            body: fs.readFileSync(evidencePath, 'utf8'),
          };
        },
        now: () => {
          expect(readBackCompleted).toBe(true);
          return '2026-08-04T01:57:59.750Z';
        },
      });
      expect(publication).toMatchObject({
        schema_version: PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION,
        comment_id: 5159000003,
        published_at: '2026-08-04T01:58:00.000Z',
        read_back_at: '2026-08-04T01:58:00.000Z',
        exact_body_read_back: true,
        process_binding: validSupervisorProcessBinding(),
      });
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('does not sample or persist a readback timestamp when GitHub readback fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-preflight-sequencing-'));
    const receipt = validPreMergeReceipt();
    const evidence = validPreMergeEvidence(receipt);
    const result = verifySelfHostingReceipt(receipt, { ...evidence, requirePublication: false, stage: 'pre_merge' });
    const payload = createPremergeVerificationEvidence({ receipt, result, evidence, verifiedAt: '2026-08-04T01:57:00.000Z' });
    const evidencePath = path.join(root, 'preflight.json');
    const publicationReceiptPath = path.join(root, 'publication.json');
    fs.writeFileSync(evidencePath, JSON.stringify(payload, null, 2));
    let nowCalled = false;
    try {
      expect(() => publishOrchestratorBoundPremergeEvidence({
        evidencePath,
        publicationReceiptPath,
        authorityOptions: validPremergePublicationAuthority(payload),
        publish: () => ({ id: 5159000004 }),
        readBack: () => { throw new Error('GitHub readback failed'); },
        now: () => {
          nowCalled = true;
          return '2026-08-04T01:58:00.000Z';
        },
      })).toThrow('GitHub readback failed');
      expect(nowCalled).toBe(false);
      expect(fs.existsSync(publicationReceiptPath)).toBe(false);
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it.each([
    ['missing immutable preflight record', (receipt) => { delete receipt.terminal_remediation.premerge_verification; }],
    ['preflight final-head drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_premerge_capture.payload.remediation_pr.head_sha = 'f'.repeat(40); }],
    ['preflight finding-ID drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_premerge_capture.payload.remediation_pr.resolved_finding_comment_ids = [999]; }],
    ['preflight worktree identity drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_premerge_capture.payload.worktree_evidence.comment_id = 999; }],
    ['preflight exact-readback failure', (receipt) => { receipt.terminal_remediation.premerge_verification.publication.exact_body_read_back = false; }],
    ['preflight process provenance drift', (receipt) => { receipt.terminal_remediation.premerge_verification.publication.process_binding.supervisor_process_start_token = 'other-process'; }],
    ['preflight payload digest drift', (_receipt, evidence) => { evidence.githubEvidence.terminal_premerge_capture.body_sha256 = 'f'.repeat(64); }],
    ['preflight published after merge', (_receipt, evidence) => { evidence.githubEvidence.terminal_premerge_capture.created_at = '2026-08-04T02:01:00.000Z'; evidence.githubEvidence.terminal_premerge_capture.updated_at = '2026-08-04T02:01:00.000Z'; }],
  ])('final verification rejects %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
  });

  it('accepts only a post-Review-2 repaired head that descends from the reviewed head', () => {
    const receipt = validSelfHostingReceipt();
    const remediation = receipt.terminal_remediation.delivery.remediation_pr;
    remediation.codex_reviews.push({
      attempt: 2, kind: 'submitted_review', evidence_id: 202, request_comment_id: 200,
      head_sha: '6'.repeat(40), completed_at: '2026-08-04T01:30:00.000Z',
    });
    remediation.head_sha = '7'.repeat(40);
    remediation.reviewed_head = '6'.repeat(40);
    remediation.finding_dispositions = [{ comment_id: 301, review_id: 202, disposition: 'fixed', resolved: true }];
    remediation.post_review_2_repair = {
      authorization_ref: 'https://github.com/Samsen879/ao-pilot/issues/63#issuecomment-5163994984',
      final_head_sha: '7'.repeat(40), finding_comment_ids: [301],
    };
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.terminal_review_findings = [{ comment_id: 301, review_id: 202, resolved: true }];
    expect(verifySelfHostingReceipt(receipt, evidence)).toMatchObject({ status: 'verified', terminal_reviewed_head: '6'.repeat(40) });

    evidence.repositoryEvidence.terminal_reviewed_head_is_ancestor = false;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('does not descend from the reviewed HEAD');
  });

  it.each([
    ['premature merge claim', (receipt) => { receipt.terminal_remediation.delivery.remediation_pr.merged = true; }],
    ['premature replay claim', (receipt) => { receipt.terminal_remediation.exact_main_replay.passed = true; }],
    ['premature cleanup claim', (receipt) => { receipt.terminal_remediation.cleanup.worker_worktree_removed = true; }],
    ['premature final claim', (receipt) => { receipt.claim.workstation_self_hosting = true; }],
    ['wrong publication Orchestrator', (receipt) => { receipt.terminal_remediation.delivery.worktree_evidence_publication.orchestrator_session_id = 'worker-terminal'; }],
    ['missing exact readback', (receipt) => { receipt.terminal_remediation.delivery.worktree_evidence_publication.exact_body_read_back = false; }],
    ['pre-existing preflight claim', (receipt) => { receipt.terminal_remediation.premerge_verification = { evidence_comment_id: 190 }; }],
    ['pre-existing AO merge execution claim', (receipt) => { receipt.terminal_remediation.merge_execution = { evidence_comment_id: 191 }; }],
  ])('pre-merge verification fails closed for %s', (_name, mutate) => {
    const receipt = validPreMergeReceipt();
    const evidence = validPreMergeEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, {
      ...evidence,
      requirePublication: false,
      stage: 'pre_merge',
    })).toThrow();
  });

  it.each([
    ['live ancestry failure', (evidence) => { evidence.repositoryEvidence.terminal_source_is_ancestor = false; }],
    ['live merge-base drift', (evidence) => { evidence.repositoryEvidence.terminal_merge_base_sha = 'f'.repeat(40); }],
    ['captured branch-creation drift', (evidence) => { evidence.githubEvidence.terminal_worktree_capture.payload.git_relationship.branch_creation_sha = 'f'.repeat(40); }],
    ['captured Worker tree drift', (evidence) => { evidence.githubEvidence.terminal_worktree_capture.payload.worker.tree_sha = 'f'.repeat(40); }],
    ['missing Orchestrator provenance', (evidence) => { delete evidence.githubEvidence.terminal_worktree_capture.payload.orchestrator_provenance; }],
    ['release check on another HEAD', (evidence) => { evidence.repositoryEvidence.current_main_sha = 'f'.repeat(40); }],
    ['release check on another tree', (evidence) => { evidence.repositoryEvidence.current_main_tree_sha = 'f'.repeat(40); }],
    ['live branch creation timestamp drift', (evidence) => { evidence.repositoryEvidence.terminal_branch_creation_at = '2026-08-02T14:29:57.000Z'; }],
    ['AO Worker creation timestamp drift', (evidence) => { evidence.githubEvidence.terminal_worktree_capture.payload.git_relationship.worker_session_created_at = '2026-08-02T14:30:30.000Z'; }],
    ['forged supervisor ancestry', (evidence) => { evidence.githubEvidence.terminal_worktree_capture.payload.orchestrator_provenance.process_binding.current_process_is_descendant = false; }],
  ])('pre-merge verification rejects %s', (_name, mutate) => {
    const receipt = validPreMergeReceipt();
    const evidence = validPreMergeEvidence(receipt);
    mutate(evidence);
    expect(() => verifySelfHostingReceipt(receipt, {
      ...evidence,
      requirePublication: false,
      stage: 'pre_merge',
    })).toThrow();
  });

  it('captures Orchestrator-bound provenance through the pinned AO session', () => {
    const evidence = captureOrchestratorBoundWorktreeEvidence({
      sourceRoot: '/source',
      workerRoot: '/worker',
      workerSessionId: 'worker-terminal',
      orchestratorSessionId: 'or-terminal',
      runtimeBinary: P0_R08_TERMINAL_RUNTIME_BINARY,
      env: { AO_SESSION_ID: 'or-terminal', AO_PROJECT_ID: 'ao-pilot-remediation', AO_ISSUE_ID: '63', AO_RUNTIME_LAUNCH_ID: 'launch-or-terminal' },
      capturedAt: '2026-08-04T01:45:00.000Z',
      sessionGet: (_binary, args) => ({
        session: args[2] === 'worker-terminal' ? {
          id: 'worker-terminal',
          projectId: 'ao-pilot-remediation',
          issueId: '63',
          kind: 'worker',
          createdAt: '2026-08-02T14:29:56.794Z',
        } : {
          id: 'or-terminal',
          projectId: 'ao-pilot-remediation',
          issueId: '63',
          kind: 'orchestrator',
          activity: { state: 'active' },
          isTerminated: false,
        },
        args,
      }),
      probes: {
        resolveRuntimeBinary: () => P0_R08_TERMINAL_RUNTIME_BINARY,
        runtimeDigest: () => P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
        inspectAoSupervisorProcess: () => validSupervisorProcessBinding(),
        captureWorktreeEvidence: () => ({ schema_version: 'ao.workstation-worktree-evidence.v5', issue_number: 63 }),
      },
    });

    expect(evidence.orchestrator_provenance).toMatchObject({
      schema_version: ORCHESTRATOR_WORKTREE_PROVENANCE_SCHEMA_VERSION,
      session_id: 'or-terminal',
      worker_session_id: 'worker-terminal',
      kind: 'orchestrator',
      runtime_launch_id: 'launch-or-terminal',
      process_binding: validSupervisorProcessBinding(),
      operation: {
        capture: true,
        publish_issue_comment: true,
        read_back_exact_body: true,
      },
    });
  });

  it('rejects a correct exported environment without AO supervisor process ancestry', () => {
    expect(() => captureOrchestratorBoundWorktreeEvidence({
      sourceRoot: '/source',
      workerRoot: '/worker',
      workerSessionId: 'worker-terminal',
      orchestratorSessionId: 'or-terminal',
      runtimeBinary: P0_R08_TERMINAL_RUNTIME_BINARY,
      env: { AO_SESSION_ID: 'or-terminal', AO_PROJECT_ID: 'ao-pilot-remediation', AO_ISSUE_ID: '63', AO_RUNTIME_LAUNCH_ID: 'launch-or-terminal' },
      sessionGet: (_binary, args) => ({ session: args[2] === 'worker-terminal' ? {
        id: 'worker-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind: 'worker', createdAt: '2026-08-02T14:29:56.794Z',
      } : {
        id: 'or-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind: 'orchestrator', activity: { state: 'active' }, isTerminated: false,
      } }),
      probes: {
        resolveRuntimeBinary: () => P0_R08_TERMINAL_RUNTIME_BINARY,
        runtimeDigest: () => P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
        inspectAoSupervisorProcess: () => { throw new Error('not a descendant'); },
        captureWorktreeEvidence: () => ({}),
      },
    })).toThrow('not a descendant');
  });

  it('derives the pinned AO supervisor identity from the current process ancestry', () => {
    const command = Buffer.from(`${P0_R08_TERMINAL_RUNTIME_BINARY}\0agent-process\0supervise\0--session\0or-terminal\0--launch\0launch-or-terminal\0--\0codex\0`);
    const records = new Map([
      [30, { pid: 30, parentPid: 20, startToken: 'child', executablePath: '/usr/bin/node', rawCommandLine: Buffer.from('node\0'), args: ['node'] }],
      [20, {
        pid: 20, parentPid: 1, startToken: '987654', executablePath: P0_R08_TERMINAL_RUNTIME_BINARY,
        rawCommandLine: command, args: command.toString().split('\0').filter(Boolean),
      }],
    ]);
    expect(inspectAoSupervisorProcess({
      runtimeBinary: P0_R08_TERMINAL_RUNTIME_BINARY,
      orchestratorSessionId: 'or-terminal',
      runtimeLaunchId: 'launch-or-terminal',
      currentPid: 30,
      readProcess: (pid) => records.get(pid),
      executableDigest: () => P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    })).toMatchObject({
      supervisor_pid: 20,
      supervisor_process_start_token: '987654',
      session_id: 'or-terminal',
      runtime_launch_id: 'launch-or-terminal',
      current_process_is_descendant: true,
    });
  });

  it.each([
    ['Worker shell binding', { AO_SESSION_ID: 'worker-terminal', AO_PROJECT_ID: 'ao-pilot-remediation', AO_ISSUE_ID: '63', AO_RUNTIME_LAUNCH_ID: 'launch-worker' }, 'orchestrator'],
    ['non-Orchestrator session', { AO_SESSION_ID: 'or-terminal', AO_PROJECT_ID: 'ao-pilot-remediation', AO_ISSUE_ID: '63', AO_RUNTIME_LAUNCH_ID: 'launch-or-terminal' }, 'worker'],
  ])('rejects Orchestrator-bound capture from %s', (_name, env, kind) => {
    expect(() => captureOrchestratorBoundWorktreeEvidence({
      sourceRoot: '/source',
      workerRoot: '/worker',
      workerSessionId: 'worker-terminal',
      orchestratorSessionId: 'or-terminal',
      runtimeBinary: P0_R08_TERMINAL_RUNTIME_BINARY,
      env,
      sessionGet: (_binary, args) => ({ session: args[2] === 'worker-terminal' ? {
        id: 'worker-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind: 'worker', createdAt: '2026-08-02T14:29:56.794Z',
      } : {
        id: 'or-terminal', projectId: 'ao-pilot-remediation', issueId: '63', kind,
        activity: { state: 'active' }, isTerminated: false,
      } }),
      probes: {
        resolveRuntimeBinary: () => P0_R08_TERMINAL_RUNTIME_BINARY,
        runtimeDigest: () => P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
        inspectAoSupervisorProcess: () => validSupervisorProcessBinding(),
        captureWorktreeEvidence: () => ({}),
      },
    })).toThrow();
  });

  it('publishes and reads back exact worktree evidence in one operation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-publication-'));
    const payloadPath = path.join(root, 'payload.json');
    const receiptPath = path.join(root, 'publication.json');
    const payload = { orchestrator_provenance: {
      session_id: 'or-terminal',
      runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    } };
    try {
      const result = publishOrchestratorBoundWorktreeEvidence({
        payload,
        payloadPath,
        publicationReceiptPath: receiptPath,
        publish: (candidate) => ({ id: 5159000000, body: fs.readFileSync(candidate, 'utf8') }),
        readBack: () => ({
          id: 5159000000,
          user: { login: 'Samsen879' },
          author_association: 'OWNER',
          created_at: '2026-08-04T01:46:00.000Z',
          updated_at: '2026-08-04T01:46:00.000Z',
          body: fs.readFileSync(payloadPath, 'utf8'),
        }),
        now: () => '2026-08-04T01:47:00.000Z',
      });
      expect(result).toMatchObject({
        schema_version: ORCHESTRATOR_WORKTREE_PUBLICATION_SCHEMA_VERSION,
        comment_id: 5159000000,
        exact_body_read_back: true,
        orchestrator_session_id: 'or-terminal',
      });
      expect(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).toEqual(result);
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('records read_back_at only after GitHub readback completes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-publication-clock-'));
    const payload = { orchestrator_provenance: {
      session_id: 'or-terminal',
      runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
      process_binding: validSupervisorProcessBinding(),
    } };
    let readBackCompleted = false;
    try {
      const result = publishOrchestratorBoundWorktreeEvidence({
        payload,
        payloadPath: path.join(root, 'payload.json'),
        publicationReceiptPath: path.join(root, 'publication.json'),
        publish: () => ({ id: 5159000002 }),
        readBack: () => {
          readBackCompleted = true;
          return {
            id: 5159000002,
            user: { login: 'Samsen879' }, author_association: 'OWNER',
            created_at: '2026-08-04T01:46:01.000Z', updated_at: '2026-08-04T01:46:01.000Z',
            body: JSON.stringify(payload, null, 2),
          };
        },
        now: () => {
          expect(readBackCompleted).toBe(true);
          return '2026-08-04T01:46:02.000Z';
        },
      });
      expect(result.read_back_at).toBe('2026-08-04T01:46:02.000Z');
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('fails closed when Orchestrator publication readback changes the payload', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-publication-drift-'));
    const payload = { orchestrator_provenance: {
      session_id: 'or-terminal',
      runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    } };
    try {
      expect(() => publishOrchestratorBoundWorktreeEvidence({
        payload,
        payloadPath: path.join(root, 'payload.json'),
        publicationReceiptPath: path.join(root, 'publication.json'),
        publish: () => ({ id: 5159000001 }),
        readBack: () => ({
          id: 5159000001,
          user: { login: 'Samsen879' },
          author_association: 'OWNER',
          created_at: '2026-08-04T01:46:00.000Z',
          updated_at: '2026-08-04T01:46:00.000Z',
          body: `${JSON.stringify(payload, null, 2)}\n`,
        }),
      })).toThrow('readback body differs');
    } finally {
      removeTemporaryRoot(root);
    }
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
        workerSession: {
          id: 'worker-r08', kind: 'worker', projectId: 'ao-pilot-remediation', issueId: '63',
          createdAt: new Date(Number(execFileSync('git', ['reflog', 'show', '--date=unix', '--format=%gD', 'refs/heads/ao/p0-r08/evidence-test'], { cwd: workerRoot, encoding: 'utf8' }).trim().match(/@\{(\d+)\}/)[1]) * 1000).toISOString(),
        },
        capturedAt: '2026-08-03T01:45:00.000Z',
      });
      expect(evidence).toMatchObject({
        schema_version: 'ao.workstation-worktree-evidence.v6',
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
      expect(evidence.worker.tree_sha).toBe(sourceTree);
      expect(evidence.git_relationship).toEqual({
        source_is_ancestor: true,
        merge_base_sha: sourceHead,
        branch_creation_sha: sourceHead,
        branch_creation_at: expect.any(String),
        branch_creation_subject: expect.stringContaining('branch: Created from'),
        worker_session_created_at: expect.any(String),
      });
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('rejects a same-clone Worker that forked before the admitted source HEAD', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-stale-fork-'));
    const sourceRoot = path.join(root, 'source');
    const workerRoot = path.join(root, 'worker');
    try {
      fs.mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.name', 'AO Test'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.email', 'ao-test@example.invalid'], { cwd: sourceRoot });
      fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'first\n');
      execFileSync('git', ['add', 'fixture.txt'], { cwd: sourceRoot });
      execFileSync('git', ['commit', '--quiet', '-m', 'test: first baseline'], { cwd: sourceRoot });
      fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'second\n');
      execFileSync('git', ['commit', '--quiet', '-am', 'test: admitted baseline'], { cwd: sourceRoot });
      execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'ao/p0-r08/stale-fork', workerRoot, 'HEAD~1'], { cwd: sourceRoot });

      expect(() => inspectWorktreeBinding({
        sourceRoot,
        workerRoot,
        workerSessionId: 'worker-stale',
        workerSession: {
          id: 'worker-stale', kind: 'worker', projectId: 'ao-pilot-remediation', issueId: '63',
          createdAt: new Date().toISOString(),
        },
      })).toThrow('did not fork from the admitted source HEAD');
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('rejects a stale-created Worker even after it merges the admitted source', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-stale-merged-fork-'));
    const sourceRoot = path.join(root, 'source');
    const workerRoot = path.join(root, 'worker');
    try {
      fs.mkdirSync(sourceRoot);
      execFileSync('git', ['init', '--quiet'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.name', 'AO Test'], { cwd: sourceRoot });
      execFileSync('git', ['config', 'user.email', 'ao-test@example.invalid'], { cwd: sourceRoot });
      fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'first\n');
      execFileSync('git', ['add', 'fixture.txt'], { cwd: sourceRoot });
      execFileSync('git', ['commit', '--quiet', '-m', 'test: stale base'], { cwd: sourceRoot });
      execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'ao/p0-r08/stale-merged', workerRoot], { cwd: sourceRoot });
      fs.writeFileSync(path.join(sourceRoot, 'fixture.txt'), 'admitted\n');
      execFileSync('git', ['commit', '--quiet', '-am', 'test: admitted source'], { cwd: sourceRoot });
      const admittedHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
      execFileSync('git', ['merge', '--quiet', '--no-edit', admittedHead], { cwd: workerRoot });

      expect(() => inspectWorktreeBinding({
        sourceRoot,
        workerRoot,
        workerSessionId: 'worker-stale-merged',
        workerSession: {
          id: 'worker-stale-merged', kind: 'worker', projectId: 'ao-pilot-remediation', issueId: '63', createdAt: new Date().toISOString(),
        },
      })).toThrow('branch creation reflog does not start at the admitted source HEAD');
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

  it.each([
    ['terminal admission comment drift', (receipt) => { receipt.terminal_remediation.admission.comment_id = 5158225895; }],
    ['terminal admission digest drift', (receipt) => { receipt.terminal_remediation.admission.comment_body_sha256 = 'f'.repeat(64); }],
    ['terminal admitted main drift', (receipt) => { receipt.terminal_remediation.admission.admitted_main_sha = 'f'.repeat(40); }],
    ['terminal admitted tree drift', (receipt) => { receipt.terminal_remediation.admission.admitted_tree_sha = 'f'.repeat(40); }],
    ['principal delivery substitution', (receipt) => { receipt.delivery.principal_pr.number = 72; }],
    ['remediation merge tree drift', (receipt) => { receipt.terminal_remediation.delivery.remediation_pr.merge_tree_sha = 'f'.repeat(40); }],
    ['resulting current main drift', (_receipt, evidence) => { evidence.repositoryEvidence.current_main_sha = 'f'.repeat(40); }],
    ['premature issue close', (_receipt, evidence) => { evidence.githubEvidence.issue_63.state = 'closed'; }],
  ])('fails closed for bounded terminal-remediation evidence: %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt, evidence);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
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

  it('collects a clean reaction from the observed live comment_id review-request shape', () => {
    const head = 'd04a4d132fd236e3b5e0a97552de6d5ae496d921';
    const lookedUp = [];
    const evidence = collectCodexReviewEvidence({
      comments: [{
        id: 5157760682,
        user: { login: 'Samsen879' },
        author_association: 'OWNER',
        body: `@codex review\n\nTarget HEAD: ${head}`,
        created_at: '2026-08-02T12:11:12Z',
        updated_at: '2026-08-02T12:11:12Z',
      }],
      reviews: [],
      reactionsForComment(commentId) {
        lookedUp.push(commentId);
        return [{
          user: { login: 'chatgpt-codex-connector[bot]' },
          content: '+1',
          created_at: '2026-08-02T12:12:00Z',
        }];
      },
    });

    expect(lookedUp).toEqual([5157760682]);
    expect(evidence).toEqual([expect.objectContaining({
      kind: 'clean_reaction',
      evidence_id: 5157760682,
      request_comment_id: 5157760682,
      head_sha: head,
      completed: true,
    })]);
  });

  it('collects the exact live PR #72 connector clean-comment completion without a reaction lookup', () => {
    const head = '0724ab9882846314e39845292ab86ef4aefb3c2b';
    const comments = [{
      id: 5158376025,
      user: { login: 'Samsen879' },
      author_association: 'OWNER',
      body: `Review request\n\nExact head: ${head}`,
      created_at: '2026-08-02T14:00:08Z',
      updated_at: '2026-08-02T14:00:08Z',
    }, {
      id: 5158396828,
      user: { login: 'chatgpt-codex-connector[bot]' },
      performed_via_github_app: { slug: 'chatgpt-codex-connector' },
      body: "Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** `0724ab9882`\n\n<details>clean completion details</details>",
      created_at: '2026-08-02T14:03:57Z',
      updated_at: '2026-08-02T14:03:57Z',
    }];
    comments[0].body = `@${'codex'} review\n\nExact head: ${head}`;
    const evidence = collectCodexReviewEvidence({
      comments,
      reviews: [],
      reactionsForComment() {
        throw new Error('reaction lookup must be suppressed by completed clean-comment evidence');
      },
    });

    expect(evidence).toEqual([{
      kind: 'clean_comment',
      evidence_id: 5158396828,
      request_comment_id: 5158376025,
      request_valid: true,
      head_sha: head,
      completed_at: '2026-08-02T14:03:57Z',
      actor: 'chatgpt-codex-connector[bot]',
      completed: true,
    }]);
  });

  it('collects the exact live PR #72 Review 2 clean-comment wording', () => {
    const head = P0_R08_FAILED_TERMINAL_HEAD;
    const evidence = collectCodexReviewEvidence({
      comments: [{
        id: 5158426324,
        user: { login: 'Samsen879' },
        author_association: 'OWNER',
        body: `@${'codex'} review\n\nExact head: ${head}\n\nFinal review request under issue #63 terminal-remediation admission. No Review 3.`,
        created_at: '2026-08-02T14:09:32Z',
        updated_at: '2026-08-02T14:09:32Z',
      }, {
        id: 5158456834,
        user: { login: 'chatgpt-codex-connector[bot]' },
        performed_via_github_app: { slug: 'chatgpt-codex-connector' },
        body: "Codex Review: Didn't find any major issues. You're on a roll.\n\n**Reviewed commit:** `054cf5f648`\n\n<details>clean completion details</details>",
        created_at: '2026-08-02T14:15:06Z',
        updated_at: '2026-08-02T14:15:06Z',
      }],
      reviews: [],
      reactionsForComment() {
        throw new Error('reaction lookup must be suppressed by completed clean-comment evidence');
      },
    });

    expect(evidence).toEqual([expect.objectContaining({
      kind: 'clean_comment',
      evidence_id: 5158456834,
      request_comment_id: 5158426324,
      head_sha: P0_R08_FAILED_TERMINAL_HEAD,
      completed: true,
    })]);
  });

  it.each([
    ['standing admission digest drift', (receipt) => { receipt.terminal_recovery_chain.standing_admission.comment_body_sha256 = 'f'.repeat(64); }],
    ['standing admission byte drift', (receipt) => { receipt.terminal_recovery_chain.standing_admission.comment_body_bytes = 3713; }],
    ['standing baseline drift', (receipt) => { receipt.terminal_recovery_chain.standing_admission.admitted_main_sha = 'f'.repeat(40); }],
    ['widened attempt authority', (receipt) => { receipt.terminal_recovery_chain.standing_admission.max_additional_recovery_attempts = 3; }],
    ['unordered attempts', (receipt) => { receipt.terminal_recovery_chain.attempts.reverse(); }],
    ['arbitrary extra attempt', (receipt) => { receipt.terminal_recovery_chain.attempts.push({ attempt: 4 }); }],
    ['missing failed Review 2', (receipt) => { receipt.terminal_recovery_chain.attempts[0].pr.codex_reviews.pop(); }],
    ['rewritten failed disposition', (receipt) => { receipt.terminal_recovery_chain.attempts[0].disposition = 'passed'; }],
    ['missing failed gate', (receipt) => { receipt.terminal_recovery_chain.attempts[0].failure.premerge_worktree_evidence_published = true; }],
    ['rewritten PR #73 disposition', (receipt) => { receipt.terminal_recovery_chain.attempts[1].disposition = 'passed'; }],
    ['missing PR #73 finding evidence', (receipt) => { receipt.terminal_recovery_chain.attempts[1].pr.finding_comment_ids.pop(); }],
    ['drifted PR #73 merge provenance', (receipt) => { receipt.terminal_recovery_chain.attempts[1].failure.ao_merge_executed = true; }],
    ['reused failed PR as recovery', (receipt) => { receipt.terminal_recovery_chain.attempts[2].pr_number = 73; }],
    ['unbound attempt evidence', (receipt) => { receipt.terminal_recovery_chain.attempts[2].worktree_evidence_comment_id = 999; }],
    ['arbitrary chain field', (receipt) => { receipt.terminal_recovery_chain.extra = true; }],
    ['arbitrary attempt field', (receipt) => { receipt.terminal_recovery_chain.attempts[2].extra = true; }],
    ['missing final admission', (receipt) => { delete receipt.runtime_transition.admission; }],
    ['drifted runtime tag object', (receipt) => { receipt.runtime_transition.successor.tag_object_sha = 'f'.repeat(40); }],
    ['arbitrary runtime transition field', (receipt) => { receipt.runtime_transition.successor.extra = true; }],
  ])('fails closed for ordered recovery-chain violation: %s', (_name, mutate) => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    mutate(receipt);
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow();
  });

  it('rejects recovery worktree evidence that omits its chain position', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    delete evidence.githubEvidence.terminal_worktree_capture.payload.recovery_chain;
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('ordered final recovery attempt 3');
  });

  it.each([
    ['wrong actor', (comment) => { comment.user.login = 'Samsen879'; }],
    ['missing connector app provenance', (comment) => { comment.performed_via_github_app = null; }],
    ['edited completion', (comment) => { comment.updated_at = '2026-08-02T14:04:00Z'; }],
    ['generic connector body', (comment) => { comment.body = 'Review completed successfully.'; }],
    ['too-short reviewed commit', (comment) => { comment.body = "Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** `0724ab988`"; }],
    ['unrelated reviewed commit', (comment) => { comment.body = "Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** `fffffffffff`"; }],
  ])('rejects clean-comment evidence with %s before reaction collection', (_name, mutate) => {
    const head = '0724ab9882846314e39845292ab86ef4aefb3c2b';
    const requests = ownerExactHeadReviewRequests([{
      id: 5158376025,
      user: { login: 'Samsen879' },
      author_association: 'OWNER',
      body: `@${'codex'} review\n\nExact head: ${head}`,
      created_at: '2026-08-02T14:00:08Z',
      updated_at: '2026-08-02T14:00:08Z',
    }]);
    const comment = {
      id: 5158396828,
      user: { login: 'chatgpt-codex-connector[bot]' },
      performed_via_github_app: { slug: 'chatgpt-codex-connector' },
      body: "Codex Review: Didn't find any major issues. :+1:\n\n**Reviewed commit:** `0724ab9882`",
      created_at: '2026-08-02T14:03:57Z',
      updated_at: '2026-08-02T14:03:57Z',
    };
    mutate(comment);
    expect(cleanCodexReviewCommentEvidence([comment], requests)).toEqual([]);
  });

  it('rejects the observed generic connector review object before reaction lookup', () => {
    const head = 'd04a4d132fd236e3b5e0a97552de6d5ae496d921';
    const lookedUp = [];
    const evidence = collectCodexReviewEvidence({
      comments: [{
        id: 5157760682,
        user: { login: 'Samsen879' },
        author_association: 'OWNER',
        body: `@codex review\n\nTarget HEAD: ${head}`,
        created_at: '2026-08-02T12:11:12Z',
        updated_at: '2026-08-02T12:11:12Z',
      }],
      reviews: [{
        id: 4838383320,
        user: { login: 'chatgpt-codex-connector[bot]' },
        body: '',
        commit_id: head,
        submitted_at: '2026-08-02T12:10:53Z',
        state: 'COMMENTED',
      }],
      reactionsForComment(commentId) {
        lookedUp.push(commentId);
        return [];
      },
    });

    expect(lookedUp).toEqual([5157760682]);
    expect(evidence).toEqual([]);
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

  it('accepts an exact-head connector clean-comment completion in the receipt', () => {
    const receipt = validSelfHostingReceipt();
    receipt.terminal_remediation.delivery.remediation_pr.codex_reviews[0].kind = 'clean_comment';
    const evidence = validEvidence(receipt);
    expect(verifySelfHostingReceipt(receipt, evidence)).toMatchObject({ terminal_review_count: 1 });
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

  it('resolves a not-yet-existing retry path through its nearest existing parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-path-parent-'));
    try {
      expect(resolvePathThroughFilesystem(path.join(root, 'missing', 'cache')))
        .toBe(path.join(fs.realpathSync(root), 'missing', 'cache'));
    } finally {
      removeTemporaryRoot(root);
    }
  });

  it('exposes a symlinked retry path target instead of trusting its admitted spelling', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-path-root-'));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-r08-path-external-'));
    try {
      fs.symlinkSync(external, path.join(root, 'cache'));
      expect(resolvePathThroughFilesystem(path.join(root, 'cache', 'missing')))
        .toBe(path.join(fs.realpathSync(external), 'missing'));
      expect(() => assertPathResolvesWithin(root, path.join(root, 'cache', 'missing'), 'runtime cache'))
        .toThrow('runtime cache filesystem target escapes the retry root');
    } finally {
      removeTemporaryRoot(root);
      removeTemporaryRoot(external);
    }
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
      repository: 'Samsen879/ao-pilot',
      number: 75,
      url: 'https://github.com/Samsen879/ao-pilot/pull/75',
      created_at: '2026-08-02T12:30:00.000Z',
      head_ref: 'ao/p0-r08-extra-retry',
      base_ref: 'main',
    });
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('exactly one post-admission retry principal PR');
  });

  it('accepts the live layered issue-linked shape with sole principal PR #71 then ordered recovery PRs #72, #73, and #74', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);

    expect(evidence.githubEvidence.issue_linked_prs.map((linkedPr) => linkedPr.number)).toEqual([71, 72, 73, 74]);
    expect(verifySelfHostingReceipt(receipt, evidence)).toMatchObject({
      principal_pr: 71,
      terminal_remediation_pr: 74,
    });
  });

  it('rejects an arbitrary extra linked delivery in the terminal recovery layer', () => {
    const receipt = validSelfHostingReceipt();
    const evidence = validEvidence(receipt);
    evidence.githubEvidence.issue_linked_prs.splice(3, 0, {
      repository: 'Samsen879/ao-pilot',
      number: 75,
      url: 'https://github.com/Samsen879/ao-pilot/pull/75',
      created_at: '2026-08-03T08:31:00.000Z',
      head_ref: 'ao/p0-r08-arbitrary-extra-delivery',
      base_ref: 'main',
    });

    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('exactly one admitted terminal-remediation PR');
  });

  it('excludes cross-referenced pull requests from external repositories before dedupe and count', () => {
    const timeline = {
      pageInfo: { hasNextPage: false },
      nodes: [{ source: {
        __typename: 'PullRequest',
        repository: { nameWithOwner: 'external/fork' },
        number: 71,
        url: 'https://github.com/external/fork/pull/71',
        createdAt: '2026-08-02T12:30:00.000Z',
        headRefName: 'unrelated',
        baseRefName: 'main',
      } }, { source: {
        __typename: 'PullRequest',
        repository: { nameWithOwner: 'Samsen879/ao-pilot' },
        number: 71,
        url: 'https://github.com/Samsen879/ao-pilot/pull/71',
        createdAt: '2026-08-02T12:00:00.000Z',
        headRefName: 'ao/p0-r08-retry-worker',
        baseRefName: 'main',
      } }],
    };

    expect(issueLinkedPrEvidenceFromTimeline(timeline)).toEqual([expect.objectContaining({
      repository: 'Samsen879/ao-pilot',
      number: 71,
    })]);
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
    expect(() => verifySelfHostingReceipt(receipt, evidence)).toThrow('sole P0-R08 principal delivery');
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
