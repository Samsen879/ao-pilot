import { createHash } from 'node:crypto';

import {
  P0_R08_RUNTIME_COMMIT,
  P0_R08_RUNTIME_REF,
  P0_R08_RUNTIME_TREE,
  P0_R08_RUNTIME_X64_SHA256,
  P0_R08_TERMINAL_RUNTIME_BINARY,
  REQUIRED_CI_CHECKS,
} from './self-hosting-receipt.js';

export const AUDIT_RECOVERY_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v8';
export const AUDIT_RECOVERY_ADMISSION_COMMENT = 5173330402;
export const AUDIT_RECOVERY_ADMISSION_BYTES = 3765;
export const AUDIT_RECOVERY_ADMISSION_SHA256 = '4eda52b054ddda51d5c998c7f89d25a9006d50a966982cda8a30cf71c3ea66e5';
export const AUDIT_RECOVERY_ADMITTED_MAIN = 'fc616e318160ac23849d52af3a5f763eba9ffebf';
export const AUDIT_RECOVERY_ADMITTED_TREE = '379668d84df17b1f33e737abf12e66d5422a220f';
export const AUDIT_RECOVERY_PR = 75;
export const AUDIT_RECOVERY_WORKER_WORKTREE = '/home/guoqy/p0-r08-terminal-remediation/ao-state/data/worktrees/ao-pilot-remediation/ao-pilot-remediation-6';
export const AUDIT_RECOVERY_PREDECESSOR_PR = 74;
export const AUDIT_RECOVERY_PREDECESSOR_HEAD = '95804614581b5c1c72381f63b2c5057f73701aca';
export const AUDIT_RECOVERY_RECEIPT_COMMENT = 5169507539;
export const AUDIT_RECOVERY_RECEIPT_BYTES = 21541;
export const AUDIT_RECOVERY_RECEIPT_SHA256 = '67c40f2d76247ad49aa7561e9b6124b72a81a985e165e798aa91d6fbd8ef126e';
export const AUDIT_RECOVERY_FAILED_RUN = 30836059504;
export const AUDIT_RECOVERY_WORKFLOW_ID = 325479877;
export const AUDIT_RECOVERY_ATTEMPT_1_JOB = 91761405074;
export const AUDIT_RECOVERY_ATTEMPT_2_JOB = 91762073346;
export const AUDIT_RECOVERY_ADVISORY = 'GHSA-rgw5-rvv9-x895';
export const AUDIT_RECOVERY_PACKAGE = 'brace-expansion';
export const AUDIT_RECOVERY_AFFECTED_RANGE = '>=4.0.0 <5.0.9';
export const AUDIT_RECOVERY_PATCHED_VERSION = '5.0.9';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, field) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `Invalid ${field}`);
  return value;
}

function exactKeys(value, field, expected) {
  const item = object(value, field);
  assert(JSON.stringify(Object.keys(item).sort()) === JSON.stringify([...expected].sort()), `Invalid ${field} keys`);
  return item;
}

function sha(value, field) {
  assert(typeof value === 'string' && /^[0-9a-f]{40}$/.test(value), `Invalid ${field}`);
  return value;
}

function timestamp(value, field) {
  assert(typeof value === 'string' && !Number.isNaN(Date.parse(value)), `Invalid ${field}`);
  return value;
}

function truth(value, field) {
  assert(value === true, `${field} must be true`);
}

function falsehood(value, field) {
  assert(value === false, `${field} must be false`);
}

function verifyImmutableComment(declared, live, { id, bytes, digest, field }) {
  const item = exactKeys(declared, field, ['comment_id', 'body_bytes', 'body_sha256', 'created_at', 'updated_at']);
  assert(item.comment_id === id && item.body_bytes === bytes && item.body_sha256 === digest, `${field} immutable identity mismatch`);
  assert(item.created_at === item.updated_at, `${field} records an edited comment`);
  const observed = object(live, `live ${field}`);
  assert(observed.comment_id === id && observed.issue_number === 63, `Live ${field} identity mismatch`);
  assert(observed.author === 'Samsen879' && observed.author_association === 'OWNER', `Live ${field} is not Owner-authored`);
  assert(observed.body_bytes === bytes && observed.body_sha256 === digest, `Live ${field} bytes/digest drifted`);
  assert(observed.created_at === item.created_at && observed.updated_at === item.updated_at, `Live ${field} timestamp/edit state drifted`);
  timestamp(item.created_at, `${field}.created_at`);
  return item.created_at;
}

