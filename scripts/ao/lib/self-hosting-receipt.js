import fs from 'node:fs';
import path from 'node:path';

import { ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION } from './orchestrator-done-evidence.js';
import { loadRuntimeLock } from './runtime-lock.js';

export const SELF_HOSTING_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v2';
export const P0_R08_RETRY_ADMISSION_PR = 70;
export const P0_R08_RETRY_ADMISSION_ISSUE = 63;
export const P0_R08_RETRY_ADMISSION_COMMENT = 5157524210;
export const P0_R08_RETRY_ADMISSION_COMMENT_SHA256 = '0c06f002ef5044734721c72bfdce27d3c80baf2a4b9bf88d9263bf3d1e1a3b4b';
export const P0_R08_RETRY_ADMITTED_MAIN = 'd7bef70d16a881cbceb785b1541db67a1876de04';
export const P0_R08_RETRY_ADMITTED_TREE = 'e3553f50aba65c413d4a5063bfd4ceb4510e0166';
export const P0_R08_RETRY_ROOT = '/home/guoqy/p0-r08-retry-workstation';
export const P0_R08_RETRY_AO_DATA_DIR = `${P0_R08_RETRY_ROOT}/ao-state/data`;
export const P0_R08_RETRY_AO_RUN_FILE = `${P0_R08_RETRY_ROOT}/ao-state/running.json`;
export const P0_R08_RETRY_RUNTIME_STORE = `${P0_R08_RETRY_ROOT}/runtime-store`;
export const P0_R08_RETRY_RUNTIME_CACHE = `${P0_R08_RETRY_ROOT}/runtime-cache`;
export const WORKTREE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-worktree-evidence.v2';
export const REQUIRED_CI_CHECKS = ['fresh-clone-runtime', 'test (20)', 'test (22)'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, field) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `Invalid ${field}`);
  return value;
}

function string(value, field) {
  assert(typeof value === 'string' && value.trim() !== '', `Invalid ${field}`);
  return value.trim();
}

function sha(value, field) {
  const normalized = string(value, field).toLowerCase();
  assert(/^[0-9a-f]{40}$/.test(normalized), `Invalid ${field}`);
  return normalized;
}

function timestamp(value, field) {
  const normalized = string(value, field);
  assert(!Number.isNaN(Date.parse(normalized)), `Invalid ${field}`);
  return normalized;
}

function canonicalAbsolutePath(value, field) {
  const normalized = string(value, field);
  assert(path.isAbsolute(normalized) && path.normalize(normalized) === normalized, `${field} must be a canonical absolute path`);
  return normalized;
}

function pathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function truth(value, field) {
  assert(value === true, `${field} must be true`);
  return true;
}

function falsehood(value, field) {
  assert(value === false, `${field} must be false`);
  return false;
}

