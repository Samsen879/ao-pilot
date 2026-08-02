import fs from 'node:fs';
import path from 'node:path';

import { ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION } from './orchestrator-done-evidence.js';
import { loadRuntimeLock } from './runtime-lock.js';

export const SELF_HOSTING_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v4';
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
export const TERMINAL_WORKTREE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-worktree-evidence.v4';
export const TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION = 'ao.workstation-terminal-recovery-chain.v1';
export const P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT = 5158225894;
export const P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256 = '24fbc151586ef2e841f2b5979ef14f05f387a71ef3b5aed9a554245704658a61';
export const P0_R08_FIRST_TERMINAL_ADMITTED_MAIN = '6d3bf2879d76cd6ab304b0040f1be2c88c294e66';
export const P0_R08_FIRST_TERMINAL_ADMITTED_TREE = 'dafe190179199b0b3dbcf16f4e91c1bc714bae4b';
export const P0_R08_FAILED_TERMINAL_PR = 72;
export const P0_R08_FAILED_TERMINAL_HEAD = '054cf5f648bb72b94ee4cdd1b17e64515db9031f';
export const P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT = 5158533683;
export const P0_R08_FAILED_TERMINAL_DISPOSITION_SHA256 = '850ee6631986731684666fa1fc379835497d740fcd72ac725065ac10f542e487';
export const P0_R08_TERMINAL_ADMISSION_COMMENT = 5158510418;
export const P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256 = '431e128a4ffe100b1a74a327778796480513f6fd06a5ab9a8df5c2e5c5df1284';
export const P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES = 3712;
export const P0_R08_TERMINAL_ADMITTED_MAIN = '59cdf7c0ddfedfe4438eaeeff485146534fae287';
export const P0_R08_TERMINAL_ADMITTED_TREE = '044f49e5fe8cbfe2382001436d1e060b9bbb0e07';
export const P0_R08_PRINCIPAL_PR = 71;
export const P0_R08_TERMINAL_ROOT = '/home/guoqy/p0-r08-terminal-remediation';
export const P0_R08_TERMINAL_AO_DATA_DIR = `${P0_R08_TERMINAL_ROOT}/ao-state/data`;
export const P0_R08_TERMINAL_AO_RUN_FILE = `${P0_R08_TERMINAL_ROOT}/ao-state/running.json`;
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

export function resolvePathThroughFilesystem(value, field = 'path') {
  const candidate = canonicalAbsolutePath(value, field);
  const missing = [];
  let existing = candidate;
  while (true) {
    try {
      fs.lstatSync(existing);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`Unable to resolve ${field} through the filesystem: ${error.message}`);
      }
      const parent = path.dirname(existing);
      assert(parent !== existing, `Unable to find an existing parent for ${field}`);
      missing.unshift(path.basename(existing));
      existing = parent;
      continue;
    }
    try {
      const resolved = fs.realpathSync.native(existing);
      return path.resolve(resolved, ...missing);
    } catch (error) {
      throw new Error(`Unable to resolve ${field} through the filesystem: ${error.message}`);
    }
  }
}

