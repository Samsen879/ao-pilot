import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  captureOrchestratorBoundWorktreeEvidence,
} from './orchestrator-worktree-publication.js';
import {
  AUDIT_RECOVERY_ADMISSION_COMMENT,
  AUDIT_RECOVERY_ADMITTED_MAIN,
  AUDIT_RECOVERY_PR,
} from './audit-recovery-receipt.js';

export const PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-premerge-verification-evidence.v2';
export const AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-premerge-verification-evidence.v3';
export const PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION = 'ao.workstation-premerge-verification-publication.v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, field, expected) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `Invalid ${field}`);
  assert(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()), `Invalid ${field} keys`);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateAuditPremergeVerificationEvidence(payload, authority) {
  const value = exactKeys(payload, 'audit pre-merge evidence', [
    'schema_version', 'issue_number', 'verified_at', 'status',
    'standing_admission_comment_id', 'final_admission_comment_id', 'recovery_attempt',
    'remediation_pr', 'release_check', 'git_relationship', 'worktree_evidence',
    'orchestrator_provenance',
  ]);
  assert(value.schema_version === AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION && value.issue_number === 63 && value.status === 'premerge_verified', 'Unsupported or unsuccessful audit pre-merge evidence');
  assert(!Number.isNaN(Date.parse(value.verified_at)), 'Invalid audit pre-merge verification timestamp');
  assert(value.standing_admission_comment_id === AUDIT_RECOVERY_ADMISSION_COMMENT && value.final_admission_comment_id === AUDIT_RECOVERY_ADMISSION_COMMENT && value.recovery_attempt === 4, 'Audit pre-merge evidence is outside Owner admission/attempt 4');
  const pr = exactKeys(value.remediation_pr, 'audit pre-merge remediation_pr', [
    'number', 'head_sha', 'tree_sha', 'reviewed_head', 'review_evidence_ids',
    'resolved_finding_comment_ids',
  ]);
  assert(pr.number === AUDIT_RECOVERY_PR && /^[0-9a-f]{40}$/.test(pr.head_sha) && /^[0-9a-f]{40}$/.test(pr.tree_sha) && /^[0-9a-f]{40}$/.test(pr.reviewed_head), 'Audit pre-merge PR/head/tree evidence is invalid');
  assert(Array.isArray(pr.review_evidence_ids) && pr.review_evidence_ids.length >= 1 && pr.review_evidence_ids.length <= 2 && pr.review_evidence_ids.every((id) => Number.isSafeInteger(id) && id > 0), 'Audit pre-merge review evidence IDs are incomplete or invalid');
  assert(new Set(pr.review_evidence_ids).size === pr.review_evidence_ids.length, 'Audit pre-merge review evidence IDs are duplicated');
  assert(Array.isArray(pr.resolved_finding_comment_ids) && pr.resolved_finding_comment_ids.every((id) => Number.isSafeInteger(id) && id > 0), 'Audit pre-merge finding disposition IDs are invalid');
  assert(new Set(pr.resolved_finding_comment_ids).size === pr.resolved_finding_comment_ids.length, 'Audit pre-merge finding disposition IDs are duplicated');
  const release = exactKeys(value.release_check, 'audit pre-merge release_check', ['command', 'checkout_head_sha', 'checkout_tree_sha', 'passed']);
  assert(release.command === 'npm run release:check' && release.checkout_head_sha === pr.head_sha && release.checkout_tree_sha === pr.tree_sha && release.passed === true, 'Audit pre-merge release check did not pass on the guarded head/tree');
  const relationship = exactKeys(value.git_relationship, 'audit pre-merge git_relationship', [
    'reviewed_head_is_ancestor', 'reviewed_head_merge_base_sha', 'source_is_ancestor',
    'source_merge_base_sha', 'branch_creation_sha', 'branch_creation_at',
  ]);
  assert(relationship.reviewed_head_is_ancestor === true && relationship.reviewed_head_merge_base_sha === pr.reviewed_head, 'Audit pre-merge reviewed-head ancestry is invalid');
  assert(relationship.source_is_ancestor === true && relationship.source_merge_base_sha === AUDIT_RECOVERY_ADMITTED_MAIN && relationship.branch_creation_sha === AUDIT_RECOVERY_ADMITTED_MAIN, 'Audit pre-merge admitted-source ancestry is invalid');
  assert(!Number.isNaN(Date.parse(relationship.branch_creation_at)), 'Audit pre-merge branch creation timestamp is invalid');
  const worktree = exactKeys(value.worktree_evidence, 'audit pre-merge worktree_evidence', [
    'comment_id', 'published_at', 'payload_bytes', 'payload_sha256',
    'publication_schema_version', 'publication_read_back_at', 'publication_process_binding',
  ]);
  assert(Number.isSafeInteger(worktree.comment_id) && worktree.comment_id > 0 && Number.isSafeInteger(worktree.payload_bytes) && worktree.payload_bytes > 0 && /^[0-9a-f]{64}$/.test(worktree.payload_sha256), 'Audit pre-merge worktree publication identity is invalid');
  assert(!Number.isNaN(Date.parse(worktree.published_at)) && !Number.isNaN(Date.parse(worktree.publication_read_back_at)) && Date.parse(worktree.publication_read_back_at) >= Date.parse(worktree.published_at), 'Audit pre-merge worktree publication ordering is invalid');
  assert(worktree.publication_schema_version === 'ao.workstation-orchestrator-worktree-publication.v2', 'Unsupported audit worktree publication schema');
  assert(authority?.worker?.head_sha === pr.head_sha && authority?.worker?.tree_sha === pr.tree_sha, 'Audit pre-merge evidence does not guard the current AO Worker head/tree');
  assert(JSON.stringify(value.orchestrator_provenance) === JSON.stringify(authority?.orchestrator_provenance), 'Audit pre-merge evidence does not match the current p0.2 Orchestrator provenance');
  assert(JSON.stringify(worktree.publication_process_binding) === JSON.stringify(authority?.orchestrator_provenance?.process_binding), 'Audit pre-merge worktree publication process differs from the current Orchestrator');
  return value;
}

