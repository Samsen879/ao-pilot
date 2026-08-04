import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  P0_R08_FINAL_RECOVERY_PR,
  P0_R08_TERMINAL_RUNTIME_BINARY,
  P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
  TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION,
  TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION,
} from './self-hosting-receipt.js';
import { captureOrchestratorBoundWorktreeEvidence } from './orchestrator-worktree-publication.js';
import { PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION } from './premerge-verification-evidence.js';
import {
  AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  collectAuthenticatedAuditPremergeEvidence,
  validateAuditPremergeVerificationEvidence,
} from './premerge-verification-evidence.js';
import { AUDIT_RECOVERY_PR } from './audit-recovery-receipt.js';

export const TERMINAL_MERGE_OPERATION_SCHEMA_VERSION = 'ao.workstation-terminal-merge-operation.v1';
const HELPER_SOURCE_PATH = new URL('./terminal-merge-publication.js', import.meta.url);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function defaultReadIssueComment(commentId) {
  return JSON.parse(execFileSync('gh', ['api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function defaultExecuteMerge(runtimeBinary, args) {
  return execFileSync(runtimeBinary, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function defaultReadPull(prNumber = AUDIT_RECOVERY_PR) {
  return JSON.parse(execFileSync('gh', ['api', `repos/Samsen879/ao-pilot/pulls/${prNumber}`], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function defaultReadMain() {
  return JSON.parse(execFileSync('gh', ['api', 'repos/Samsen879/ao-pilot/commits/main'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function defaultPublish(payloadPath) {
  return JSON.parse(execFileSync('gh', [
    'api', '--method', 'POST', 'repos/Samsen879/ao-pilot/issues/63/comments',
    '-F', `body=@${payloadPath}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

export function executeAndPublishTerminalMergeEvidence({
  premergeCommentId,
  premergePayloadSha256,
  payloadPath,
  publicationReceiptPath,
  authorityOptions,
  readIssueComment = defaultReadIssueComment,
  executeMerge = defaultExecuteMerge,
  readPull = defaultReadPull,
  readMain = defaultReadMain,
  publish = defaultPublish,
  now = () => new Date().toISOString(),
  authenticateAuditPremerge = collectAuthenticatedAuditPremergeEvidence,
}) {
  assert(!fs.existsSync(path.resolve(payloadPath)) && !fs.existsSync(path.resolve(publicationReceiptPath)), 'AO merge evidence output paths must not exist before subprocess execution');
  const authority = captureOrchestratorBoundWorktreeEvidence(authorityOptions);
  const provenance = authority.orchestrator_provenance;
  assert(authority.worker?.head_sha != null, 'AO merge helper could not capture the current Worker HEAD');
  assert(Number.isSafeInteger(premergeCommentId) && premergeCommentId > 0, 'Invalid pre-merge evidence comment ID');
  assert(/^[0-9a-f]{64}$/.test(premergePayloadSha256), 'Invalid pre-merge evidence digest');

  const premerge = readIssueComment(premergeCommentId);
  const premergeRaw = premerge?.body ?? '';
  assert(premerge?.id === premergeCommentId, 'Pre-merge evidence readback returned the wrong comment');
  assert(premerge?.user?.login === 'Samsen879' && premerge?.author_association === 'OWNER', 'Pre-merge evidence has the wrong publication identity');
  assert(premerge?.created_at === premerge?.updated_at, 'Pre-merge evidence was edited');
  assert(sha256(premergeRaw) === premergePayloadSha256, 'Pre-merge evidence digest mismatch');
  const premergePayload = JSON.parse(premergeRaw);
  assert([PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION, AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION].includes(premergePayload.schema_version) && premergePayload.status === 'premerge_verified', 'Unsupported pre-merge evidence');
  const auditRecovery = premergePayload.schema_version === AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION;
  const recoveryPr = auditRecovery ? AUDIT_RECOVERY_PR : P0_R08_FINAL_RECOVERY_PR;
  if (auditRecovery) validateAuditPremergeVerificationEvidence(premergePayload, authority, authenticateAuditPremerge(authority));
  assert(premergePayload.remediation_pr?.number === recoveryPr, 'Pre-merge evidence targets the wrong PR');
  assert(premergePayload.remediation_pr?.head_sha === authority.worker.head_sha && premergePayload.remediation_pr?.tree_sha === authority.worker.tree_sha, 'Pre-merge evidence does not guard the current exact Worker HEAD/tree');
  assert(premergePayload.orchestrator_provenance?.session_id === provenance.session_id, 'Pre-merge evidence belongs to a different Orchestrator');
  assert(premergePayload.orchestrator_provenance?.process_binding?.supervisor_process_start_token === provenance.process_binding.supervisor_process_start_token, 'Pre-merge evidence belongs to a different Orchestrator supervisor process');
  const premergeReadAt = now();

  const args = ['pr', 'merge', String(recoveryPr)];
  const subprocessStartedAt = now();
  const stdout = executeMerge(P0_R08_TERMINAL_RUNTIME_BINARY, args);
  const subprocessCompletedAt = now();
  const expectedPrefix = `merged PR #${recoveryPr} using squash (head ${authority.worker.head_sha}, merge commit `;
  assert(typeof stdout === 'string' && stdout.startsWith(expectedPrefix) && stdout.endsWith(')'), 'Pinned AO merge stdout did not bind the guarded exact HEAD');
  const mergeCommitSha = stdout.slice(expectedPrefix.length, -1);
  assert(/^[0-9a-f]{40}$/.test(mergeCommitSha), 'Pinned AO merge stdout has an invalid merge commit');

  const pull = readPull(recoveryPr);
  const main = readMain();
  const githubReadAt = now();
  assert(pull?.number === recoveryPr && pull?.merged === true, `GitHub readback did not confirm PR #${recoveryPr} merged`);
  assert(pull?.head?.sha === authority.worker.head_sha && pull?.merge_commit_sha === mergeCommitSha, 'GitHub merge readback drifted from the AO subprocess result');
  assert(pull?.merged_at != null && !Number.isNaN(Date.parse(pull.merged_at)), 'GitHub merge readback lacks merged_at');
  assert(main?.sha === mergeCommitSha && /^[0-9a-f]{40}$/.test(main?.commit?.tree?.sha ?? ''), 'Exact main readback drifted from the AO merge result');
  const orderedTimes = [premergeReadAt, subprocessStartedAt, subprocessCompletedAt, githubReadAt].map(Date.parse);
  assert(orderedTimes.every((value) => !Number.isNaN(value)), 'AO merge helper sampled an invalid timestamp');
  assert(orderedTimes.every((value, index) => index === 0 || orderedTimes[index - 1] <= value), 'AO merge helper operation timestamps are out of order');
  assert(Date.parse(premerge.created_at) <= orderedTimes[0] && Date.parse(pull.merged_at) <= orderedTimes[3], 'AO merge helper readback timestamps do not enclose the immutable preflight and merge outcome');

  const payload = {
    schema_version: TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION,
    issue_number: 63,
    completed_at: githubReadAt,
    orchestrator_session_id: provenance.session_id,
    recovery_attempt: auditRecovery ? 4 : 3,
    premerge_evidence: { comment_id: premergeCommentId, payload_sha256: premergePayloadSha256 },
    command: {
      runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
      runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
      args,
      exit_code: 0,
      stdout,
    },
    effect: {
      provider_mutation: 'github_squash_merge',
      exact_head_guarded: true,
      ao_merge_executed: true,
      github_readback_confirmed: true,
      pr_number: recoveryPr,
      method: 'squash',
      head_sha: authority.worker.head_sha,
      merge_commit_sha: mergeCommitSha,
      main_sha: main.sha,
      main_tree_sha: main.commit.tree.sha,
    },
    execution_binding: {
      schema_version: TERMINAL_MERGE_OPERATION_SCHEMA_VERSION,
      helper: 'publish:self-hosting-merge',
      helper_source_sha256: sha256(fs.readFileSync(HELPER_SOURCE_PATH)),
      guarded_head_sha: authority.worker.head_sha,
      premerge_payload_sha256: premergePayloadSha256,
      subprocess_stdout_sha256: sha256(stdout),
      premerge_read_back_at: premergeReadAt,
      subprocess_started_at: subprocessStartedAt,
      subprocess_completed_at: subprocessCompletedAt,
      github_read_back_at: githubReadAt,
      process_binding: provenance.process_binding,
    },
    orchestrator_provenance: provenance,
  };
  const raw = JSON.stringify(payload, null, 2);
  fs.writeFileSync(path.resolve(payloadPath), raw, { flag: 'wx' });
  const published = publish(path.resolve(payloadPath));
  assert(Number.isSafeInteger(published?.id) && published.id > 0, 'GitHub did not return an AO merge-evidence comment ID');
  const observed = readIssueComment(published.id);
  assert(observed?.id === published.id, 'AO merge-evidence readback returned the wrong comment');
  assert(observed?.user?.login === 'Samsen879' && observed?.author_association === 'OWNER', 'AO merge evidence was not published by the Owner credential');
  assert(observed?.created_at === observed?.updated_at, 'Published AO merge evidence was edited');
  assert(observed?.body === raw, 'AO merge-evidence readback body differs from the helper payload');
  const readBackAt = now();
  assert(Date.parse(readBackAt) >= Date.parse(observed.created_at), 'AO merge-evidence readback timestamp predates publication');
  const receipt = {
    schema_version: TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION,
    issue_number: 63,
    comment_id: observed.id,
    published_at: observed.created_at,
    read_back_at: readBackAt,
    payload_bytes: Buffer.byteLength(raw, 'utf8'),
    payload_sha256: sha256(raw),
    exact_body_read_back: true,
    orchestrator_session_id: provenance.session_id,
    runtime_binary_path: P0_R08_TERMINAL_RUNTIME_BINARY,
    runtime_binary_sha256: P0_R08_TERMINAL_RUNTIME_BINARY_SHA256,
    process_binding: provenance.process_binding,
  };
  fs.writeFileSync(path.resolve(publicationReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return { payload, publication: receipt };
}