function verifyCompletedCodexReviews(receiptReviews, liveReviews) {
  assert(Array.isArray(receiptReviews) && receiptReviews.length >= 1 && receiptReviews.length <= 2, 'Self-hosting proof requires one or two completed Codex Reviews');
  assert(Array.isArray(liveReviews), 'Live Codex Review evidence is unavailable');
  const normalized = receiptReviews.map((review, index) => {
    const item = object(review, `codex_reviews[${index}]`);
    assert(item.attempt === index + 1, `Invalid codex_reviews[${index}].attempt`);
    assert(['submitted_review', 'clean_reaction'].includes(item.kind), `Invalid codex_reviews[${index}].kind`);
    const normalizedItem = {
      attempt: item.attempt,
      kind: item.kind,
      evidence_id: Number(item.evidence_id),
      request_comment_id: Number(item.request_comment_id),
      head_sha: sha(item.head_sha, `codex_reviews[${index}].head_sha`),
      completed_at: timestamp(item.completed_at, `codex_reviews[${index}].completed_at`),
    };
    assert(Number.isSafeInteger(normalizedItem.evidence_id) && normalizedItem.evidence_id > 0, `Invalid codex_reviews[${index}].evidence_id`);
    assert(Number.isSafeInteger(normalizedItem.request_comment_id) && normalizedItem.request_comment_id > 0, `Invalid codex_reviews[${index}].request_comment_id`);
    const live = liveReviews.find((candidate) => (
      candidate.kind === normalizedItem.kind
      && candidate.evidence_id === normalizedItem.evidence_id
    ));
    assert(live != null, `Codex Review attempt ${item.attempt} has no live completion evidence`);
    assert(live.actor === 'chatgpt-codex-connector[bot]', `Codex Review attempt ${item.attempt} has the wrong actor`);
    assert(live.request_valid === true, `Codex Review attempt ${item.attempt} lacks an owner-authored exact-head request`);
    assert(live.request_comment_id === normalizedItem.request_comment_id, `Codex Review attempt ${item.attempt} request comment mismatch`);
    assert(live.head_sha === normalizedItem.head_sha, `Codex Review attempt ${item.attempt} head mismatch`);
    assert(live.completed_at === normalizedItem.completed_at, `Codex Review attempt ${item.attempt} completion timestamp mismatch`);
    assert(live.completed === true, `Codex Review attempt ${item.attempt} is not completed`);
    return normalizedItem;
  });
  assert(new Set(normalized.map((review) => `${review.kind}:${review.evidence_id}`)).size === normalized.length, 'Duplicate Codex Review evidence');
  assert(new Set(normalized.map((review) => review.request_comment_id)).size === normalized.length, 'Duplicate Codex Review request evidence');
  const completedLiveReviews = liveReviews.filter((review) => review.completed === true);
  assert(completedLiveReviews.length <= 2, 'More than two completed Codex Reviews exist');
  assert(completedLiveReviews.length === normalized.length, 'Receipt omits completed Codex Review evidence');
  return normalized;
}