export function createPremergeVerificationEvidence({ receipt, result, evidence, verifiedAt = new Date().toISOString() }) {
  assert(result?.status === 'premerge_verified', 'Cannot persist an unsuccessful pre-merge verification');
  assert(!Number.isNaN(Date.parse(verifiedAt)), 'Invalid pre-merge verification timestamp');
  const auditRecovery = receipt.audit_recovery ?? null;
  const delivery = auditRecovery?.delivery ?? receipt.terminal_remediation.delivery;
  const remediationPr = delivery.pr ?? delivery.remediation_pr;
  const repository = evidence.repositoryEvidence;
  const worktreeCapture = auditRecovery == null
    ? evidence.githubEvidence.terminal_worktree_capture
    : evidence.githubEvidence.audit_worktree_capture;
  const publication = delivery.worktree_evidence_publication;
  return {
    schema_version: auditRecovery == null
      ? PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION
      : AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    issue_number: 63,
    verified_at: verifiedAt,
    status: result.status,
    standing_admission_comment_id: auditRecovery == null ? 5158510418 : 5173330402,
    final_admission_comment_id: auditRecovery == null ? 5163994984 : 5173330402,
    recovery_attempt: auditRecovery == null ? 3 : 4,
    remediation_pr: {
      number: remediationPr.number,
      head_sha: remediationPr.head_sha,
      tree_sha: repository.current_main_tree_sha ?? repository.current_tree_sha,
      reviewed_head: remediationPr.reviewed_head,
      review_evidence_ids: remediationPr.codex_reviews.map((review) => review.evidence_id),
      resolved_finding_comment_ids: remediationPr.finding_dispositions.map((finding) => finding.comment_id),
    },
    release_check: {
      command: 'npm run release:check',
      checkout_head_sha: repository.current_main_sha ?? repository.current_commit_sha,
      checkout_tree_sha: repository.current_main_tree_sha ?? repository.current_tree_sha,
      passed: repository.release_check_passed === true,
    },
    git_relationship: {
      reviewed_head_is_ancestor: repository.terminal_reviewed_head_is_ancestor ?? repository.reviewed_head_is_ancestor,
      reviewed_head_merge_base_sha: repository.terminal_reviewed_head_merge_base_sha ?? repository.reviewed_head_merge_base_sha,
      source_is_ancestor: repository.terminal_source_is_ancestor ?? repository.source_is_ancestor,
      source_merge_base_sha: repository.terminal_merge_base_sha ?? repository.merge_base_sha,
      branch_creation_sha: repository.terminal_branch_creation_sha ?? repository.branch_creation_sha ?? auditRecovery?.source.head_sha,
      branch_creation_at: repository.terminal_branch_creation_at ?? repository.branch_creation_at ?? worktreeCapture.payload?.git_relationship?.branch_creation_at,
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
  assert([PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION, AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION].includes(payload.schema_version) && payload.issue_number === 63, 'Unsupported pre-merge verification evidence');
  assert(payload.status === 'premerge_verified', 'Pre-merge evidence does not record a successful gate');
  if (payload.schema_version === AUDIT_PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION) validateAuditPremergeVerificationEvidence(payload, authority);
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
