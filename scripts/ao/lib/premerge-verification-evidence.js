import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  captureOrchestratorBoundWorktreeEvidence,
} from './orchestrator-worktree-publication.js';

export const PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-premerge-verification-evidence.v2';
export const PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION = 'ao.workstation-premerge-verification-publication.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createPremergeVerificationEvidence({ receipt, result, evidence, verifiedAt = new Date().toISOString() }) {
  assert(result?.status === 'premerge_verified', 'Cannot persist an unsuccessful pre-merge verification');
  assert(!Number.isNaN(Date.parse(verifiedAt)), 'Invalid pre-merge verification timestamp');
  const delivery = receipt.terminal_remediation.delivery;
  const remediationPr = delivery.remediation_pr;
  const repository = evidence.repositoryEvidence;
  const worktreeCapture = evidence.githubEvidence.terminal_worktree_capture;
  const publication = delivery.worktree_evidence_publication;
  return {
    schema_version: PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    issue_number: 63,
    verified_at: verifiedAt,
    status: result.status,
    standing_admission_comment_id: 5158510418,
    final_admission_comment_id: 5163994984,
    recovery_attempt: 3,
    remediation_pr: {
      number: remediationPr.number,
      head_sha: remediationPr.head_sha,
      tree_sha: repository.current_main_tree_sha,
      reviewed_head: remediationPr.reviewed_head,
      review_evidence_ids: remediationPr.codex_reviews.map((review) => review.evidence_id),
      resolved_finding_comment_ids: remediationPr.finding_dispositions.map((finding) => finding.comment_id),
    },
    release_check: {
      command: 'npm run release:check',
      checkout_head_sha: repository.current_main_sha,
      checkout_tree_sha: repository.current_main_tree_sha,
      passed: repository.release_check_passed === true,
    },
    git_relationship: {
      reviewed_head_is_ancestor: repository.terminal_reviewed_head_is_ancestor,
      reviewed_head_merge_base_sha: repository.terminal_reviewed_head_merge_base_sha,
      source_is_ancestor: repository.terminal_source_is_ancestor,
      source_merge_base_sha: repository.terminal_merge_base_sha,
      branch_creation_sha: repository.terminal_branch_creation_sha,
      branch_creation_at: repository.terminal_branch_creation_at,
    },
    worktree_evidence: {
      comment_id: worktreeCapture.comment_id,
      published_at: worktreeCapture.created_at,
      payload_bytes: worktreeCapture.body_bytes,
      payload_sha256: worktreeCapture.body_sha256,
      publication_schema_version: publication.schema_version,
      publication_read_back_at: publication.read_back_at,
      publication_process_binding: publication.process_binding,
    },
    orchestrator_provenance: worktreeCapture.payload.orchestrator_provenance,
  };
}

function defaultPublish(payloadPath) {
  return JSON.parse(execFileSync('gh', [
    'api', '--method', 'POST', 'repos/Samsen879/ao-pilot/issues/63/comments',
    '-F', `body=@${payloadPath}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

function defaultReadBack(commentId) {
  return JSON.parse(execFileSync('gh', [
    'api', `repos/Samsen879/ao-pilot/issues/comments/${commentId}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

export function publishOrchestratorBoundPremergeEvidence({
  evidencePath,
  publicationReceiptPath,
  authorityOptions,
  publish = defaultPublish,
  readBack = defaultReadBack,
  now = () => new Date().toISOString(),
}) {
  const authority = captureOrchestratorBoundWorktreeEvidence(authorityOptions);
  const resolvedEvidencePath = path.resolve(evidencePath);
  const raw = fs.readFileSync(resolvedEvidencePath, 'utf8');
  const payload = JSON.parse(raw);
  assert(raw === JSON.stringify(payload, null, 2), 'Pre-merge evidence is not canonical no-trailing-newline JSON');
  assert(payload.schema_version === PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION && payload.issue_number === 63, 'Unsupported pre-merge verification evidence');
  assert(payload.status === 'premerge_verified', 'Pre-merge evidence does not record a successful gate');
  assert(payload.remediation_pr.head_sha === authority.worker.head_sha && payload.remediation_pr.tree_sha === authority.worker.tree_sha, 'Pre-merge evidence does not match the current AO Worker head/tree');
  assert(payload.orchestrator_provenance.session_id === authority.orchestrator_provenance.session_id, 'Pre-merge evidence belongs to a different Orchestrator');
  assert(payload.orchestrator_provenance.process_binding.supervisor_process_start_token === authority.orchestrator_provenance.process_binding.supervisor_process_start_token, 'Pre-merge evidence was not produced by the current Orchestrator supervisor process');

  const published = publish(resolvedEvidencePath);
  assert(Number.isSafeInteger(published?.id) && published.id > 0, 'GitHub did not return a pre-merge evidence comment ID');
  const observed = readBack(published.id);
  assert(observed?.id === published.id, 'Pre-merge evidence readback returned the wrong comment');
  assert(observed?.user?.login === 'Samsen879' && observed?.author_association === 'OWNER', 'Pre-merge evidence was not published by the Owner credential');
  assert(observed?.created_at === observed?.updated_at, 'Published pre-merge evidence was edited');
  assert(observed?.body === raw, 'Pre-merge evidence readback body differs from the published payload');
  const publishedAtMilliseconds = Date.parse(observed.created_at);
  assert(!Number.isNaN(publishedAtMilliseconds), 'Published pre-merge evidence has an invalid created_at timestamp');
  const sampledAfterReadBack = now();
  const sampledAfterReadBackMilliseconds = Date.parse(sampledAfterReadBack);
  assert(!Number.isNaN(sampledAfterReadBackMilliseconds), 'Invalid post-readback timestamp sample');
  const readBackAt = new Date(Math.max(publishedAtMilliseconds, sampledAfterReadBackMilliseconds)).toISOString();
  const receipt = {
    schema_version: PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION,
    issue_number: 63,
    comment_id: observed.id,
    published_at: observed.created_at,
    read_back_at: readBackAt,
    payload_bytes: Buffer.byteLength(raw, 'utf8'),
    payload_sha256: sha256(raw),
    exact_body_read_back: true,
    orchestrator_session_id: authority.orchestrator_provenance.session_id,
    runtime_binary_path: authority.orchestrator_provenance.runtime_binary_path,
    runtime_binary_sha256: authority.orchestrator_provenance.runtime_binary_sha256,
    process_binding: authority.orchestrator_provenance.process_binding,
  };
  assert(Date.parse(receipt.read_back_at) >= publishedAtMilliseconds, 'Pre-merge evidence readback timestamp predates publication');
  fs.writeFileSync(path.resolve(publicationReceiptPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}