export function verifySelfHostingReceipt(receipt, {
  runtimeLock = loadRuntimeLock().lock,
  repositoryEvidence = null,
  githubEvidence = null,
  publicationEvidence = null,
  requirePublication = true,
} = {}) {
  const value = object(receipt, 'receipt');
  assert(value.schema_version === SELF_HOSTING_RECEIPT_SCHEMA_VERSION, 'Unsupported self-hosting receipt schema');
  assert(value.status === 'passed', 'Self-hosting receipt is not passed');
  timestamp(value.performed_at, 'performed_at');

  const environment = object(value.environment, 'environment');
  assert(environment.kind === 'fresh_workstation', 'Self-hosting proof must use a fresh workstation');
  falsehood(environment.old_home_read, 'environment.old_home_read');
  falsehood(environment.old_runtime_state_read, 'environment.old_runtime_state_read');
  falsehood(environment.credentials_copied, 'environment.credentials_copied');
  truth(environment.credentials_user_provided, 'environment.credentials_user_provided');
  falsehood(environment.global_npm_link_used, 'environment.global_npm_link_used');
  const retryRoot = canonicalAbsolutePath(environment.retry_root, 'environment.retry_root');
  const aoDataDir = canonicalAbsolutePath(environment.ao_data_dir, 'environment.ao_data_dir');
  const aoRunFile = canonicalAbsolutePath(environment.ao_run_file, 'environment.ao_run_file');
  const runtimeStore = canonicalAbsolutePath(environment.runtime_store, 'environment.runtime_store');
  const runtimeCache = canonicalAbsolutePath(environment.runtime_cache, 'environment.runtime_cache');
  assert(retryRoot === P0_R08_RETRY_ROOT, 'Retry root does not match the owner-admitted workstation root');
  assert(aoDataDir === P0_R08_RETRY_AO_DATA_DIR, 'AO_DATA_DIR is not retry-specific');
  assert(aoRunFile === P0_R08_RETRY_AO_RUN_FILE, 'AO_RUN_FILE is not retry-specific');
  assert(runtimeStore === P0_R08_RETRY_RUNTIME_STORE, 'Runtime store is not retry-specific');
  assert(runtimeCache === P0_R08_RETRY_RUNTIME_CACHE, 'Runtime cache is not retry-specific');
  for (const [field, candidate] of [['AO_DATA_DIR', aoDataDir], ['AO_RUN_FILE', aoRunFile], ['runtime store', runtimeStore], ['runtime cache', runtimeCache]]) {
    assert(pathWithin(retryRoot, candidate), `${field} escapes the retry root`);
  }

  const source = object(value.source, 'source');
  assert(source.repository === 'https://github.com/Samsen879/ao-pilot.git', 'Unexpected ao-pilot source repository');
  assert(source.admission_pr_number === P0_R08_RETRY_ADMISSION_PR, 'Source is not bound to historical P0-R08 PR #70');
  const sourceHead = sha(source.clone_head_sha, 'source.clone_head_sha');
  const sourceTree = sha(source.clone_tree_sha, 'source.clone_tree_sha');
  assert(sourceHead === P0_R08_RETRY_ADMITTED_MAIN, 'Fresh clone is not the exact admitted P0-R08 retry main');
  assert(sourceTree === P0_R08_RETRY_ADMITTED_TREE, 'Fresh clone tree is not the exact admitted P0-R08 retry tree');
  const sourceClonePath = canonicalAbsolutePath(source.clone_path, 'source.clone_path');
  assert(sourceClonePath === `${retryRoot}/ao-pilot`, 'Source clone is not the admitted retry clone');
  truth(source.clean_before_bootstrap, 'source.clean_before_bootstrap');

  const retryAdmission = object(value.retry_admission, 'retry_admission');
  assert(retryAdmission.issue_number === P0_R08_RETRY_ADMISSION_ISSUE, 'Retry admission is not bound to issue #63');
  assert(retryAdmission.comment_id === P0_R08_RETRY_ADMISSION_COMMENT, 'Retry admission comment ID mismatch');
  assert(retryAdmission.comment_body_sha256 === P0_R08_RETRY_ADMISSION_COMMENT_SHA256, 'Retry admission comment digest mismatch');
  assert(retryAdmission.historical_pr_number === P0_R08_RETRY_ADMISSION_PR, 'Retry admission historical PR mismatch');
  assert(sha(retryAdmission.historical_merge_sha, 'retry_admission.historical_merge_sha') === sourceHead, 'Retry admission historical merge mismatch');
  assert(sha(retryAdmission.historical_tree_sha, 'retry_admission.historical_tree_sha') === sourceTree, 'Retry admission historical tree mismatch');

  const repository = object(repositoryEvidence, 'repository evidence');
  assert(repository.source_commit_sha === sourceHead, 'Repository source commit evidence mismatch');
  assert(repository.source_tree_sha === sourceTree, 'Repository commit-to-tree binding mismatch');

  const github = object(githubEvidence, 'GitHub evidence');
  const admissionPr = object(github.admission_pr, 'GitHub admission PR');
  assert(admissionPr.number === P0_R08_RETRY_ADMISSION_PR && admissionPr.merged === true, 'Historical P0-R08 PR #70 is not merged');
  assert(admissionPr.base_ref === 'main', 'Historical P0-R08 PR #70 did not target main');
  assert(admissionPr.merge_sha === sourceHead, 'Fresh clone is not bound to the historical PR #70 merge SHA');

  const liveRetryAdmission = object(github.retry_admission, 'GitHub retry admission comment');
  assert(liveRetryAdmission.comment_id === retryAdmission.comment_id, 'Live retry admission comment ID mismatch');
  assert(liveRetryAdmission.issue_number === retryAdmission.issue_number, 'Retry admission comment was not published to issue #63');
  assert(liveRetryAdmission.author === 'Samsen879', 'Retry admission comment has the wrong author');
  assert(liveRetryAdmission.author_association === 'OWNER', 'Retry admission comment is not owner-authorized');
  const retryAdmittedAt = timestamp(liveRetryAdmission.created_at, 'retry admission comment created_at');
  assert(liveRetryAdmission.updated_at === retryAdmittedAt, 'Retry admission comment was edited after authorization');
  assert(liveRetryAdmission.body_sha256 === retryAdmission.comment_body_sha256, 'Live retry admission comment digest mismatch');

  const runtime = object(value.runtime, 'runtime');
  assert(runtime.runtime_ref === runtimeLock.runtime_ref, 'Runtime ref does not match the committed lock');
  assert(runtime.repository === runtimeLock.artifact.repository, 'Runtime repository does not match the committed lock');
  assert(runtime.version === runtimeLock.artifact.version, 'Runtime version does not match the committed lock');
  assert(runtime.tag === runtimeLock.artifact.ref.name, 'Runtime tag does not match the committed lock');
  assert(runtime.commit_sha === runtimeLock.artifact.ref.commit_sha, 'Runtime commit does not match the committed lock');
  assert(runtime.tree_sha === runtimeLock.artifact.ref.tree_sha, 'Runtime tree does not match the committed lock');
  assert(runtime.integrity?.algorithm === runtimeLock.artifact.integrity.algorithm, 'Runtime integrity algorithm mismatch');
  assert(runtime.integrity?.digest === runtimeLock.artifact.integrity.digest, 'Runtime integrity digest mismatch');
  const runtimeBinaryPath = canonicalAbsolutePath(runtime.binary_path, 'runtime.binary_path');
  assert(/^[0-9a-f]{64}$/.test(string(runtime.binary_sha256, 'runtime.binary_sha256')), 'Invalid runtime.binary_sha256');
  const runtimeTarget = object(runtime.target, 'runtime.target');
  const lockedTarget = runtimeLock.compatibility.platforms.find((target) => (
    target.os === runtimeTarget.os && target.arch === runtimeTarget.arch
  ));
  assert(lockedTarget != null, 'Runtime target is not supported by the lock');
  assert(lockedTarget.binary_sha256 === runtime.binary_sha256, 'Runtime binary digest does not match the workstation target');
  const expectedRuntimeBinary = `${runtimeStore}/${runtime.runtime_ref}/${runtimeTarget.os}-${runtimeTarget.arch}/${runtime.commit_sha}/bin/ao`;
  assert(runtimeBinaryPath === expectedRuntimeBinary, 'Runtime binary is not in the retry-specific managed store');

  const bootstrap = object(value.bootstrap, 'bootstrap');
  assert(bootstrap.command === './scripts/bootstrap.sh', 'Unexpected bootstrap command');
  assert(['installed', 'reused', 'reinstalled'].includes(bootstrap.status), 'Invalid bootstrap.status');
  assert(bootstrap.doctor_runtime_status === 'verified', 'Doctor did not verify the runtime');

  const delivery = object(value.delivery, 'delivery');
  assert(delivery.issue_number === 63, 'Self-hosting delivery must implement P0-R08 issue #63');
  const orchestratorSessionId = string(delivery.orchestrator_session_id, 'delivery.orchestrator_session_id');
  const workerSessionId = string(delivery.worker_session_id, 'delivery.worker_session_id');
  assert(orchestratorSessionId !== workerSessionId, 'Orchestrator and Worker session IDs must be distinct');
  truth(delivery.worker_created_by_new_ao, 'delivery.worker_created_by_new_ao');
  truth(delivery.worker_created_from_issue, 'delivery.worker_created_from_issue');
  const workerWorktreePath = canonicalAbsolutePath(delivery.worker_worktree_path, 'delivery.worker_worktree_path');
  assert(pathWithin(`${aoDataDir}/worktrees/ao-pilot`, workerWorktreePath), 'Worker worktree is outside retry-specific AO_DATA_DIR');
  const worktreeEvidenceCommentId = Number(delivery.worktree_evidence_comment_id);
  assert(Number.isSafeInteger(worktreeEvidenceCommentId) && worktreeEvidenceCommentId > 0, 'Invalid delivery.worktree_evidence_comment_id');
  string(delivery.worker_branch, 'delivery.worker_branch');
  truth(delivery.worker_committed, 'delivery.worker_committed');
  truth(delivery.worker_pushed, 'delivery.worker_pushed');
  truth(delivery.worker_opened_pr, 'delivery.worker_opened_pr');
  truth(delivery.orchestrator_observed_ci, 'delivery.orchestrator_observed_ci');
  truth(delivery.orchestrator_observed_codex_review, 'delivery.orchestrator_observed_codex_review');
  truth(delivery.review_repairs_same_worker_pr, 'delivery.review_repairs_same_worker_pr');
  truth(delivery.github_merge_outcome_confirmed, 'delivery.github_merge_outcome_confirmed');

  const principalPr = object(delivery.principal_pr, 'delivery.principal_pr');
  assert(Number.isInteger(principalPr.number) && principalPr.number > 0, 'Invalid delivery.principal_pr.number');
  assert(principalPr.number !== P0_R08_RETRY_ADMISSION_PR, 'Historical failed PR #70 cannot serve as the retry principal PR');
  const livePrincipalPr = object(github.principal_pr, 'GitHub principal PR');
  assert(principalPr.number === livePrincipalPr.number, 'Principal PR number does not match GitHub');
  assert(principalPr.url === `https://github.com/Samsen879/ao-pilot/pull/${principalPr.number}`, 'Invalid principal PR URL');
  assert(/^ao\//.test(delivery.worker_branch), 'Worker branch is not AO-owned');
  assert(livePrincipalPr.head_ref === delivery.worker_branch, 'Live PR branch does not match the Worker branch');
  assert(livePrincipalPr.linked_issue_63 === true, 'Live PR is not authoritatively linked to issue #63');
  const finalHead = sha(principalPr.head_sha, 'delivery.principal_pr.head_sha');
  assert(livePrincipalPr.head_sha === finalHead, 'Principal PR final HEAD does not match GitHub');
  assert(livePrincipalPr.base_ref === 'main', 'Principal PR did not target main');
  assert(Date.parse(timestamp(livePrincipalPr.created_at, 'GitHub principal PR created_at')) >= Date.parse(retryAdmittedAt), 'Principal PR predates the owner retry admission');
  assert(Array.isArray(github.issue_linked_prs), 'Live issue-linked PR evidence is unavailable');
  const postAdmissionLinkedPrs = github.issue_linked_prs.filter((linkedPr) => {
    const item = object(linkedPr, 'issue-linked PR');
    assert(Number.isSafeInteger(item.number) && item.number > 0, 'Invalid issue-linked PR number');
    const createdAt = timestamp(item.created_at, `issue-linked PR #${item.number} created_at`);
    return item.number !== P0_R08_RETRY_ADMISSION_PR && Date.parse(createdAt) >= Date.parse(retryAdmittedAt);
  });
  assert(postAdmissionLinkedPrs.length === 1, 'Issue #63 must have exactly one post-admission retry principal PR');
  assert(postAdmissionLinkedPrs[0].number === principalPr.number, 'Receipt principal PR is not the sole post-admission issue-linked retry PR');
  assert(principalPr.ci_conclusion === 'success', 'Principal PR CI is not green');
  assert(Array.isArray(github.check_runs), 'Live CI evidence is unavailable');
  for (const checkName of REQUIRED_CI_CHECKS) {
    assert(github.check_runs.some((check) => check.name === checkName && check.conclusion === 'success'), `Required CI is not green: ${checkName}`);
  }
  const reviews = verifyCompletedCodexReviews(principalPr.codex_reviews, github.codex_reviews);
  const reviewedHead = sha(principalPr.reviewed_head, 'delivery.principal_pr.reviewed_head');
  assert(reviews.at(-1).head_sha === reviewedHead, 'Declared reviewed HEAD is not the final completed review target');
  if (finalHead !== reviewedHead) {
    const repair = object(principalPr.post_review_2_repair, 'delivery.principal_pr.post_review_2_repair');
    assert(reviews.length === 2 && reviews.at(-1).kind === 'submitted_review', 'Unreviewed final HEAD is allowed only after Review 2 findings');
    assert(repair.authorization_ref === 'https://github.com/Samsen879/ao-pilot/issues/55', 'Post-Review-2 repair lacks the Owner policy authorization');
    assert(sha(repair.final_head_sha, 'post_review_2_repair.final_head_sha') === finalHead, 'Post-Review-2 repair does not bind the final HEAD');
    assert(Array.isArray(repair.finding_comment_ids) && repair.finding_comment_ids.length > 0, 'Post-Review-2 repair has no finding IDs');
    assert(Array.isArray(github.review_findings), 'Live review finding evidence is unavailable');
    const liveFindings = github.review_findings.filter((finding) => finding.review_id === reviews.at(-1).evidence_id);
    assert(liveFindings.length === repair.finding_comment_ids.length, 'Post-Review-2 finding evidence is incomplete');
    for (const findingId of repair.finding_comment_ids) {
      const liveFinding = liveFindings.find((finding) => finding.comment_id === findingId);
      assert(liveFinding != null && liveFinding.resolved === true, `Review 2 finding is unresolved or missing: ${findingId}`);
    }
  } else {
    assert(principalPr.post_review_2_repair == null, 'Unexpected post-Review-2 repair claim');
  }
  truth(principalPr.merged, 'delivery.principal_pr.merged');
  assert(livePrincipalPr.merged === true, 'Principal PR is not merged on GitHub');
  const mergeSha = sha(principalPr.merge_sha, 'delivery.principal_pr.merge_sha');
  assert(livePrincipalPr.merge_sha === mergeSha, 'Principal PR merge SHA does not match GitHub');
  const mergedAt = timestamp(livePrincipalPr.merged_at, 'GitHub principal PR merged_at');
  for (const review of reviews) {
    assert(Date.parse(review.completed_at) <= Date.parse(mergedAt), `Codex Review attempt ${review.attempt} completed after merge`);
  }

  const worktreeCapture = object(github.worktree_capture, 'GitHub worktree capture evidence');
  assert(worktreeCapture.comment_id === worktreeEvidenceCommentId, 'Worktree evidence comment ID mismatch');
  assert(worktreeCapture.issue_number === 63, 'Worktree evidence was not published to issue #63');
  assert(worktreeCapture.author === 'Samsen879', 'Worktree evidence has the wrong author');
  const worktreeEvidencePublishedAt = timestamp(worktreeCapture.created_at, 'worktree evidence comment created_at');
  assert(worktreeCapture.updated_at === worktreeEvidencePublishedAt, 'Worktree evidence comment was edited after publication');
  assert(Date.parse(worktreeEvidencePublishedAt) >= Date.parse(retryAdmittedAt), 'Worktree evidence predates the owner retry admission');
  const captured = object(worktreeCapture.payload, 'worktree capture payload');
  assert(captured.schema_version === WORKTREE_EVIDENCE_SCHEMA_VERSION, 'Unsupported worktree evidence schema');
  assert(captured.issue_number === 63, 'Worktree evidence does not target issue #63');
  const capturedAt = timestamp(captured.captured_at, 'worktree evidence captured_at');
  assert(Date.parse(capturedAt) >= Date.parse(retryAdmittedAt), 'Worktree evidence was captured before the owner retry admission');
  assert(Date.parse(capturedAt) <= Date.parse(worktreeEvidencePublishedAt), 'Worktree evidence was published before Git capture completed');
  assert(Date.parse(worktreeEvidencePublishedAt) <= Date.parse(mergedAt), 'Worktree evidence was published after merge');
  assert(Date.parse(capturedAt) <= Date.parse(mergedAt), 'Worktree evidence was captured after merge');
  const capturedSource = object(captured.source, 'captured source worktree');
  assert(capturedSource.clone_path === sourceClonePath, 'Receipt source path does not match captured Git evidence');
  assert(capturedSource.head_sha === sourceHead, 'Captured source HEAD does not match the retry-admitted main');
  assert(capturedSource.tree_sha === sourceTree, 'Captured source tree does not match the retry-admitted tree');
  assert(path.isAbsolute(string(capturedSource.git_common_dir, 'captured source git_common_dir')), 'Captured source git common directory must be absolute');
  const capturedIsolation = object(captured.isolation, 'captured retry isolation');
  assert(capturedIsolation.retry_root === retryRoot, 'Captured retry root does not match the receipt');
  assert(capturedIsolation.ao_data_dir === aoDataDir, 'Captured AO_DATA_DIR does not match the receipt');
  assert(capturedIsolation.ao_run_file === aoRunFile, 'Captured AO_RUN_FILE does not match the receipt');
  assert(capturedIsolation.runtime_store === runtimeStore, 'Captured runtime store does not match the receipt');
  assert(capturedIsolation.runtime_cache === runtimeCache, 'Captured runtime cache does not match the receipt');
  const capturedWorker = object(captured.worker, 'captured Worker worktree');
  assert(capturedWorker.session_id === workerSessionId, 'Captured Worker session does not match the receipt');
  assert(capturedWorker.worktree_path === workerWorktreePath, 'Receipt Worker path does not match captured Git evidence');
  assert(capturedWorker.branch === delivery.worker_branch, 'Captured Worker branch does not match the receipt');
  assert(capturedWorker.head_sha === finalHead, 'Captured Worker HEAD does not match the principal PR');
  assert(path.isAbsolute(string(capturedWorker.git_common_dir, 'captured Worker git_common_dir')), 'Captured Worker git common directory must be absolute');
  assert(path.resolve(capturedWorker.worktree_path) !== path.resolve(capturedSource.clone_path), 'Captured Worker worktree is not distinct from the bootstrap clone');
  assert(capturedWorker.git_common_dir === capturedSource.git_common_dir, 'Captured Worker is not bound to the bootstrap clone');

  const replay = object(value.exact_main_replay, 'exact_main_replay');
  truth(replay.passed, 'exact_main_replay.passed');
  truth(replay.release_check_passed, 'exact_main_replay.release_check_passed');
  truth(repository.release_check_passed, 'repository evidence release_check_passed');
  assert(sha(replay.main_sha, 'exact_main_replay.main_sha') === mergeSha, 'Exact-main replay is not bound to the merge SHA');
  const replayTree = sha(replay.tree_sha, 'exact_main_replay.tree_sha');
  assert(repository.current_main_sha === mergeSha, 'Verifier checkout is not exact post-merge main');
  assert(repository.current_main_tree_sha === replayTree, 'Exact-main replay tree does not match verifier checkout');

  const cleanup = object(value.cleanup, 'cleanup');
  const doneEvidenceCommentId = Number(cleanup.orchestrator_done_evidence_comment_id);
  assert(Number.isSafeInteger(doneEvidenceCommentId) && doneEvidenceCommentId > 0, 'Invalid cleanup.orchestrator_done_evidence_comment_id');
  const doneCapture = object(github.orchestrator_done_capture, 'GitHub Orchestrator done evidence');
  assert(doneCapture.comment_id === doneEvidenceCommentId, 'Orchestrator done evidence comment ID mismatch');
  assert(doneCapture.issue_number === 63, 'Orchestrator done evidence was not published to issue #63');
  assert(doneCapture.author === 'Samsen879', 'Orchestrator done evidence has the wrong author');
  const donePublishedAt = timestamp(doneCapture.created_at, 'Orchestrator done evidence comment created_at');
  assert(doneCapture.updated_at === donePublishedAt, 'Orchestrator done evidence comment was edited after publication');
  const doneEvidence = object(doneCapture.payload, 'Orchestrator done evidence payload');
  assert(doneEvidence.schema_version === ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION, 'Unsupported Orchestrator done evidence schema');
  assert(doneEvidence.issue_number === 63, 'Orchestrator done evidence does not target issue #63');
  assert(doneEvidence.orchestrator_session_id === orchestratorSessionId, 'Orchestrator done evidence session mismatch');
  const doneCompletedAt = timestamp(doneEvidence.completed_at, 'Orchestrator done completed_at');
  assert(Date.parse(doneCompletedAt) >= Date.parse(mergedAt), 'Orchestrator was marked done before the retry PR merge');
  assert(Date.parse(doneCompletedAt) <= Date.parse(donePublishedAt), 'Orchestrator done evidence was published before command completion');
  const doneCommand = object(doneEvidence.command, 'Orchestrator done command evidence');
  assert(doneCommand.runtime_binary_path === runtimeBinaryPath, 'Orchestrator done used the wrong runtime binary');
  assert(JSON.stringify(doneCommand.args) === JSON.stringify(['orchestrator', 'done', '--session', orchestratorSessionId]), 'Unexpected Orchestrator done command');
  assert(doneCommand.exit_code === 0, 'Orchestrator done command did not succeed');
  assert(doneCommand.stdout === `Orchestrator ${orchestratorSessionId} marked done.`, 'Orchestrator done confirmation mismatch');
  truth(cleanup.orchestrator_done, 'cleanup.orchestrator_done');
  truth(cleanup.orchestrator_session_stopped, 'cleanup.orchestrator_session_stopped');
  truth(cleanup.worker_session_stopped, 'cleanup.worker_session_stopped');
  truth(cleanup.worker_worktree_removed, 'cleanup.worker_worktree_removed');
  truth(cleanup.stale_ownership_absent, 'cleanup.stale_ownership_absent');

  if (requirePublication) {
    const publication = object(publicationEvidence, 'issue #63 publication evidence');
    assert(publication.issue_number === 63, 'Receipt was not published to issue #63');
    assert(publication.author === 'Samsen879', 'Receipt publication has the wrong author');
    assert(Date.parse(timestamp(publication.created_at, 'receipt publication created_at')) >= Date.parse(donePublishedAt), 'Receipt was published before durable Orchestrator completion evidence');
    truth(publication.exact_bytes_match, 'publication.exact_bytes_match');
  } else {
    assert(publicationEvidence == null, 'Pre-publication verification must not accept publication evidence');
  }

  const claim = object(value.claim, 'claim');
  truth(claim.workstation_self_hosting, 'claim.workstation_self_hosting');
  truth(claim.p0_r08_satisfied, 'claim.p0_r08_satisfied');

  return {
    status: requirePublication ? 'verified' : 'prepublication_verified',
    schema_version: value.schema_version,
    issue_number: delivery.issue_number,
    runtime_ref: runtime.runtime_ref,
    admitted_main: sourceHead,
    retry_admission_comment: retryAdmission.comment_id,
    orchestrator_done_comment: doneEvidenceCommentId,
    principal_pr: principalPr.number,
    reviewed_head: principalPr.reviewed_head,
    merge_sha: mergeSha,
    review_count: reviews.length,
  };
}

export function loadSelfHostingReceipt(receiptPath) {
  try {
    return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read self-hosting receipt: ${error.message}`);
  }
}