function verifyReviews(declared, live, mergedAt = null) {
  assert(Array.isArray(declared) && declared.length >= 1 && declared.length <= 2, 'Audit recovery requires one or two completed connector reviews');
  assert(Array.isArray(live) && live.filter((item) => item.completed === true).length === declared.length, 'Audit recovery review evidence is incomplete or extra');
  for (const [index, review] of declared.entries()) {
    const item = exactKeys(review, `audit recovery review ${index + 1}`, ['attempt', 'kind', 'evidence_id', 'request_comment_id', 'head_sha', 'completed_at']);
    assert(item.attempt === index + 1, 'Audit recovery review attempts are unordered');
    assert(['submitted_review', 'clean_comment', 'clean_reaction'].includes(item.kind), 'Unsupported audit recovery review kind');
    sha(item.head_sha, 'audit recovery review head');
    timestamp(item.completed_at, 'audit recovery review completed_at');
    const observed = live.find((candidate) => candidate.kind === item.kind && candidate.evidence_id === item.evidence_id);
    assert(observed?.actor === 'chatgpt-codex-connector[bot]' && observed.completed === true && observed.request_valid === true, `Audit recovery review ${item.attempt} lacks connector completion evidence`);
    assert(observed.request_comment_id === item.request_comment_id && observed.head_sha === item.head_sha && observed.completed_at === item.completed_at, `Audit recovery review ${item.attempt} drifted`);
    if (mergedAt != null) assert(Date.parse(item.completed_at) <= Date.parse(mergedAt), `Audit recovery review ${item.attempt} completed after merge`);
  }
}

function verifyProcessBinding(value, { sessionId, launchId }, field) {
  const binding = exactKeys(value, field, [
    'supervisor_pid', 'supervisor_process_start_token', 'supervisor_executable_path',
    'supervisor_executable_sha256', 'supervisor_command_sha256', 'session_id',
    'runtime_launch_id', 'current_process_is_descendant',
  ]);
  assert(Number.isSafeInteger(binding.supervisor_pid) && binding.supervisor_pid > 1, `${field} supervisor PID is invalid`);
  assert(typeof binding.supervisor_process_start_token === 'string' && binding.supervisor_process_start_token !== '', `${field} process start token is invalid`);
  assert(binding.supervisor_executable_path === P0_R08_TERMINAL_RUNTIME_BINARY && binding.supervisor_executable_sha256 === P0_R08_RUNTIME_X64_SHA256, `${field} p0.2 executable provenance mismatch`);
  assert(/^[0-9a-f]{64}$/.test(binding.supervisor_command_sha256), `${field} supervisor command digest is invalid`);
  assert(binding.session_id === sessionId && binding.runtime_launch_id === launchId && binding.current_process_is_descendant === true, `${field} session/launch ancestry mismatch`);
  return binding;
}

function verifyPublication(value, live, { commentId, orchestratorSessionId, processBinding, field }) {
  const publication = exactKeys(value, field, [
    'schema_version', 'issue_number', 'comment_id', 'published_at', 'read_back_at',
    'payload_bytes', 'payload_sha256', 'exact_body_read_back', 'orchestrator_session_id',
    'runtime_binary_path', 'runtime_binary_sha256', 'process_binding',
  ]);
  assert(publication.issue_number === 63 && publication.comment_id === commentId && publication.orchestrator_session_id === orchestratorSessionId, `${field} identity mismatch`);
  assert(publication.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && publication.runtime_binary_sha256 === P0_R08_RUNTIME_X64_SHA256, `${field} p0.2 runtime mismatch`);
  assert(publication.exact_body_read_back === true && publication.payload_bytes === live.body_bytes && publication.payload_sha256 === live.body_sha256, `${field} exact readback/digest mismatch`);
  assert(publication.published_at === live.created_at && Date.parse(timestamp(publication.read_back_at, `${field}.read_back_at`)) >= Date.parse(live.created_at), `${field} publication/readback ordering mismatch`);
  assert(JSON.stringify(publication.process_binding) === JSON.stringify(processBinding), `${field} supervisor process binding drifted`);
}