export function assertPathResolvesWithin(root, candidate, field = 'path') {
  const canonicalRoot = canonicalAbsolutePath(root, `${field} root`);
  const resolvedRoot = resolvePathThroughFilesystem(canonicalRoot, `${field} root`);
  assert(resolvedRoot === canonicalRoot, `${field} root must resolve to its canonical filesystem location`);
  const resolvedCandidate = resolvePathThroughFilesystem(candidate, field);
  assert(pathWithin(resolvedRoot, resolvedCandidate), `${field} filesystem target escapes the retry root`);
  return resolvedCandidate;
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
    assert(['submitted_review', 'clean_comment', 'clean_reaction'].includes(item.kind), `Invalid codex_reviews[${index}].kind`);
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
  const resolvedRetryRoot = resolvePathThroughFilesystem(retryRoot, 'environment.retry_root');
  assert(resolvedRetryRoot === retryRoot, 'Retry root must resolve to the owner-admitted workstation root');
  for (const [field, candidate] of [['AO_DATA_DIR', aoDataDir], ['AO_RUN_FILE', aoRunFile], ['runtime store', runtimeStore], ['runtime cache', runtimeCache]]) {
    assert(pathWithin(retryRoot, candidate), `${field} escapes the retry root`);
    assertPathResolvesWithin(retryRoot, candidate, field);
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
  assertPathResolvesWithin(retryRoot, sourceClonePath, 'Source clone');
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
  const liveIssue = object(github.issue_63, 'GitHub issue #63');
  assert(liveIssue.number === 63 && liveIssue.state === 'open', 'Issue #63 must remain open through terminal receipt verification');
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

  const terminal = object(value.terminal_remediation, 'terminal_remediation');
  const terminalAdmission = object(terminal.admission, 'terminal_remediation.admission');
  assert(terminalAdmission.issue_number === 63, 'Terminal-remediation admission is not bound to issue #63');
  assert(terminalAdmission.comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT, 'Terminal-remediation admission comment ID mismatch');
  assert(terminalAdmission.comment_body_sha256 === P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256, 'Terminal-remediation admission comment digest mismatch');
  assert(terminalAdmission.principal_pr_number === P0_R08_PRINCIPAL_PR, 'Terminal-remediation admission does not preserve principal PR #71');
  assert(sha(terminalAdmission.admitted_main_sha, 'terminal_remediation.admission.admitted_main_sha') === P0_R08_TERMINAL_ADMITTED_MAIN, 'Terminal-remediation admitted main mismatch');
  assert(sha(terminalAdmission.admitted_tree_sha, 'terminal_remediation.admission.admitted_tree_sha') === P0_R08_TERMINAL_ADMITTED_TREE, 'Terminal-remediation admitted tree mismatch');
  const liveTerminalAdmission = object(github.terminal_remediation_admission, 'GitHub terminal-remediation admission comment');
  assert(liveTerminalAdmission.comment_id === terminalAdmission.comment_id, 'Live terminal-remediation admission comment ID mismatch');
  assert(liveTerminalAdmission.issue_number === 63, 'Terminal-remediation admission was not published to issue #63');
  assert(liveTerminalAdmission.author === 'Samsen879' && liveTerminalAdmission.author_association === 'OWNER', 'Terminal-remediation admission is not Owner-authored');
  const terminalAdmittedAt = timestamp(liveTerminalAdmission.created_at, 'terminal-remediation admission created_at');
  assert(terminalAdmittedAt === '2026-08-02T14:24:49Z', 'Standing recovery admission created_at mismatch');
  assert(liveTerminalAdmission.updated_at === terminalAdmittedAt, 'Terminal-remediation admission comment was edited');
  assert(liveTerminalAdmission.body_bytes === P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES, 'Live standing admission byte length mismatch');
  assert(liveTerminalAdmission.body_sha256 === terminalAdmission.comment_body_sha256, 'Live terminal-remediation admission digest mismatch');

  const recoveryChain = object(value.terminal_recovery_chain, 'terminal_recovery_chain');
  assert(recoveryChain.schema_version === TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION, 'Unsupported terminal recovery-chain schema');
  const standing = object(recoveryChain.standing_admission, 'terminal_recovery_chain.standing_admission');
  assert(standing.issue_number === 63, 'Standing recovery admission is not bound to issue #63');
  assert(standing.comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT, 'Standing recovery admission comment mismatch');
  assert(standing.comment_body_bytes === P0_R08_TERMINAL_ADMISSION_COMMENT_BYTES, 'Standing recovery admission byte length mismatch');
  assert(standing.comment_body_sha256 === P0_R08_TERMINAL_ADMISSION_COMMENT_SHA256, 'Standing recovery admission digest mismatch');
  assert(standing.created_at === '2026-08-02T14:24:49Z' && standing.updated_at === standing.created_at, 'Standing recovery admission timestamp/edit state mismatch');
  assert(standing.principal_pr_number === P0_R08_PRINCIPAL_PR, 'Standing recovery admission does not preserve sole principal PR #71');
  assert(standing.max_additional_recovery_attempts === 2, 'Standing recovery attempt bound was widened');
  assert(sha(standing.admitted_main_sha, 'terminal_recovery_chain.standing_admission.admitted_main_sha') === P0_R08_TERMINAL_ADMITTED_MAIN, 'Standing recovery baseline commit mismatch');
  assert(sha(standing.admitted_tree_sha, 'terminal_recovery_chain.standing_admission.admitted_tree_sha') === P0_R08_TERMINAL_ADMITTED_TREE, 'Standing recovery baseline tree mismatch');

  assert(Array.isArray(recoveryChain.attempts) && recoveryChain.attempts.length === 2, 'Recovery chain must contain exactly the failed PR #72 and this ordered recovery delivery');
  const failedAttempt = object(recoveryChain.attempts[0], 'terminal_recovery_chain.attempts[0]');
  assert(failedAttempt.attempt === 1 && failedAttempt.kind === 'terminal_recovery_delivery' && failedAttempt.disposition === 'failed_premerge_gates', 'PR #72 must be the first failed recovery-chain attempt');
  const failedAdmission = object(failedAttempt.admission, 'terminal_recovery_chain.attempts[0].admission');
  assert(failedAdmission.comment_id === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT && failedAdmission.comment_body_sha256 === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256, 'Failed attempt does not preserve its first terminal admission');
  assert(sha(failedAdmission.admitted_main_sha, 'failed terminal admitted_main_sha') === P0_R08_FIRST_TERMINAL_ADMITTED_MAIN && sha(failedAdmission.admitted_tree_sha, 'failed terminal admitted_tree_sha') === P0_R08_FIRST_TERMINAL_ADMITTED_TREE, 'Failed attempt admission baseline mismatch');
  const liveFirstAdmission = object(github.first_terminal_admission, 'GitHub first terminal admission');
  assert(liveFirstAdmission.comment_id === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT && liveFirstAdmission.issue_number === 63 && liveFirstAdmission.author === 'Samsen879' && liveFirstAdmission.author_association === 'OWNER', 'First terminal admission identity mismatch');
  assert(liveFirstAdmission.created_at === liveFirstAdmission.updated_at && liveFirstAdmission.body_sha256 === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256, 'First terminal admission was edited or drifted');

  const failedPr = object(failedAttempt.pr, 'terminal_recovery_chain.attempts[0].pr');
  assert(failedPr.number === P0_R08_FAILED_TERMINAL_PR && failedPr.url === 'https://github.com/Samsen879/ao-pilot/pull/72', 'Failed recovery attempt is not PR #72');
  assert(sha(failedPr.head_sha, 'failed terminal PR head_sha') === P0_R08_FAILED_TERMINAL_HEAD, 'Failed PR #72 head mismatch');
  assert(failedPr.reviewed_head === failedPr.head_sha, 'Failed PR #72 final reviewed head mismatch');
  assert(sha(failedPr.merge_sha, 'failed terminal PR merge_sha') === P0_R08_TERMINAL_ADMITTED_MAIN && sha(failedPr.merge_tree_sha, 'failed terminal PR merge_tree_sha') === P0_R08_TERMINAL_ADMITTED_TREE, 'Failed PR #72 outcome is not the standing baseline');
  assert(failedPr.merged_at === '2026-08-02T14:15:52Z', 'Failed PR #72 merge timestamp mismatch');
  const liveFailedPr = object(github.failed_terminal_pr, 'GitHub failed terminal PR #72');
  assert(liveFailedPr.number === P0_R08_FAILED_TERMINAL_PR && liveFailedPr.merged === true && liveFailedPr.base_ref === 'main', 'PR #72 is not the immutable merged failed attempt');
  assert(liveFailedPr.head_sha === failedPr.head_sha && liveFailedPr.merge_sha === failedPr.merge_sha && liveFailedPr.merge_tree_sha === failedPr.merge_tree_sha && liveFailedPr.merged_at === failedPr.merged_at, 'Live PR #72 outcome drifted from the recovery chain');
  const failedReviews = verifyCompletedCodexReviews(failedPr.codex_reviews, github.failed_terminal_codex_reviews);
  assert(failedReviews.length === 2, 'Failed PR #72 must preserve both completed review attempts');
  assert(failedReviews[0].kind === 'clean_comment' && failedReviews[0].evidence_id === 5158396828 && failedReviews[0].request_comment_id === 5158376025 && failedReviews[0].head_sha === '0724ab9882846314e39845292ab86ef4aefb3c2b', 'Failed PR #72 Review 1 evidence mismatch');
  assert(failedReviews[1].kind === 'clean_comment' && failedReviews[1].evidence_id === 5158456834 && failedReviews[1].request_comment_id === 5158426324 && failedReviews[1].head_sha === P0_R08_FAILED_TERMINAL_HEAD, 'Failed PR #72 Review 2 evidence mismatch');
  for (const review of failedReviews) assert(Date.parse(review.completed_at) <= Date.parse(failedPr.merged_at), `Failed PR #72 review ${review.attempt} completed after merge`);

  const failure = object(failedAttempt.failure, 'terminal_recovery_chain.attempts[0].failure');
  assert(failure.disposition_comment_id === P0_R08_FAILED_TERMINAL_DISPOSITION_COMMENT && failure.disposition_comment_body_sha256 === P0_R08_FAILED_TERMINAL_DISPOSITION_SHA256, 'PR #72 fail-closed disposition mismatch');
  assert(failure.disposition_created_at === '2026-08-02T14:29:13Z' && failure.disposition_updated_at === failure.disposition_created_at, 'PR #72 disposition timestamp/edit state mismatch');
  assert(failure.collector_review_2_recognized === false && failure.premerge_worktree_evidence_published === false && failure.terminal_receipt_published === false, 'PR #72 failure gates were rewritten as satisfied');
  assert(JSON.stringify(failure.reason_codes) === JSON.stringify(['review_2_clean_comment_unrecognized', 'premerge_worktree_evidence_missing']), 'PR #72 failure reasons are incomplete or unordered');
  const liveFailure = object(github.failed_terminal_disposition, 'GitHub PR #72 fail-closed disposition');
  assert(liveFailure.comment_id === failure.disposition_comment_id && liveFailure.issue_number === 63 && liveFailure.author === 'Samsen879' && liveFailure.author_association === 'OWNER', 'PR #72 fail-closed disposition identity mismatch');
  assert(liveFailure.created_at === failure.disposition_created_at && liveFailure.updated_at === failure.disposition_updated_at && liveFailure.body_sha256 === failure.disposition_comment_body_sha256, 'PR #72 fail-closed disposition was edited or drifted');

  const activeAttempt = object(recoveryChain.attempts[1], 'terminal_recovery_chain.attempts[1]');
  assert(activeAttempt.attempt === 2 && activeAttempt.kind === 'terminal_recovery_delivery' && activeAttempt.disposition === 'passed', 'Current recovery delivery must be ordered attempt 2 and passed');
  assert(activeAttempt.predecessor_pr_number === P0_R08_FAILED_TERMINAL_PR, 'Current recovery delivery does not follow failed PR #72');
  assert(activeAttempt.admission_comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT, 'Current recovery delivery is not bound to standing admission');

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
  assertPathResolvesWithin(retryRoot, runtimeBinaryPath, 'Runtime binary');

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
  assertPathResolvesWithin(retryRoot, workerWorktreePath, 'Worker worktree');
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
  assert(principalPr.number === P0_R08_PRINCIPAL_PR, 'PR #71 must remain the sole P0-R08 principal delivery');
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
    assert(item.repository === 'Samsen879/ao-pilot', 'Issue-linked PR evidence is from an external repository');
    assert(Number.isSafeInteger(item.number) && item.number > 0, 'Invalid issue-linked PR number');
    const createdAt = timestamp(item.created_at, `issue-linked PR #${item.number} created_at`);
    return item.number !== P0_R08_RETRY_ADMISSION_PR
      && Date.parse(createdAt) >= Date.parse(retryAdmittedAt)
      && Date.parse(createdAt) < Date.parse(terminalAdmittedAt);
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
  const capturedSourceGitCommonDir = canonicalAbsolutePath(capturedSource.git_common_dir, 'captured source git_common_dir');
  assertPathResolvesWithin(retryRoot, capturedSourceGitCommonDir, 'Captured source git common directory');
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
  const capturedWorkerGitCommonDir = canonicalAbsolutePath(capturedWorker.git_common_dir, 'captured Worker git_common_dir');
  assertPathResolvesWithin(retryRoot, capturedWorkerGitCommonDir, 'Captured Worker git common directory');
  assert(path.resolve(capturedWorker.worktree_path) !== path.resolve(capturedSource.clone_path), 'Captured Worker worktree is not distinct from the bootstrap clone');
  assert(capturedWorkerGitCommonDir === capturedSourceGitCommonDir, 'Captured Worker is not bound to the bootstrap clone');

  const replay = object(value.exact_main_replay, 'exact_main_replay');
  truth(replay.passed, 'exact_main_replay.passed');
  truth(replay.release_check_passed, 'exact_main_replay.release_check_passed');
  truth(repository.release_check_passed, 'repository evidence release_check_passed');
  assert(sha(replay.main_sha, 'exact_main_replay.main_sha') === mergeSha, 'Exact-main replay is not bound to the merge SHA');
  const replayTree = sha(replay.tree_sha, 'exact_main_replay.tree_sha');
  assert(livePrincipalPr.merge_tree_sha === replayTree, 'Principal exact-main replay tree does not match GitHub merge tree');
  assert(mergeSha === P0_R08_FIRST_TERMINAL_ADMITTED_MAIN && replayTree === P0_R08_FIRST_TERMINAL_ADMITTED_TREE, 'Principal PR #71 merge SHA/tree does not equal the immutable v2 proof baseline');

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

  const terminalEnvironment = object(terminal.environment, 'terminal_remediation.environment');
  assert(terminalEnvironment.kind === 'isolated_terminal_remediation', 'Terminal remediation did not use an isolated environment');
  falsehood(terminalEnvironment.prior_ao_state_read, 'terminal_remediation.environment.prior_ao_state_read');
  truth(terminalEnvironment.verified_immutable_runtime_reused, 'terminal_remediation.environment.verified_immutable_runtime_reused');
  const terminalRoot = canonicalAbsolutePath(terminalEnvironment.remediation_root, 'terminal_remediation.environment.remediation_root');
  const terminalAoDataDir = canonicalAbsolutePath(terminalEnvironment.ao_data_dir, 'terminal_remediation.environment.ao_data_dir');
  const terminalAoRunFile = canonicalAbsolutePath(terminalEnvironment.ao_run_file, 'terminal_remediation.environment.ao_run_file');
  assert(terminalRoot === P0_R08_TERMINAL_ROOT, 'Terminal-remediation root mismatch');
  assert(terminalAoDataDir === P0_R08_TERMINAL_AO_DATA_DIR, 'Terminal-remediation AO_DATA_DIR mismatch');
  assert(terminalAoRunFile === P0_R08_TERMINAL_AO_RUN_FILE, 'Terminal-remediation AO_RUN_FILE mismatch');
  for (const [field, candidate] of [['AO_DATA_DIR', terminalAoDataDir], ['AO_RUN_FILE', terminalAoRunFile]]) {
    assert(pathWithin(terminalRoot, candidate), `Terminal-remediation ${field} escapes its root`);
    assertPathResolvesWithin(terminalRoot, candidate, `Terminal-remediation ${field}`);
  }
  assert(terminalEnvironment.runtime_binary_path === runtimeBinaryPath, 'Terminal remediation did not reuse the verified immutable runtime binary');
  assert(terminalEnvironment.runtime_binary_sha256 === runtime.binary_sha256, 'Terminal-remediation runtime digest mismatch');

  const terminalSource = object(terminal.source, 'terminal_remediation.source');
  assert(terminalSource.repository === source.repository, 'Terminal-remediation source repository mismatch');
  const terminalSourceHead = sha(terminalSource.clone_head_sha, 'terminal_remediation.source.clone_head_sha');
  const terminalSourceTree = sha(terminalSource.clone_tree_sha, 'terminal_remediation.source.clone_tree_sha');
  assert(terminalSourceHead === P0_R08_TERMINAL_ADMITTED_MAIN && terminalSourceTree === P0_R08_TERMINAL_ADMITTED_TREE, 'Terminal-remediation source is not exact admitted main/tree');
  assert(repository.terminal_source_commit_sha === terminalSourceHead, 'Terminal-remediation source commit evidence mismatch');
  assert(repository.terminal_source_tree_sha === terminalSourceTree, 'Terminal-remediation source tree evidence mismatch');
  const terminalClonePath = canonicalAbsolutePath(terminalSource.clone_path, 'terminal_remediation.source.clone_path');
  assert(terminalClonePath === `${terminalRoot}/ao-pilot`, 'Terminal-remediation clone path mismatch');
  assertPathResolvesWithin(terminalRoot, terminalClonePath, 'Terminal-remediation source clone');
  truth(terminalSource.clean_before_bootstrap, 'terminal_remediation.source.clean_before_bootstrap');

  const terminalDelivery = object(terminal.delivery, 'terminal_remediation.delivery');
  const terminalOrchestratorSessionId = string(terminalDelivery.orchestrator_session_id, 'terminal_remediation.delivery.orchestrator_session_id');
  const terminalWorkerSessionId = string(terminalDelivery.worker_session_id, 'terminal_remediation.delivery.worker_session_id');
  assert(terminalOrchestratorSessionId !== terminalWorkerSessionId, 'Terminal-remediation Orchestrator and Worker sessions must be distinct');
  truth(terminalDelivery.worker_created_by_new_ao, 'terminal_remediation.delivery.worker_created_by_new_ao');
  truth(terminalDelivery.worker_created_from_issue, 'terminal_remediation.delivery.worker_created_from_issue');
  const terminalWorkerPath = canonicalAbsolutePath(terminalDelivery.worker_worktree_path, 'terminal_remediation.delivery.worker_worktree_path');
  assert(pathWithin(`${terminalAoDataDir}/worktrees/ao-pilot-remediation`, terminalWorkerPath), 'Terminal-remediation Worker worktree is outside fresh AO_DATA_DIR');
  assertPathResolvesWithin(terminalRoot, terminalWorkerPath, 'Terminal-remediation Worker worktree');
  const terminalWorktreeCommentId = Number(terminalDelivery.worktree_evidence_comment_id);
  assert(Number.isSafeInteger(terminalWorktreeCommentId) && terminalWorktreeCommentId > 0, 'Invalid terminal-remediation worktree evidence comment ID');
  const terminalBranch = string(terminalDelivery.worker_branch, 'terminal_remediation.delivery.worker_branch');
  assert(/^ao\//.test(terminalBranch), 'Terminal-remediation Worker branch is not AO-owned');
  truth(terminalDelivery.worker_committed, 'terminal_remediation.delivery.worker_committed');
  truth(terminalDelivery.worker_pushed, 'terminal_remediation.delivery.worker_pushed');
  truth(terminalDelivery.worker_opened_pr, 'terminal_remediation.delivery.worker_opened_pr');
  truth(terminalDelivery.orchestrator_observed_ci, 'terminal_remediation.delivery.orchestrator_observed_ci');
  truth(terminalDelivery.orchestrator_observed_codex_review, 'terminal_remediation.delivery.orchestrator_observed_codex_review');
  truth(terminalDelivery.review_repairs_same_worker_pr, 'terminal_remediation.delivery.review_repairs_same_worker_pr');
  truth(terminalDelivery.github_merge_outcome_confirmed, 'terminal_remediation.delivery.github_merge_outcome_confirmed');
  const remediationPr = object(terminalDelivery.remediation_pr, 'terminal_remediation.delivery.remediation_pr');
  assert(Number.isInteger(remediationPr.number) && ![70, P0_R08_PRINCIPAL_PR, P0_R08_FAILED_TERMINAL_PR].includes(remediationPr.number), 'Terminal recovery must use one new non-principal PR after failed PR #72');
  assert(activeAttempt.pr_number === remediationPr.number, 'Recovery-chain attempt 2 PR does not match the terminal delivery');
  assert(remediationPr.url === `https://github.com/Samsen879/ao-pilot/pull/${remediationPr.number}`, 'Invalid terminal-remediation PR URL');
  const liveRemediationPr = object(github.terminal_remediation_pr, 'GitHub terminal-remediation PR');
  assert(liveRemediationPr.number === remediationPr.number, 'Terminal-remediation PR number does not match GitHub');
  assert(liveRemediationPr.head_ref === terminalBranch && liveRemediationPr.base_ref === 'main', 'Terminal-remediation PR branch/base mismatch');
  assert(liveRemediationPr.linked_issue_63 === true, 'Terminal-remediation PR is not linked to issue #63');
  assert(liveRemediationPr.binds_terminal_admission === true, 'Terminal-recovery PR does not bind standing admission comment 5158510418');
  assert(liveRemediationPr.binds_principal_pr_71 === true, 'Terminal-remediation PR does not preserve principal PR #71');
  assert(liveRemediationPr.binds_failed_terminal_pr_72 === true, 'Terminal-recovery PR does not bind failed chain attempt PR #72');
  assert(liveRemediationPr.auto_closes_issue_63 === false, 'Terminal-remediation PR must not auto-close issue #63');
  assert(Date.parse(timestamp(liveRemediationPr.created_at, 'terminal-remediation PR created_at')) >= Date.parse(terminalAdmittedAt), 'Terminal-remediation PR predates admission');
  const terminalFinalHead = sha(remediationPr.head_sha, 'terminal_remediation.delivery.remediation_pr.head_sha');
  assert(liveRemediationPr.head_sha === terminalFinalHead, 'Terminal-remediation PR final HEAD mismatch');
  const terminalLinkedPrs = github.issue_linked_prs.filter((linkedPr) => Date.parse(timestamp(linkedPr.created_at, `issue-linked PR #${linkedPr.number} created_at`)) >= Date.parse(terminalAdmittedAt));
  assert(terminalLinkedPrs.length === 1 && terminalLinkedPrs[0].number === remediationPr.number, 'Issue #63 must have exactly one admitted terminal-remediation PR and no extra linked deliveries');
  assert(remediationPr.ci_conclusion === 'success', 'Terminal-remediation PR CI is not green');
  assert(Array.isArray(github.terminal_check_runs), 'Live terminal-remediation CI evidence is unavailable');
  for (const checkName of REQUIRED_CI_CHECKS) assert(github.terminal_check_runs.some((check) => check.name === checkName && check.conclusion === 'success'), `Terminal-remediation required CI is not green: ${checkName}`);
  const terminalReviews = verifyCompletedCodexReviews(remediationPr.codex_reviews, github.terminal_codex_reviews);
  const terminalReviewedHead = sha(remediationPr.reviewed_head, 'terminal_remediation.delivery.remediation_pr.reviewed_head');
  assert(terminalReviews.at(-1).head_sha === terminalReviewedHead, 'Terminal-remediation reviewed HEAD mismatch');
  if (terminalFinalHead !== terminalReviewedHead) {
    const terminalRepair = object(remediationPr.post_review_2_repair, 'terminal_remediation.delivery.remediation_pr.post_review_2_repair');
    assert(terminalReviews.length === 2 && terminalReviews.at(-1).kind === 'submitted_review', 'Unreviewed terminal-remediation final HEAD is allowed only after Review 2 findings');
    assert(terminalRepair.authorization_ref === 'https://github.com/Samsen879/ao-pilot/issues/63#issuecomment-5158510418', 'Terminal-recovery post-Review-2 repair lacks exact standing Owner authorization');
    assert(sha(terminalRepair.final_head_sha, 'terminal-remediation post_review_2_repair.final_head_sha') === terminalFinalHead, 'Terminal-remediation post-Review-2 repair does not bind final HEAD');
    assert(Array.isArray(terminalRepair.finding_comment_ids) && terminalRepair.finding_comment_ids.length > 0, 'Terminal-remediation post-Review-2 repair has no finding IDs');
    assert(Array.isArray(github.terminal_review_findings), 'Live terminal-remediation review finding evidence is unavailable');
    const terminalFindings = github.terminal_review_findings.filter((finding) => finding.review_id === terminalReviews.at(-1).evidence_id);
    assert(terminalFindings.length === terminalRepair.finding_comment_ids.length, 'Terminal-remediation post-Review-2 finding evidence is incomplete');
    for (const findingId of terminalRepair.finding_comment_ids) {
      const liveFinding = terminalFindings.find((finding) => finding.comment_id === findingId);
      assert(liveFinding?.resolved === true, `Terminal-remediation Review 2 finding is unresolved or missing: ${findingId}`);
    }
  } else {
    assert(remediationPr.post_review_2_repair == null, 'Unexpected terminal-remediation post-Review-2 repair claim');
  }
  truth(remediationPr.merged, 'terminal_remediation.delivery.remediation_pr.merged');
  assert(liveRemediationPr.merged === true, 'Terminal-remediation PR is not merged on GitHub');
  const terminalMergeSha = sha(remediationPr.merge_sha, 'terminal_remediation.delivery.remediation_pr.merge_sha');
  const terminalMergeTree = sha(remediationPr.merge_tree_sha, 'terminal_remediation.delivery.remediation_pr.merge_tree_sha');
  assert(liveRemediationPr.merge_sha === terminalMergeSha && liveRemediationPr.merge_tree_sha === terminalMergeTree, 'Terminal-remediation merge SHA/tree mismatch');
  const terminalMergedAt = timestamp(liveRemediationPr.merged_at, 'terminal-remediation PR merged_at');
  for (const review of terminalReviews) assert(Date.parse(review.completed_at) <= Date.parse(terminalMergedAt), `Terminal-remediation Codex Review attempt ${review.attempt} completed after merge`);

  const terminalWorktreeCapture = object(github.terminal_worktree_capture, 'GitHub terminal-remediation worktree capture');
  assert(terminalWorktreeCapture.comment_id === terminalWorktreeCommentId && terminalWorktreeCapture.issue_number === 63 && terminalWorktreeCapture.author === 'Samsen879', 'Terminal-remediation worktree evidence identity mismatch');
  const terminalWorktreePublishedAt = timestamp(terminalWorktreeCapture.created_at, 'terminal-remediation worktree evidence created_at');
  assert(terminalWorktreeCapture.updated_at === terminalWorktreePublishedAt, 'Terminal-remediation worktree evidence was edited');
  const terminalCaptured = object(terminalWorktreeCapture.payload, 'terminal-remediation worktree payload');
  assert(terminalCaptured.schema_version === TERMINAL_WORKTREE_EVIDENCE_SCHEMA_VERSION && terminalCaptured.issue_number === 63, 'Unsupported terminal-remediation worktree evidence');
  const terminalCapturedAt = timestamp(terminalCaptured.captured_at, 'terminal-remediation worktree captured_at');
  assert(Date.parse(terminalCapturedAt) >= Date.parse(terminalAdmittedAt) && Date.parse(terminalCapturedAt) <= Date.parse(terminalWorktreePublishedAt) && Date.parse(terminalWorktreePublishedAt) <= Date.parse(terminalMergedAt), 'Terminal-remediation worktree evidence is outside the admitted pre-merge window');
  assert(terminalCaptured.source.clone_path === terminalClonePath && terminalCaptured.source.head_sha === terminalSourceHead && terminalCaptured.source.tree_sha === terminalSourceTree, 'Terminal-remediation captured source mismatch');
  assert(terminalCaptured.isolation.remediation_root === terminalRoot && terminalCaptured.isolation.ao_data_dir === terminalAoDataDir && terminalCaptured.isolation.ao_run_file === terminalAoRunFile, 'Terminal-remediation captured isolation mismatch');
  assert(terminalCaptured.recovery_chain?.standing_admission_comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT && terminalCaptured.recovery_chain?.attempt === 2 && terminalCaptured.recovery_chain?.prior_attempt_pr_number === P0_R08_FAILED_TERMINAL_PR, 'Terminal worktree evidence is not bound to ordered standing recovery attempt 2');
  assert(terminalCaptured.recovery_chain?.admitted_main_sha === P0_R08_TERMINAL_ADMITTED_MAIN && terminalCaptured.recovery_chain?.admitted_tree_sha === P0_R08_TERMINAL_ADMITTED_TREE, 'Terminal worktree evidence standing baseline mismatch');
  assert(terminalCaptured.worker.session_id === terminalWorkerSessionId && terminalCaptured.worker.worktree_path === terminalWorkerPath && terminalCaptured.worker.branch === terminalBranch && terminalCaptured.worker.head_sha === terminalFinalHead, 'Terminal-remediation captured Worker mismatch');
  assert(activeAttempt.worktree_evidence_comment_id === terminalWorktreeCommentId, 'Recovery-chain attempt 2 does not bind the terminal worktree evidence');
  const terminalSourceGitCommonDir = canonicalAbsolutePath(terminalCaptured.source.git_common_dir, 'terminal-remediation captured source git_common_dir');
  const terminalWorkerGitCommonDir = canonicalAbsolutePath(terminalCaptured.worker.git_common_dir, 'terminal-remediation captured Worker git_common_dir');
  assertPathResolvesWithin(terminalRoot, terminalSourceGitCommonDir, 'Terminal-remediation captured source git common directory');
  assertPathResolvesWithin(terminalRoot, terminalWorkerGitCommonDir, 'Terminal-remediation captured Worker git common directory');
  assert(terminalWorkerGitCommonDir === terminalSourceGitCommonDir && terminalCaptured.worker.worktree_path !== terminalCaptured.source.clone_path, 'Terminal-remediation Worker is not an independent worktree of the admitted clone');

  const terminalReplay = object(terminal.exact_main_replay, 'terminal_remediation.exact_main_replay');
  truth(terminalReplay.passed, 'terminal_remediation.exact_main_replay.passed');
  truth(terminalReplay.release_check_passed, 'terminal_remediation.exact_main_replay.release_check_passed');
  assert(sha(terminalReplay.main_sha, 'terminal_remediation.exact_main_replay.main_sha') === terminalMergeSha, 'Terminal-remediation replay is not bound to merge SHA');
  assert(sha(terminalReplay.tree_sha, 'terminal_remediation.exact_main_replay.tree_sha') === terminalMergeTree, 'Terminal-remediation replay is not bound to merge tree');
  assert(repository.current_main_sha === terminalMergeSha && repository.current_main_tree_sha === terminalMergeTree, 'Verifier checkout is not exact terminal-remediation main/tree');

  const terminalCleanup = object(terminal.cleanup, 'terminal_remediation.cleanup');
  const terminalDoneCommentId = Number(terminalCleanup.orchestrator_done_evidence_comment_id);
  assert(Number.isSafeInteger(terminalDoneCommentId) && terminalDoneCommentId > 0, 'Invalid terminal-remediation done evidence comment ID');
  const terminalDoneCapture = object(github.terminal_orchestrator_done_capture, 'GitHub terminal-remediation done evidence');
  assert(terminalDoneCapture.comment_id === terminalDoneCommentId && terminalDoneCapture.issue_number === 63 && terminalDoneCapture.author === 'Samsen879', 'Terminal-remediation done evidence identity mismatch');
  const terminalDonePublishedAt = timestamp(terminalDoneCapture.created_at, 'terminal-remediation done evidence created_at');
  assert(terminalDoneCapture.updated_at === terminalDonePublishedAt, 'Terminal-remediation done evidence was edited');
  const terminalDone = object(terminalDoneCapture.payload, 'terminal-remediation done payload');
  assert(terminalDone.schema_version === ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION && terminalDone.issue_number === 63 && terminalDone.orchestrator_session_id === terminalOrchestratorSessionId, 'Terminal-remediation done payload mismatch');
  const terminalDoneCompletedAt = timestamp(terminalDone.completed_at, 'terminal-remediation done completed_at');
  assert(Date.parse(terminalDoneCompletedAt) >= Date.parse(terminalMergedAt) && Date.parse(terminalDoneCompletedAt) <= Date.parse(terminalDonePublishedAt), 'Terminal-remediation done evidence is outside the post-merge publication window');
  assert(terminalDone.command.runtime_binary_path === runtimeBinaryPath && terminalDone.command.exit_code === 0, 'Terminal-remediation done used unverified runtime or failed');
  assert(JSON.stringify(terminalDone.command.args) === JSON.stringify(['orchestrator', 'done', '--session', terminalOrchestratorSessionId]), 'Unexpected terminal-remediation done command');
  assert(terminalDone.command.stdout === `Orchestrator ${terminalOrchestratorSessionId} marked done.`, 'Terminal-remediation done confirmation mismatch');
  truth(terminalCleanup.orchestrator_done, 'terminal_remediation.cleanup.orchestrator_done');
  truth(terminalCleanup.orchestrator_session_stopped, 'terminal_remediation.cleanup.orchestrator_session_stopped');
  truth(terminalCleanup.worker_session_stopped, 'terminal_remediation.cleanup.worker_session_stopped');
  truth(terminalCleanup.worker_worktree_removed, 'terminal_remediation.cleanup.worker_worktree_removed');
  truth(terminalCleanup.stale_ownership_absent, 'terminal_remediation.cleanup.stale_ownership_absent');

  if (requirePublication) {
    const publication = object(publicationEvidence, 'issue #63 publication evidence');
    assert(publication.issue_number === 63, 'Receipt was not published to issue #63');
    assert(publication.author === 'Samsen879', 'Receipt publication has the wrong author');
    assert(Date.parse(timestamp(publication.created_at, 'receipt publication created_at')) >= Date.parse(terminalDonePublishedAt), 'Receipt was published before terminal-remediation durable Orchestrator completion evidence');
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
    terminal_admission_comment: terminalAdmission.comment_id,
    terminal_remediation_pr: remediationPr.number,
    reviewed_head: principalPr.reviewed_head,
    merge_sha: terminalMergeSha,
    review_count: reviews.length,
    terminal_reviewed_head: remediationPr.reviewed_head,
    terminal_review_count: terminalReviews.length,
  };
}

export function loadSelfHostingReceipt(receiptPath) {
  try {
    return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read self-hosting receipt: ${error.message}`);
  }
}