function verifyFailedWorkflow(predecessor, github) {
  const workflow = exactKeys(predecessor.protected_workflow, 'predecessor.protected_workflow', [
    'run_id', 'workflow_id', 'event', 'head_sha', 'status', 'conclusion', 'run_attempt',
    'created_at', 'updated_at', 'attempt_jobs', 'failure',
  ]);
  assert(workflow.run_id === AUDIT_RECOVERY_FAILED_RUN && workflow.workflow_id === AUDIT_RECOVERY_WORKFLOW_ID, 'Failed protected workflow identity mismatch');
  assert(workflow.event === 'workflow_dispatch' && workflow.head_sha === AUDIT_RECOVERY_ADMITTED_MAIN, 'Failed protected workflow source mismatch');
  assert(workflow.status === 'completed' && workflow.conclusion === 'failure' && workflow.run_attempt === 2, 'Predecessor workflow must remain failed after two attempts');
  assert(workflow.created_at === '2026-08-03T17:17:16Z' && workflow.updated_at === '2026-08-03T17:21:27Z', 'Failed protected workflow timestamps drifted');
  assert(JSON.stringify(workflow.attempt_jobs) === JSON.stringify([AUDIT_RECOVERY_ATTEMPT_1_JOB, AUDIT_RECOVERY_ATTEMPT_2_JOB]), 'Failed protected workflow job chain mismatch');
  const failure = exactKeys(workflow.failure, 'predecessor.protected_workflow.failure', [
    'failed_step', 'audit_advisory', 'package', 'affected_range', 'observed_version',
    'patched_version', 'high_vulnerability_count', 'fix_available',
  ]);
  assert(failure.failed_step === 'verify:self-hosting/npm run release:check/npm audit', 'Predecessor failure step was recharacterized');
  assert(failure.audit_advisory === AUDIT_RECOVERY_ADVISORY && failure.package === AUDIT_RECOVERY_PACKAGE, 'Predecessor audit advisory/package mismatch');
  assert(failure.affected_range === AUDIT_RECOVERY_AFFECTED_RANGE && failure.observed_version === '5.0.8' && failure.patched_version === AUDIT_RECOVERY_PATCHED_VERSION, 'Predecessor affected/patched version evidence mismatch');
  assert(failure.high_vulnerability_count === 1 && failure.fix_available === true, 'Predecessor npm audit result mismatch');

  const liveRun = object(github.failed_protected_run, 'live failed protected run');
  for (const key of ['id', 'workflow_id', 'event', 'head_sha', 'status', 'conclusion', 'run_attempt', 'created_at', 'updated_at']) {
    const receiptKey = key === 'id' ? 'run_id' : key;
    assert(liveRun[key] === workflow[receiptKey], `Live failed protected run ${key} drifted`);
  }
  assert(Array.isArray(github.failed_protected_jobs) && github.failed_protected_jobs.length === 2, 'Both protected workflow attempt jobs are required');
  const jobs = [...github.failed_protected_jobs].sort((left, right) => left.run_attempt - right.run_attempt);
  for (const [index, expectedId] of workflow.attempt_jobs.entries()) {
    const job = jobs[index];
    assert(job.run_attempt === index + 1 && job.id === expectedId && job.name === 'verify-self-hosting-receipt' && job.conclusion === 'failure' && job.head_sha === AUDIT_RECOVERY_ADMITTED_MAIN, `Protected workflow attempt ${index + 1} job drifted`);
    const failedSteps = job.steps.filter((step) => step.conclusion === 'failure');
    assert(failedSteps.length === 1 && failedSteps[0].name.includes('verify:self-hosting'), `Protected workflow attempt ${index + 1} did not fail only the verifier step`);
  }
  const retrySteps = jobs[1].steps;
  assert(retrySteps.some((step) => step.name === 'Run npm ci' && step.conclusion === 'success'), 'Protected workflow retry npm ci did not succeed');
  assert(retrySteps.some((step) => step.name === 'Materialize bounded workstation receipt' && step.conclusion === 'success'), 'Protected workflow retry receipt materialization did not succeed');
}

export function verifyAuditRecoveryReceipt(receipt, {
  repositoryEvidence,
  githubEvidence,
  publicationEvidence = null,
  requirePublication = true,
  stage = 'final',
} = {}) {
  const preMerge = stage === 'pre_merge';
  assert(['pre_merge', 'final'].includes(stage), 'Unsupported audit recovery verification stage');
  const value = exactKeys(receipt, 'audit recovery receipt', ['schema_version', 'status', 'performed_at', 'predecessor', 'audit_recovery', 'claim']);
  assert(value.schema_version === AUDIT_RECOVERY_RECEIPT_SCHEMA_VERSION, 'Unsupported audit recovery receipt schema');
  assert(value.status === (preMerge ? 'pending' : 'passed'), `Audit recovery receipt status is invalid for ${stage}`);
  timestamp(value.performed_at, 'performed_at');
  const repository = object(repositoryEvidence, 'repository evidence');
  const github = object(githubEvidence, 'GitHub evidence');
  assert(github.issue_63?.number === 63 && github.issue_63?.state === 'open', 'Issue #63 must remain open through audit recovery receipt verification');

  const predecessor = exactKeys(value.predecessor, 'predecessor', ['receipt', 'pr', 'protected_workflow']);
  verifyImmutableComment(predecessor.receipt, github.predecessor_receipt, {
    id: AUDIT_RECOVERY_RECEIPT_COMMENT, bytes: AUDIT_RECOVERY_RECEIPT_BYTES,
    digest: AUDIT_RECOVERY_RECEIPT_SHA256, field: 'predecessor.receipt',
  });
  const parsedPrior = object(github.predecessor_receipt.payload, 'immutable predecessor receipt payload');
  assert(parsedPrior.schema_version === 'ao.workstation-self-hosting-receipt.v7' && parsedPrior.status === 'passed', 'Immutable predecessor receipt is not the published v7 PASS payload');
  assert(parsedPrior.terminal_remediation?.delivery?.remediation_pr?.number === AUDIT_RECOVERY_PREDECESSOR_PR, 'Immutable predecessor receipt does not bind PR #74');
  assert(parsedPrior.terminal_remediation.delivery.remediation_pr.head_sha === AUDIT_RECOVERY_PREDECESSOR_HEAD, 'Immutable predecessor PR #74 head drifted');
  assert(parsedPrior.terminal_remediation.delivery.remediation_pr.merge_sha === AUDIT_RECOVERY_ADMITTED_MAIN && parsedPrior.terminal_remediation.delivery.remediation_pr.merge_tree_sha === AUDIT_RECOVERY_ADMITTED_TREE, 'Immutable predecessor receipt main/tree drifted');
  const priorPr = exactKeys(predecessor.pr, 'predecessor.pr', ['number', 'head_sha', 'merge_sha', 'merge_tree_sha']);
  assert(priorPr.number === AUDIT_RECOVERY_PREDECESSOR_PR && priorPr.head_sha === AUDIT_RECOVERY_PREDECESSOR_HEAD && priorPr.merge_sha === AUDIT_RECOVERY_ADMITTED_MAIN && priorPr.merge_tree_sha === AUDIT_RECOVERY_ADMITTED_TREE, 'Declared predecessor PR #74 evidence mismatch');
  const livePriorPr = object(github.predecessor_pr, 'live predecessor PR #74');
  assert(livePriorPr.number === priorPr.number && livePriorPr.merged === true && livePriorPr.head_sha === priorPr.head_sha && livePriorPr.merge_sha === priorPr.merge_sha && livePriorPr.merge_tree_sha === priorPr.merge_tree_sha, 'Live immutable PR #74 evidence drifted');
  verifyFailedWorkflow(predecessor, github);

  const recovery = exactKeys(value.audit_recovery, 'audit_recovery', ['admission', 'source', 'runtime', 'delivery', 'premerge_verification', 'merge_execution', 'exact_main_replay', 'cleanup']);
  const admittedAt = verifyImmutableComment(recovery.admission, github.audit_recovery_admission, {
    id: AUDIT_RECOVERY_ADMISSION_COMMENT, bytes: AUDIT_RECOVERY_ADMISSION_BYTES,
    digest: AUDIT_RECOVERY_ADMISSION_SHA256, field: 'audit_recovery.admission',
  });
  const source = exactKeys(recovery.source, 'audit_recovery.source', ['repository', 'head_sha', 'tree_sha']);
  assert(source.repository === 'https://github.com/Samsen879/ao-pilot.git' && source.head_sha === AUDIT_RECOVERY_ADMITTED_MAIN && source.tree_sha === AUDIT_RECOVERY_ADMITTED_TREE, 'Audit recovery source is not exact admitted main/tree');
  assert(repository.source_commit_sha === source.head_sha && repository.source_tree_sha === source.tree_sha, 'Local admitted source evidence drifted');
  assert(repository.brace_expansion_override === AUDIT_RECOVERY_PATCHED_VERSION && repository.brace_expansion_lock_version === AUDIT_RECOVERY_PATCHED_VERSION, 'Audit recovery checkout is not pinned to brace-expansion 5.0.9');
  assert(repository.brace_expansion_lock_integrity === 'sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==', 'brace-expansion 5.0.9 lock integrity drifted');
  assert(repository.release_check_passed === true && repository.audit_vulnerability_total === 0, 'Audit recovery exact checkout did not pass release:check and npm audit');
  const runtime = exactKeys(recovery.runtime, 'audit_recovery.runtime', ['runtime_ref', 'commit_sha', 'tree_sha', 'binary_sha256']);
  assert(runtime.runtime_ref === P0_R08_RUNTIME_REF && runtime.commit_sha === P0_R08_RUNTIME_COMMIT && runtime.tree_sha === P0_R08_RUNTIME_TREE && runtime.binary_sha256 === P0_R08_RUNTIME_X64_SHA256, 'Audit recovery did not preserve exact p0.2 runtime provenance');

  const delivery = exactKeys(recovery.delivery, 'audit_recovery.delivery', [
    'orchestrator_session_id', 'worker_session_id', 'worker_created_by_ao',
    'worker_created_from_issue', 'worker_worktree_path', 'worker_branch', 'worktree_evidence_comment_id',
    'worktree_evidence_publication', 'pr',
  ]);
  assert(delivery.orchestrator_session_id !== delivery.worker_session_id, 'Audit recovery Orchestrator and Worker must be distinct');
  truth(delivery.worker_created_by_ao, 'audit_recovery.delivery.worker_created_by_ao');
  truth(delivery.worker_created_from_issue, 'audit_recovery.delivery.worker_created_from_issue');
  assert(delivery.worker_worktree_path === AUDIT_RECOVERY_WORKER_WORKTREE, 'Audit recovery Worker worktree is not the exact AO-managed Worker6 path');
  assert(delivery.worker_branch === 'ao/p0-r08-audit-recovery', 'Audit recovery Worker branch mismatch');
  const pr = exactKeys(delivery.pr, 'audit_recovery.delivery.pr', ['number', 'url', 'head_sha', 'reviewed_head', 'ci_conclusion', 'codex_reviews', 'finding_dispositions', 'post_review_2_repair', 'merged', 'merge_sha', 'merge_tree_sha']);
  assert(pr.number === AUDIT_RECOVERY_PR && pr.url === 'https://github.com/Samsen879/ao-pilot/pull/75', 'Audit recovery must use PR #75 only');
  const finalHead = sha(pr.head_sha, 'audit recovery PR head');
  const reviewedHead = sha(pr.reviewed_head, 'audit recovery PR reviewed head');
  assert(repository.source_is_ancestor === true && repository.merge_base_sha === source.head_sha, 'Audit recovery local admitted ancestry evidence mismatch');
  if (preMerge) assert(repository.current_commit_sha === finalHead, 'Audit recovery pre-merge verification is not on the exact PR head');
  const livePr = object(github.audit_recovery_pr, 'live audit recovery PR #75');
  assert(livePr.number === AUDIT_RECOVERY_PR && livePr.base_ref === 'main' && livePr.head_ref === delivery.worker_branch && livePr.head_sha === finalHead, 'Live audit recovery PR identity/head drifted');
  assert(livePr.linked_issue_63 === true && livePr.auto_closes_issue_63 === false, 'PR #75 must link but not auto-close issue #63');
  assert(livePr.binds_audit_admission === true && livePr.binds_predecessor_receipt === true && livePr.binds_failed_workflow === true && livePr.binds_predecessor_pr_74 === true, 'PR #75 body omits required audit-recovery predecessor bindings');
  assert(Date.parse(timestamp(livePr.created_at, 'audit recovery PR created_at')) >= Date.parse(admittedAt), 'PR #75 predates Owner audit admission');
  assert(Array.isArray(github.issue_linked_prs), 'Live issue-linked PR evidence is unavailable');
  const auditAttempts = github.issue_linked_prs.filter((candidate) => candidate.repository === 'Samsen879/ao-pilot' && Date.parse(candidate.created_at) >= Date.parse(admittedAt));
  assert(auditAttempts.length === 1 && auditAttempts[0].number === AUDIT_RECOVERY_PR, 'Issue #63 must have exactly one post-admission audit recovery PR and no PR #76');
  assert(pr.ci_conclusion === 'success', 'Audit recovery PR CI is not green');
  for (const checkName of REQUIRED_CI_CHECKS) assert(github.audit_check_runs.some((check) => check.name === checkName && check.conclusion === 'success'), `Audit recovery required CI is not green: ${checkName}`);
  verifyReviews(pr.codex_reviews, github.audit_codex_reviews, preMerge ? null : livePr.merged_at);
  assert(Array.isArray(github.audit_codex_review_requests) && github.audit_codex_review_requests.length === pr.codex_reviews.length, 'Audit recovery has an extra, missing, or pending Owner review request');
  for (const review of pr.codex_reviews) {
    const request = github.audit_codex_review_requests.find((item) => item.comment_id === review.request_comment_id);
    assert(request?.head_sha === review.head_sha, `Audit recovery review ${review.attempt} request/head binding drifted`);
  }
  assert(Array.isArray(pr.finding_dispositions) && Array.isArray(github.audit_review_findings), 'Audit recovery finding evidence is unavailable');
  assert(JSON.stringify(pr.finding_dispositions.map((item) => [item.comment_id, item.review_id]).sort()) === JSON.stringify(github.audit_review_findings.map((item) => [item.comment_id, item.review_id]).sort()), 'Audit recovery finding dispositions are incomplete, extra, or duplicated');
  for (const finding of pr.finding_dispositions) {
    const live = github.audit_review_findings.find((item) => item.comment_id === finding.comment_id && item.review_id === finding.review_id);
    assert(finding.disposition === 'fixed' && finding.resolved === true && live?.resolved === true, `Audit recovery finding ${finding.comment_id} is unresolved`);
  }
  if (finalHead !== reviewedHead) {
    const repair = object(pr.post_review_2_repair, 'audit recovery post_review_2_repair');
    assert(pr.codex_reviews.length === 2 && repair.authorization_ref === 'https://github.com/Samsen879/ao-pilot/issues/63#issuecomment-5173330402' && repair.final_head_sha === finalHead, 'Audit recovery post-Review-2 repair is unauthorized or unbound');
    assert(repository.reviewed_head_is_ancestor === true && repository.reviewed_head_merge_base_sha === reviewedHead, 'Audit recovery final head does not descend from Review 2 head');
  } else assert(pr.post_review_2_repair == null, 'Unexpected audit recovery post-Review-2 repair');

  const worktree = object(github.audit_worktree_capture, 'audit recovery worktree evidence');
  assert(worktree.comment_id === delivery.worktree_evidence_comment_id && worktree.issue_number === 63 && worktree.author === 'Samsen879' && worktree.author_association === 'OWNER', 'Audit recovery worktree evidence identity mismatch');
  assert(worktree.created_at === worktree.updated_at && Date.parse(worktree.created_at) >= Date.parse(admittedAt), 'Audit recovery worktree evidence was edited or predates admission');
  assert(worktree.payload?.source?.head_sha === source.head_sha && worktree.payload?.source?.tree_sha === source.tree_sha, 'Audit recovery worktree source evidence drifted');
  assert(worktree.payload?.worker?.session_id === delivery.worker_session_id && worktree.payload?.worker?.worktree_path === delivery.worker_worktree_path && worktree.payload?.worker?.branch === delivery.worker_branch && worktree.payload?.worker?.head_sha === finalHead, 'Audit recovery Worker evidence drifted');
  assert(worktree.payload?.schema_version === 'ao.workstation-worktree-evidence.v7', 'Unsupported audit recovery worktree evidence schema');
  assert(worktree.payload?.recovery_chain?.attempt === 4 && worktree.payload?.recovery_chain?.standing_admission_comment_id === AUDIT_RECOVERY_ADMISSION_COMMENT && worktree.payload?.recovery_chain?.prior_attempt_pr_number === AUDIT_RECOVERY_PREDECESSOR_PR, 'Audit recovery worktree evidence is outside the admitted attempt chain');
  assert(worktree.payload?.recovery_chain?.admitted_main_sha === source.head_sha && worktree.payload?.recovery_chain?.admitted_tree_sha === source.tree_sha, 'Audit recovery worktree admitted source binding drifted');
  assert(worktree.payload?.orchestrator_provenance?.session_id === delivery.orchestrator_session_id && worktree.payload?.orchestrator_provenance?.runtime_binary_sha256 === runtime.binary_sha256, 'Audit recovery Orchestrator/runtime evidence drifted');
  const provenance = exactKeys(worktree.payload.orchestrator_provenance, 'audit recovery Orchestrator provenance', [
    'schema_version', 'session_id', 'worker_session_id', 'project_id', 'issue_number',
    'kind', 'activity_state', 'is_terminated', 'runtime_launch_id', 'runtime_binary_path',
    'runtime_binary_sha256', 'process_binding', 'session_get', 'operation',
  ]);
  assert(provenance.worker_session_id === delivery.worker_session_id && provenance.project_id === 'ao-pilot-remediation' && provenance.issue_number === 63 && provenance.kind === 'orchestrator', 'Audit recovery AO session provenance mismatch');
  assert(provenance.activity_state === 'active' && provenance.is_terminated === false && provenance.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY, 'Audit recovery worktree was not captured by active p0.2 AO');
  const processBinding = verifyProcessBinding(provenance.process_binding, { sessionId: delivery.orchestrator_session_id, launchId: provenance.runtime_launch_id }, 'audit recovery worktree process binding');
  verifyPublication(delivery.worktree_evidence_publication, worktree, {
    commentId: worktree.comment_id, orchestratorSessionId: delivery.orchestrator_session_id,
    processBinding, field: 'audit_recovery.delivery.worktree_evidence_publication',
  });

  if (preMerge) {
    falsehood(pr.merged, 'audit_recovery.delivery.pr.merged');
    assert(pr.merge_sha == null && pr.merge_tree_sha == null && recovery.premerge_verification == null && recovery.merge_execution == null, 'Pending audit recovery claims post-merge evidence');
    falsehood(recovery.exact_main_replay.passed, 'audit_recovery.exact_main_replay.passed');
    falsehood(recovery.exact_main_replay.release_check_passed, 'audit_recovery.exact_main_replay.release_check_passed');
    falsehood(recovery.exact_main_replay.audit_passed, 'audit_recovery.exact_main_replay.audit_passed');
    assert(recovery.exact_main_replay.main_sha == null && recovery.exact_main_replay.tree_sha == null, 'Pending audit recovery claims replay SHA/tree');
    assert(recovery.cleanup.orchestrator_done_evidence_comment_id === 0 && recovery.cleanup.cleanup_evidence_comment_id === 0, 'Pending audit recovery claims cleanup comments');
    for (const field of ['orchestrator_done', 'orchestrator_session_stopped', 'worker_session_stopped', 'worker_worktree_removed', 'remote_worker_branch_removed', 'project_removed', 'daemon_stopped', 'leases_absent', 'stale_ownership_absent']) falsehood(recovery.cleanup[field], `audit_recovery.cleanup.${field}`);
    falsehood(value.claim.p0_r08_satisfied, 'claim.p0_r08_satisfied');
    assert(publicationEvidence == null && requirePublication === false, 'Pre-merge audit verification cannot accept receipt publication');
    return { status: 'premerge_verified', schema_version: value.schema_version, issue_number: 63, audit_recovery_pr: 75, reviewed_head: reviewedHead, review_count: pr.codex_reviews.length, worktree_evidence_comment: worktree.comment_id, orchestrator_session_id: delivery.orchestrator_session_id };
  }

  truth(pr.merged, 'audit_recovery.delivery.pr.merged');
  const mergeSha = sha(pr.merge_sha, 'audit recovery merge SHA');
  const mergeTree = sha(pr.merge_tree_sha, 'audit recovery merge tree');
  assert(livePr.merged === true && livePr.merge_sha === mergeSha && livePr.merge_tree_sha === mergeTree, 'Audit recovery merge outcome drifted');
  const preflight = object(github.audit_premerge_capture, 'audit recovery premerge evidence');
  assert(preflight.comment_id === recovery.premerge_verification.evidence_comment_id && preflight.created_at === preflight.updated_at && Date.parse(preflight.created_at) <= Date.parse(livePr.merged_at), 'Audit recovery premerge evidence is missing, edited, or post-merge');
  assert(preflight.payload?.schema_version === 'ao.workstation-premerge-verification-evidence.v3' && preflight.payload?.status === 'premerge_verified' && preflight.payload?.recovery_attempt === 4, 'Unsupported audit recovery premerge payload');
  assert(preflight.payload?.standing_admission_comment_id === AUDIT_RECOVERY_ADMISSION_COMMENT && preflight.payload?.remediation_pr?.number === 75 && preflight.payload?.remediation_pr?.head_sha === finalHead, 'Audit recovery premerge payload drifted');
  assert(JSON.stringify(preflight.payload?.orchestrator_provenance) === JSON.stringify(provenance), 'Audit recovery premerge Orchestrator provenance drifted');
  verifyPublication(recovery.premerge_verification.publication, preflight, {
    commentId: preflight.comment_id, orchestratorSessionId: delivery.orchestrator_session_id,
    processBinding, field: 'audit_recovery.premerge_verification.publication',
  });
  const merge = object(github.audit_merge_capture, 'audit recovery AO merge evidence');
  assert(merge.comment_id === recovery.merge_execution.evidence_comment_id && merge.created_at === merge.updated_at, 'Audit recovery AO merge evidence is missing or edited');
  assert(merge.payload?.recovery_attempt === 4 && merge.payload?.effect?.pr_number === 75, 'Audit recovery AO merge evidence is outside attempt 4/PR #75');
  assert(merge.payload?.command?.args?.join(' ') === 'pr merge 75' && merge.payload?.command?.runtime_binary_sha256 === runtime.binary_sha256, 'Audit recovery merge did not use exact p0.2 AO command');
  assert(merge.payload?.effect?.exact_head_guarded === true && merge.payload?.effect?.ao_merge_executed === true && merge.payload?.effect?.github_readback_confirmed === true, 'Audit recovery AO merge effect provenance is incomplete');
  assert(merge.payload?.effect?.head_sha === finalHead && merge.payload?.effect?.merge_commit_sha === mergeSha && merge.payload?.effect?.main_tree_sha === mergeTree, 'Audit recovery AO merge effect drifted');
  assert(JSON.stringify(merge.payload?.orchestrator_provenance) === JSON.stringify(provenance) && JSON.stringify(merge.payload?.execution_binding?.process_binding) === JSON.stringify(processBinding), 'Audit recovery AO merge supervisor provenance drifted');
  verifyPublication(recovery.merge_execution.publication, merge, {
    commentId: merge.comment_id, orchestratorSessionId: delivery.orchestrator_session_id,
    processBinding, field: 'audit_recovery.merge_execution.publication',
  });
  truth(recovery.exact_main_replay.passed, 'audit_recovery.exact_main_replay.passed');
  truth(recovery.exact_main_replay.release_check_passed, 'audit_recovery.exact_main_replay.release_check_passed');
  truth(recovery.exact_main_replay.audit_passed, 'audit_recovery.exact_main_replay.audit_passed');
  assert(recovery.exact_main_replay.main_sha === mergeSha && recovery.exact_main_replay.tree_sha === mergeTree && repository.current_commit_sha === mergeSha && repository.current_tree_sha === mergeTree, 'Audit recovery exact-main replay drifted');
  const cleanup = exactKeys(recovery.cleanup, 'audit_recovery.cleanup', [
    'orchestrator_done', 'orchestrator_done_evidence_comment_id', 'cleanup_evidence_comment_id',
    'orchestrator_session_stopped', 'worker_session_stopped', 'worker_worktree_removed',
    'remote_worker_branch_removed', 'project_removed', 'daemon_stopped', 'leases_absent',
    'stale_ownership_absent',
  ]);
  for (const field of ['orchestrator_done', 'orchestrator_session_stopped', 'worker_session_stopped', 'worker_worktree_removed', 'remote_worker_branch_removed', 'project_removed', 'daemon_stopped', 'leases_absent', 'stale_ownership_absent']) truth(cleanup[field], `audit_recovery.cleanup.${field}`);
  const done = object(github.audit_orchestrator_done_capture, 'audit recovery Orchestrator-done evidence');
  assert(done.comment_id === cleanup.orchestrator_done_evidence_comment_id && done.author === 'Samsen879' && done.author_association === 'OWNER' && done.created_at === done.updated_at && done.payload?.orchestrator_session_id === delivery.orchestrator_session_id, 'Audit recovery durable Orchestrator-done evidence drifted');
  assert(Date.parse(done.created_at) >= Date.parse(livePr.merged_at), 'Audit recovery Orchestrator-done evidence predates merge');
  assert(done.payload?.schema_version === 'ao.orchestrator-done-evidence.v1' && done.payload?.issue_number === 63, 'Unsupported audit recovery Orchestrator-done evidence');
  assert(done.payload?.command?.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && done.payload?.command?.exit_code === 0 && JSON.stringify(done.payload?.command?.args) === JSON.stringify(['orchestrator', 'done', '--session', delivery.orchestrator_session_id]), 'Audit recovery Orchestrator-done command provenance mismatch');
  const cleanupEvidence = object(github.audit_cleanup_capture, 'audit recovery cleanup evidence');
  assert(cleanupEvidence.comment_id === cleanup.cleanup_evidence_comment_id && cleanupEvidence.created_at === cleanupEvidence.updated_at && cleanupEvidence.author === 'Samsen879' && cleanupEvidence.author_association === 'OWNER', 'Audit recovery cleanup evidence identity/edit state mismatch');
  assert(Date.parse(cleanupEvidence.created_at) >= Date.parse(done.created_at), 'Audit recovery cleanup evidence predates durable Orchestrator completion');
  const cleanupPayload = exactKeys(cleanupEvidence.payload, 'audit recovery cleanup payload', [
    'schema_version', 'issue_number', 'pr_number', 'orchestrator_session_stopped',
    'worker_session_stopped', 'worker_worktree_removed', 'remote_worker_branch_removed',
    'project_removed', 'daemon_stopped', 'leases_absent', 'stale_ownership_absent',
  ]);
  assert(cleanupPayload.schema_version === 'ao.workstation-audit-recovery-cleanup.v1' && cleanupPayload.issue_number === 63 && cleanupPayload.pr_number === 75, 'Audit recovery cleanup evidence schema/identity mismatch');
  for (const field of ['orchestrator_session_stopped', 'worker_session_stopped', 'worker_worktree_removed', 'remote_worker_branch_removed', 'project_removed', 'daemon_stopped', 'leases_absent', 'stale_ownership_absent']) assert(cleanupEvidence.payload?.[field] === cleanup[field], `Live audit cleanup ${field} drifted`);
  truth(value.claim.workstation_self_hosting, 'claim.workstation_self_hosting');
  truth(value.claim.p0_r08_satisfied, 'claim.p0_r08_satisfied');
  if (requirePublication) {
    assert(publicationEvidence?.issue_number === 63 && publicationEvidence?.author === 'Samsen879' && publicationEvidence?.exact_bytes_match === true, 'Audit recovery receipt publication/readback mismatch');
    assert(Date.parse(timestamp(publicationEvidence.created_at, 'audit recovery receipt publication created_at')) >= Date.parse(cleanupEvidence.created_at), 'Audit recovery receipt was published before cleanup evidence');
  } else assert(publicationEvidence == null, 'Prepublication audit verification must not accept publication evidence');
  return { status: requirePublication ? 'verified' : 'prepublication_verified', schema_version: value.schema_version, issue_number: 63, audit_recovery_pr: 75, merge_sha: mergeSha, review_count: pr.codex_reviews.length };
}

export function sha256Utf8(value) {
  return createHash('sha256').update(value).digest('hex');
}
