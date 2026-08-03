import fs from 'node:fs';
import path from 'node:path';

import { ORCHESTRATOR_DONE_EVIDENCE_SCHEMA_VERSION } from './orchestrator-done-evidence.js';
import {
  PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION,
} from './premerge-verification-evidence.js';
import { loadRuntimeLock } from './runtime-lock.js';

export const SELF_HOSTING_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v7';
export const TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-terminal-merge-evidence.v1';
export const TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION = 'ao.workstation-terminal-merge-publication.v1';
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
export const TERMINAL_WORKTREE_EVIDENCE_SCHEMA_VERSION = 'ao.workstation-worktree-evidence.v6';
export const TERMINAL_RECOVERY_CHAIN_SCHEMA_VERSION = 'ao.workstation-terminal-recovery-chain.v2';
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
export const P0_R08_FAILED_MERGE_PATH_PR = 73;
export const P0_R08_FAILED_MERGE_PATH_HEAD = 'd504a154f946da57284bf05b9788b5aa7e87a0ce';
export const P0_R08_FAILED_MERGE_PATH_REVIEWED_HEAD = '338805cf4a53963d400cadc5556511616b95784d';
export const P0_R08_FAILED_MERGE_PATH_DISPOSITION_COMMENT = 5163542954;
export const P0_R08_FAILED_MERGE_PATH_DISPOSITION_BYTES = 3574;
export const P0_R08_FAILED_MERGE_PATH_DISPOSITION_SHA256 = 'd8ff4994fba918ed8ecfb954ba1352da21661a405c5331f5f8422bdb8ce7be5c';
export const P0_R08_ARCHITECTURAL_BLOCKER_COMMENT = 5163606282;
export const P0_R08_ARCHITECTURAL_BLOCKER_BYTES = 2036;
export const P0_R08_ARCHITECTURAL_BLOCKER_SHA256 = '0fb549f8ff0651a87fe83c1f1179605866a864b36adc7b62092655f3cf05f401';
export const P0_R08_FINAL_ADMISSION_COMMENT = 5163994984;
export const P0_R08_FINAL_ADMISSION_BYTES = 5406;
export const P0_R08_FINAL_ADMISSION_SHA256 = '2005f4deceae2f69a9e332a040fb72664dbd2d0618cfa119ef7c00894599e1ca';
export const P0_R08_FINAL_ADMITTED_MAIN = 'fe9bcd9eeba08453aeb003036a5dce76926314ff';
export const P0_R08_FINAL_ADMITTED_TREE = 'a619bcc0fc57a7312b36368501ba54714eb2373e';
export const P0_R08_FINAL_RECOVERY_PR = 74;
export const P0_R08_PRINCIPAL_RUNTIME_REF = 'runtime.agent_orchestrator.v0_11_2_p0_1';
export const P0_R08_PRINCIPAL_RUNTIME_TAG = 'ao-pilot-runtime-v0.11.2-p0.1';
export const P0_R08_PRINCIPAL_RUNTIME_COMMIT = '711178ebe07d436db36020eb08f0c4e29613f97b';
export const P0_R08_PRINCIPAL_RUNTIME_TREE = '479fba6fd44f251f0c66fafc5cb5d638a6ff590a';
export const P0_R08_PRINCIPAL_RUNTIME_X64_SHA256 = 'a403e096203e68e94dde5f45922b0880a4a2dd662c38aab3f0af6d47ec56aa34';
export const P0_R08_PRINCIPAL_RUNTIME_ARM64_SHA256 = '132164dc29349ea2082d77d6758b3617be81c7cfcf27d3f0ba9a88d65a88c752';
export const P0_R08_RUNTIME_PR = 8;
export const P0_R08_RUNTIME_REF = 'runtime.agent_orchestrator.v0_11_2_p0_2';
export const P0_R08_RUNTIME_TAG = 'ao-pilot-runtime-v0.11.2-p0.2';
export const P0_R08_RUNTIME_TAG_OBJECT = '450ae009e2c1eb48cdf9c19be676b4a4ff01e611';
export const P0_R08_RUNTIME_COMMIT = 'aae8a684357271acc7ad2fa1d4116c7c65c8fa9d';
export const P0_R08_RUNTIME_TREE = 'e8adb9a31068810becfb5d31b46688b04202cf81';
export const P0_R08_RUNTIME_X64_SHA256 = 'ad7fd23c6a3f495e2d10b130cf23227c14e30573db5c2c01b68d8214c5965b4d';
export const P0_R08_RUNTIME_ARM64_SHA256 = '972181d92085fb6772fd9a8edf688f68c290976eda67a282ba1ac83d985d2dc6';
export const P0_R08_TERMINAL_ROOT = '/home/guoqy/p0-r08-terminal-remediation';
export const P0_R08_TERMINAL_AO_DATA_DIR = `${P0_R08_TERMINAL_ROOT}/ao-state/data`;
export const P0_R08_TERMINAL_AO_RUN_FILE = `${P0_R08_TERMINAL_ROOT}/ao-state/running.json`;
export const P0_R08_TERMINAL_RUNTIME_BINARY = `/home/guoqy/p0-r08-retry-workstation/runtime-store/${P0_R08_RUNTIME_REF}/linux-x64/${P0_R08_RUNTIME_COMMIT}/bin/ao`;
export const P0_R08_TERMINAL_RUNTIME_BINARY_SHA256 = P0_R08_RUNTIME_X64_SHA256;
export const REQUIRED_CI_CHECKS = ['fresh-clone-runtime', 'test (20)', 'test (22)'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, field) {
  assert(value != null && typeof value === 'object' && !Array.isArray(value), `Invalid ${field}`);
  return value;
}

function exactKeys(value, field, expected) {
  const item = object(value, field);
  const actual = Object.keys(item).sort();
  const required = [...expected].sort();
  assert(JSON.stringify(actual) === JSON.stringify(required), `Invalid ${field} keys`);
  return item;
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

function verifySupervisorProcessBinding(value, { sessionId, runtimeLaunchId }, field) {
  const binding = object(value, field);
  assert(Number.isSafeInteger(binding.supervisor_pid) && binding.supervisor_pid > 1, `${field}.supervisor_pid is invalid`);
  string(binding.supervisor_process_start_token, `${field}.supervisor_process_start_token`);
  assert(binding.supervisor_executable_path === P0_R08_TERMINAL_RUNTIME_BINARY, `${field} used the wrong supervisor executable`);
  assert(binding.supervisor_executable_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, `${field} supervisor executable digest mismatch`);
  assert(/^[0-9a-f]{64}$/.test(binding.supervisor_command_sha256), `${field} supervisor command digest is invalid`);
  assert(binding.session_id === sessionId && binding.runtime_launch_id === runtimeLaunchId, `${field} session/launch binding mismatch`);
  truth(binding.current_process_is_descendant, `${field}.current_process_is_descendant`);
  return binding;
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
  stage = 'final',
} = {}) {
  const value = object(receipt, 'receipt');
  assert(['final', 'pre_merge'].includes(stage), 'Unsupported self-hosting verification stage');
  const preMerge = stage === 'pre_merge';
  assert(value.schema_version === SELF_HOSTING_RECEIPT_SCHEMA_VERSION, 'Unsupported self-hosting receipt schema');
  assert(value.status === (preMerge ? 'pending' : 'passed'), `Self-hosting receipt status is invalid for ${stage}`);
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
  const terminalAdmission = exactKeys(terminal.admission, 'terminal_remediation.admission', [
    'issue_number', 'comment_id', 'comment_body_bytes', 'comment_body_sha256',
    'principal_pr_number', 'admitted_main_sha', 'admitted_tree_sha',
  ]);
  assert(terminalAdmission.issue_number === 63, 'Terminal-remediation admission is not bound to issue #63');
  assert(terminalAdmission.comment_id === P0_R08_FINAL_ADMISSION_COMMENT, 'Final terminal-remediation admission comment ID mismatch');
  assert(terminalAdmission.comment_body_bytes === P0_R08_FINAL_ADMISSION_BYTES, 'Final terminal-remediation admission byte length mismatch');
  assert(terminalAdmission.comment_body_sha256 === P0_R08_FINAL_ADMISSION_SHA256, 'Final terminal-remediation admission comment digest mismatch');
  assert(terminalAdmission.principal_pr_number === P0_R08_PRINCIPAL_PR, 'Terminal-remediation admission does not preserve principal PR #71');
  assert(sha(terminalAdmission.admitted_main_sha, 'terminal_remediation.admission.admitted_main_sha') === P0_R08_FINAL_ADMITTED_MAIN, 'Terminal-remediation admitted main mismatch');
  assert(sha(terminalAdmission.admitted_tree_sha, 'terminal_remediation.admission.admitted_tree_sha') === P0_R08_FINAL_ADMITTED_TREE, 'Terminal-remediation admitted tree mismatch');
  const liveTerminalAdmission = object(github.terminal_remediation_admission, 'GitHub terminal-remediation admission comment');
  assert(liveTerminalAdmission.comment_id === terminalAdmission.comment_id, 'Live terminal-remediation admission comment ID mismatch');
  assert(liveTerminalAdmission.issue_number === 63, 'Terminal-remediation admission was not published to issue #63');
  assert(liveTerminalAdmission.author === 'Samsen879' && liveTerminalAdmission.author_association === 'OWNER', 'Terminal-remediation admission is not Owner-authored');
  const terminalAdmittedAt = timestamp(liveTerminalAdmission.created_at, 'terminal-remediation admission created_at');
  assert(terminalAdmittedAt === '2026-08-03T08:23:19Z', 'Final recovery admission created_at mismatch');
  assert(liveTerminalAdmission.updated_at === terminalAdmittedAt, 'Terminal-remediation admission comment was edited');
  assert(liveTerminalAdmission.body_bytes === P0_R08_FINAL_ADMISSION_BYTES, 'Live final admission byte length mismatch');
  assert(liveTerminalAdmission.body_sha256 === terminalAdmission.comment_body_sha256, 'Live terminal-remediation admission digest mismatch');

  const recoveryChain = exactKeys(value.terminal_recovery_chain, 'terminal_recovery_chain', ['schema_version', 'standing_admission', 'attempts']);
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
  const liveStanding = object(github.standing_recovery_admission, 'GitHub standing recovery admission');
  assert(liveStanding.comment_id === standing.comment_id && liveStanding.issue_number === 63 && liveStanding.author === 'Samsen879' && liveStanding.author_association === 'OWNER', 'Standing recovery admission identity mismatch');
  assert(liveStanding.created_at === standing.created_at && liveStanding.updated_at === standing.updated_at && liveStanding.body_bytes === standing.comment_body_bytes && liveStanding.body_sha256 === standing.comment_body_sha256, 'Standing recovery admission was edited or drifted');

  assert(Array.isArray(recoveryChain.attempts) && recoveryChain.attempts.length === 3, 'Recovery chain must be exactly [72 failed, 73 failed_merge_path_provenance, 74 active/final]');
  const failedAttempt = exactKeys(recoveryChain.attempts[0], 'terminal_recovery_chain.attempts[0]', ['attempt', 'kind', 'disposition', 'admission', 'pr', 'failure']);
  assert(failedAttempt.attempt === 1 && failedAttempt.kind === 'terminal_recovery_delivery' && failedAttempt.disposition === 'failed_premerge_gates', 'PR #72 must be the first failed recovery-chain attempt');
  const failedAdmission = object(failedAttempt.admission, 'terminal_recovery_chain.attempts[0].admission');
  assert(failedAdmission.comment_id === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT && failedAdmission.comment_body_sha256 === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256, 'Failed attempt does not preserve its first terminal admission');
  assert(sha(failedAdmission.admitted_main_sha, 'failed terminal admitted_main_sha') === P0_R08_FIRST_TERMINAL_ADMITTED_MAIN && sha(failedAdmission.admitted_tree_sha, 'failed terminal admitted_tree_sha') === P0_R08_FIRST_TERMINAL_ADMITTED_TREE, 'Failed attempt admission baseline mismatch');
  const liveFirstAdmission = object(github.first_terminal_admission, 'GitHub first terminal admission');
  assert(liveFirstAdmission.comment_id === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT && liveFirstAdmission.issue_number === 63 && liveFirstAdmission.author === 'Samsen879' && liveFirstAdmission.author_association === 'OWNER', 'First terminal admission identity mismatch');
  const firstTerminalAdmittedAt = timestamp(liveFirstAdmission.created_at, 'first terminal admission created_at');
  assert(firstTerminalAdmittedAt === liveFirstAdmission.updated_at && liveFirstAdmission.body_sha256 === P0_R08_FIRST_TERMINAL_ADMISSION_COMMENT_SHA256, 'First terminal admission was edited or drifted');

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

  const mergePathAttempt = exactKeys(recoveryChain.attempts[1], 'terminal_recovery_chain.attempts[1]', ['attempt', 'kind', 'disposition', 'predecessor_pr_number', 'admission_comment_id', 'pr', 'failure']);
  assert(mergePathAttempt.attempt === 2 && mergePathAttempt.kind === 'terminal_recovery_delivery' && mergePathAttempt.disposition === 'failed_merge_path_provenance', 'PR #73 must be the second failed recovery-chain attempt');
  assert(mergePathAttempt.predecessor_pr_number === P0_R08_FAILED_TERMINAL_PR && mergePathAttempt.admission_comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT, 'PR #73 recovery-chain authority mismatch');
  const mergePathPr = exactKeys(mergePathAttempt.pr, 'terminal_recovery_chain.attempts[1].pr', [
    'number', 'url', 'head_sha', 'reviewed_head', 'codex_reviews', 'finding_comment_ids',
    'worktree_evidence_comment_id', 'premerge_evidence_comment_id', 'merge_sha', 'merge_tree_sha', 'merged_at',
  ]);
  assert(mergePathPr.number === P0_R08_FAILED_MERGE_PATH_PR && mergePathPr.url === 'https://github.com/Samsen879/ao-pilot/pull/73', 'Failed merge-path attempt is not PR #73');
  assert(sha(mergePathPr.head_sha, 'PR #73 head') === P0_R08_FAILED_MERGE_PATH_HEAD && sha(mergePathPr.reviewed_head, 'PR #73 reviewed head') === P0_R08_FAILED_MERGE_PATH_REVIEWED_HEAD, 'PR #73 immutable head evidence mismatch');
  assert(mergePathPr.merge_sha === P0_R08_FINAL_ADMITTED_MAIN && mergePathPr.merge_tree_sha === P0_R08_FINAL_ADMITTED_TREE && mergePathPr.merged_at === '2026-08-03T07:23:43Z', 'PR #73 immutable merge outcome mismatch');
  assert(mergePathPr.worktree_evidence_comment_id === 5163418525 && mergePathPr.premerge_evidence_comment_id === 5163443629, 'PR #73 immutable publication evidence mismatch');
  const mergePathReviews = verifyCompletedCodexReviews(mergePathPr.codex_reviews, github.failed_merge_path_codex_reviews);
  assert(mergePathReviews.length === 2 && mergePathReviews[0].evidence_id === 4838853686 && mergePathReviews[1].evidence_id === 4840588410, 'PR #73 completed review evidence mismatch');
  const expectedMergePathFindings = [3699415314, 3699415317, 3699415320, 3701145692, 3701145696, 3701145702, 3701145705, 3701145707, 3701145710];
  assert(JSON.stringify(mergePathPr.finding_comment_ids) === JSON.stringify(expectedMergePathFindings), 'PR #73 finding evidence is incomplete, extra, or reordered');
  assert(Array.isArray(github.failed_merge_path_review_findings) && JSON.stringify(github.failed_merge_path_review_findings.map((item) => item.comment_id)) === JSON.stringify(expectedMergePathFindings) && github.failed_merge_path_review_findings.every((item) => item.resolved === true), 'Live PR #73 finding evidence drifted or is unresolved');
  const liveMergePathPr = object(github.failed_merge_path_pr, 'GitHub failed merge-path PR #73');
  assert(liveMergePathPr.number === P0_R08_FAILED_MERGE_PATH_PR && liveMergePathPr.merged === true && liveMergePathPr.base_ref === 'main', 'PR #73 is not the immutable merged second attempt');
  assert(liveMergePathPr.head_sha === mergePathPr.head_sha && liveMergePathPr.merge_sha === mergePathPr.merge_sha && liveMergePathPr.merge_tree_sha === mergePathPr.merge_tree_sha && liveMergePathPr.merged_at === mergePathPr.merged_at, 'Live PR #73 outcome drifted');
  for (const field of ['failed_merge_path_worktree_evidence', 'failed_merge_path_premerge_evidence']) {
    const published = object(github[field], `GitHub PR #73 ${field}`);
    const expectedId = field.endsWith('worktree_evidence') ? mergePathPr.worktree_evidence_comment_id : mergePathPr.premerge_evidence_comment_id;
    assert(published.comment_id === expectedId && published.issue_number === 63 && published.author === 'Samsen879' && published.author_association === 'OWNER' && published.created_at === published.updated_at, `PR #73 ${field} identity/edit state mismatch`);
  }
  const mergePathFailure = exactKeys(mergePathAttempt.failure, 'terminal_recovery_chain.attempts[1].failure', [
    'disposition_comment_id', 'disposition_comment_body_bytes', 'disposition_comment_body_sha256',
    'disposition_created_at', 'disposition_updated_at', 'architectural_blocker_comment_id',
    'provider_mutation', 'ao_merge_executed', 'reason_codes',
  ]);
  assert(mergePathFailure.disposition_comment_id === P0_R08_FAILED_MERGE_PATH_DISPOSITION_COMMENT && mergePathFailure.disposition_comment_body_bytes === P0_R08_FAILED_MERGE_PATH_DISPOSITION_BYTES && mergePathFailure.disposition_comment_body_sha256 === P0_R08_FAILED_MERGE_PATH_DISPOSITION_SHA256, 'PR #73 disposition bytes/digest mismatch');
  assert(mergePathFailure.disposition_created_at === '2026-08-03T07:32:36Z' && mergePathFailure.disposition_updated_at === mergePathFailure.disposition_created_at, 'PR #73 disposition edit state mismatch');
  assert(mergePathFailure.architectural_blocker_comment_id === P0_R08_ARCHITECTURAL_BLOCKER_COMMENT && mergePathFailure.provider_mutation === 'gh_pr_merge_exact_head_guarded' && mergePathFailure.ao_merge_executed === false, 'PR #73 merge-path provenance was rewritten');
  assert(JSON.stringify(mergePathFailure.reason_codes) === JSON.stringify(['pinned_ao_merge_route_not_implemented', 'provider_mutation_not_executed_by_ao']), 'PR #73 failure reasons are incomplete or unordered');
  const liveMergePathFailure = object(github.failed_merge_path_disposition, 'GitHub PR #73 fail-closed disposition');
  assert(liveMergePathFailure.comment_id === mergePathFailure.disposition_comment_id && liveMergePathFailure.body_bytes === mergePathFailure.disposition_comment_body_bytes && liveMergePathFailure.body_sha256 === mergePathFailure.disposition_comment_body_sha256 && liveMergePathFailure.created_at === mergePathFailure.disposition_created_at && liveMergePathFailure.updated_at === mergePathFailure.disposition_updated_at, 'PR #73 fail-closed disposition drifted');

  const blocker = exactKeys(value.runtime_transition?.architectural_blocker, 'runtime_transition.architectural_blocker', ['comment_id', 'comment_body_bytes', 'comment_body_sha256', 'created_at', 'updated_at']);
  assert(blocker.comment_id === P0_R08_ARCHITECTURAL_BLOCKER_COMMENT && blocker.comment_body_bytes === P0_R08_ARCHITECTURAL_BLOCKER_BYTES && blocker.comment_body_sha256 === P0_R08_ARCHITECTURAL_BLOCKER_SHA256 && blocker.created_at === '2026-08-03T07:40:30Z' && blocker.updated_at === blocker.created_at, 'Architectural blocker evidence mismatch');
  const liveBlocker = object(github.architectural_blocker, 'GitHub architectural blocker');
  assert(liveBlocker.comment_id === blocker.comment_id && liveBlocker.issue_number === 63 && liveBlocker.author === 'Samsen879' && liveBlocker.author_association === 'OWNER' && liveBlocker.body_bytes === blocker.comment_body_bytes && liveBlocker.body_sha256 === blocker.comment_body_sha256 && liveBlocker.created_at === blocker.created_at && liveBlocker.updated_at === blocker.updated_at, 'Architectural blocker drifted');
  const transition = exactKeys(value.runtime_transition, 'runtime_transition', ['architectural_blocker', 'admission', 'predecessor', 'successor']);
  const transitionAdmission = exactKeys(transition.admission, 'runtime_transition.admission', ['comment_id', 'comment_body_bytes', 'comment_body_sha256', 'created_at', 'updated_at']);
  assert(transitionAdmission.comment_id === P0_R08_FINAL_ADMISSION_COMMENT && transitionAdmission.comment_body_bytes === P0_R08_FINAL_ADMISSION_BYTES && transitionAdmission.comment_body_sha256 === P0_R08_FINAL_ADMISSION_SHA256 && transitionAdmission.created_at === terminalAdmittedAt && transitionAdmission.updated_at === terminalAdmittedAt, 'Runtime transition admission mismatch');
  const predecessorRuntime = exactKeys(transition.predecessor, 'runtime_transition.predecessor', ['runtime_ref', 'commit_sha', 'tree_sha', 'linux_x64_binary_sha256']);
  assert(predecessorRuntime.runtime_ref === 'runtime.agent_orchestrator.v0_11_2_p0_1' && predecessorRuntime.commit_sha === '711178ebe07d436db36020eb08f0c4e29613f97b' && predecessorRuntime.tree_sha === '479fba6fd44f251f0c66fafc5cb5d638a6ff590a' && predecessorRuntime.linux_x64_binary_sha256 === 'a403e096203e68e94dde5f45922b0880a4a2dd662c38aab3f0af6d47ec56aa34', 'Predecessor runtime evidence was rewritten');
  const successorRuntime = exactKeys(transition.successor, 'runtime_transition.successor', ['runtime_ref', 'runtime_pr_number', 'runtime_pr_base', 'bootstrap_merge_exception', 'tag', 'tag_object_sha', 'commit_sha', 'tree_sha', 'integrity', 'linux_x64_binary_sha256', 'linux_arm64_binary_sha256']);
  assert(successorRuntime.runtime_ref === P0_R08_RUNTIME_REF && successorRuntime.runtime_pr_number === P0_R08_RUNTIME_PR && successorRuntime.runtime_pr_base === 'runtime-baseline/v0.11.2' && successorRuntime.bootstrap_merge_exception === 'owner_gh_pr_merge_runtime_pr_8_only', 'Successor runtime authority mismatch');
  assert(successorRuntime.tag === P0_R08_RUNTIME_TAG && successorRuntime.tag_object_sha === P0_R08_RUNTIME_TAG_OBJECT && successorRuntime.commit_sha === P0_R08_RUNTIME_COMMIT && successorRuntime.tree_sha === P0_R08_RUNTIME_TREE && successorRuntime.integrity?.algorithm === 'git-tree-sha1' && successorRuntime.integrity?.digest === P0_R08_RUNTIME_TREE && successorRuntime.linux_x64_binary_sha256 === P0_R08_RUNTIME_X64_SHA256 && successorRuntime.linux_arm64_binary_sha256 === P0_R08_RUNTIME_ARM64_SHA256, 'Successor runtime artifact evidence mismatch');
  const liveRuntimePr = object(github.runtime_pr, 'GitHub runtime prerequisite PR #8');
  assert(liveRuntimePr.number === P0_R08_RUNTIME_PR && liveRuntimePr.merged === true && liveRuntimePr.base_ref === 'runtime-baseline/v0.11.2' && liveRuntimePr.merge_sha === P0_R08_RUNTIME_COMMIT && liveRuntimePr.merge_tree_sha === P0_R08_RUNTIME_TREE, 'Live runtime prerequisite PR outcome drifted');
  const liveRuntimeTag = object(github.runtime_tag, 'GitHub p0.2 runtime tag');
  assert(liveRuntimeTag.tag === P0_R08_RUNTIME_TAG && liveRuntimeTag.tag_object_sha === P0_R08_RUNTIME_TAG_OBJECT && liveRuntimeTag.commit_sha === P0_R08_RUNTIME_COMMIT, 'Live p0.2 annotated tag drifted');

  const activeAttempt = exactKeys(recoveryChain.attempts[2], 'terminal_recovery_chain.attempts[2]', ['attempt', 'kind', 'disposition', 'predecessor_pr_number', 'admission_comment_id', 'pr_number', 'worktree_evidence_comment_id']);
  assert(activeAttempt.attempt === 3 && activeAttempt.kind === 'terminal_recovery_delivery' && activeAttempt.disposition === (preMerge ? 'pending' : 'passed'), 'Current recovery delivery has the wrong ordered attempt/disposition');
  assert(activeAttempt.predecessor_pr_number === P0_R08_FAILED_MERGE_PATH_PR, 'Current recovery delivery does not follow failed PR #73');
  assert(activeAttempt.admission_comment_id === P0_R08_FINAL_ADMISSION_COMMENT && activeAttempt.pr_number === P0_R08_FINAL_RECOVERY_PR, 'Current recovery delivery is not bound to final Owner admission/PR #74');

  const runtime = object(value.runtime, 'runtime');
  assert(runtime.runtime_ref === P0_R08_PRINCIPAL_RUNTIME_REF, 'Historical principal runtime ref mismatch');
  assert(runtime.repository === 'https://github.com/Samsen879/agent-orchestrator.git', 'Historical principal runtime repository mismatch');
  assert(runtime.version === '0.11.2-p0.1' && runtime.tag === P0_R08_PRINCIPAL_RUNTIME_TAG, 'Historical principal runtime version/tag mismatch');
  assert(runtime.commit_sha === P0_R08_PRINCIPAL_RUNTIME_COMMIT && runtime.tree_sha === P0_R08_PRINCIPAL_RUNTIME_TREE, 'Historical principal runtime commit/tree mismatch');
  assert(runtime.integrity?.algorithm === 'git-tree-sha1' && runtime.integrity?.digest === P0_R08_PRINCIPAL_RUNTIME_TREE, 'Historical principal runtime integrity mismatch');
  const runtimeBinaryPath = canonicalAbsolutePath(runtime.binary_path, 'runtime.binary_path');
  assert(/^[0-9a-f]{64}$/.test(string(runtime.binary_sha256, 'runtime.binary_sha256')), 'Invalid runtime.binary_sha256');
  const runtimeTarget = object(runtime.target, 'runtime.target');
  const principalDigests = { x64: P0_R08_PRINCIPAL_RUNTIME_X64_SHA256, arm64: P0_R08_PRINCIPAL_RUNTIME_ARM64_SHA256 };
  assert(runtimeTarget.os === 'linux' && Object.hasOwn(principalDigests, runtimeTarget.arch), 'Historical principal runtime target is unsupported');
  assert(principalDigests[runtimeTarget.arch] === runtime.binary_sha256, 'Historical principal runtime binary digest mismatch');
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
      && Date.parse(createdAt) < Date.parse(firstTerminalAdmittedAt);
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
  assert(runtimeLock.runtime_ref === P0_R08_RUNTIME_REF && runtimeLock.artifact.ref.commit_sha === P0_R08_RUNTIME_COMMIT && runtimeLock.artifact.ref.tree_sha === P0_R08_RUNTIME_TREE, 'Committed lock is not the admitted p0.2 successor runtime');
  assert(terminalEnvironment.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY, 'Terminal remediation did not use the admitted immutable p0.2 runtime binary');
  assert(terminalEnvironment.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Terminal-remediation p0.2 runtime digest mismatch');

  const terminalSource = object(terminal.source, 'terminal_remediation.source');
  assert(terminalSource.repository === source.repository, 'Terminal-remediation source repository mismatch');
  const terminalSourceHead = sha(terminalSource.clone_head_sha, 'terminal_remediation.source.clone_head_sha');
  const terminalSourceTree = sha(terminalSource.clone_tree_sha, 'terminal_remediation.source.clone_tree_sha');
  assert(terminalSourceHead === P0_R08_FINAL_ADMITTED_MAIN && terminalSourceTree === P0_R08_FINAL_ADMITTED_TREE, 'Terminal-remediation source is not exact final admitted main/tree');
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
  if (preMerge) falsehood(terminalDelivery.github_merge_outcome_confirmed, 'terminal_remediation.delivery.github_merge_outcome_confirmed');
  else truth(terminalDelivery.github_merge_outcome_confirmed, 'terminal_remediation.delivery.github_merge_outcome_confirmed');
  const remediationPr = object(terminalDelivery.remediation_pr, 'terminal_remediation.delivery.remediation_pr');
  assert(remediationPr.number === P0_R08_FINAL_RECOVERY_PR, 'Terminal recovery must use final non-principal PR #74');
  assert(activeAttempt.pr_number === remediationPr.number, 'Recovery-chain attempt 3 PR does not match the terminal delivery');
  assert(remediationPr.url === `https://github.com/Samsen879/ao-pilot/pull/${remediationPr.number}`, 'Invalid terminal-remediation PR URL');
  const liveRemediationPr = object(github.terminal_remediation_pr, 'GitHub terminal-remediation PR');
  assert(liveRemediationPr.number === remediationPr.number, 'Terminal-remediation PR number does not match GitHub');
  assert(liveRemediationPr.head_ref === terminalBranch && liveRemediationPr.base_ref === 'main', 'Terminal-remediation PR branch/base mismatch');
  assert(liveRemediationPr.linked_issue_63 === true, 'Terminal-remediation PR is not linked to issue #63');
  assert(liveRemediationPr.binds_terminal_admission === true, 'Terminal-recovery PR does not bind standing admission comment 5158510418');
  assert(liveRemediationPr.binds_principal_pr_71 === true, 'Terminal-remediation PR does not preserve principal PR #71');
  assert(liveRemediationPr.binds_failed_terminal_pr_72 === true, 'Terminal-recovery PR does not bind failed chain attempt PR #72');
  assert(liveRemediationPr.binds_failed_merge_path_pr_73 === true, 'Terminal-recovery PR does not bind failed merge-path attempt PR #73');
  assert(liveRemediationPr.binds_architectural_blocker === true, 'Terminal-recovery PR does not bind architectural blocker comment 5163606282');
  assert(liveRemediationPr.binds_final_admission === true, 'Terminal-recovery PR does not bind final p0.2 admission comment 5163994984');
  assert(liveRemediationPr.auto_closes_issue_63 === false, 'Terminal-remediation PR must not auto-close issue #63');
  assert(Date.parse(timestamp(liveRemediationPr.created_at, 'terminal-remediation PR created_at')) >= Date.parse(terminalAdmittedAt), 'Terminal-remediation PR predates admission');
  const terminalFinalHead = sha(remediationPr.head_sha, 'terminal_remediation.delivery.remediation_pr.head_sha');
  assert(liveRemediationPr.head_sha === terminalFinalHead, 'Terminal-remediation PR final HEAD mismatch');
  const terminalLinkedPrs = github.issue_linked_prs.filter((linkedPr) => Date.parse(timestamp(linkedPr.created_at, `issue-linked PR #${linkedPr.number} created_at`)) >= Date.parse(terminalAdmittedAt));
  assert(terminalLinkedPrs.length === 1 && terminalLinkedPrs[0].number === remediationPr.number, 'Issue #63 must have exactly one admitted terminal-remediation PR and no extra linked deliveries');
  const terminalRecoveryLinkedPrs = github.issue_linked_prs.filter((linkedPr) => Date.parse(timestamp(linkedPr.created_at, `issue-linked PR #${linkedPr.number} created_at`)) >= Date.parse(firstTerminalAdmittedAt));
  assert(JSON.stringify(terminalRecoveryLinkedPrs.map((linkedPr) => linkedPr.number)) === JSON.stringify([P0_R08_FAILED_TERMINAL_PR, P0_R08_FAILED_MERGE_PATH_PR, remediationPr.number]), 'Issue #63 terminal recovery deliveries must be exactly ordered PR #72, PR #73, then active PR #74');
  assert(Date.parse(terminalRecoveryLinkedPrs[0].created_at) < Date.parse(terminalAdmittedAt), 'Failed PR #72 is not isolated to the first terminal-admission layer');
  assert(remediationPr.ci_conclusion === 'success', 'Terminal-remediation PR CI is not green');
  assert(Array.isArray(github.terminal_check_runs), 'Live terminal-remediation CI evidence is unavailable');
  for (const checkName of REQUIRED_CI_CHECKS) assert(github.terminal_check_runs.some((check) => check.name === checkName && check.conclusion === 'success'), `Terminal-remediation required CI is not green: ${checkName}`);
  const terminalReviews = verifyCompletedCodexReviews(remediationPr.codex_reviews, github.terminal_codex_reviews);
  assert(Array.isArray(github.terminal_review_findings), 'Live terminal-remediation review finding evidence is unavailable');
  assert(Array.isArray(remediationPr.finding_dispositions), 'Terminal-remediation finding dispositions are unavailable');
  assert(remediationPr.finding_dispositions.length === github.terminal_review_findings.length, 'Terminal-remediation finding disposition evidence is incomplete');
  assert(new Set(remediationPr.finding_dispositions.map((item) => item.comment_id)).size === remediationPr.finding_dispositions.length, 'Duplicate terminal-remediation finding disposition');
  for (const disposition of remediationPr.finding_dispositions) {
    const liveFinding = github.terminal_review_findings.find((finding) => finding.comment_id === disposition.comment_id && finding.review_id === disposition.review_id);
    assert(liveFinding?.resolved === true, `Terminal-remediation finding is unresolved or missing: ${disposition.comment_id}`);
    assert(disposition.disposition === 'fixed' && disposition.resolved === true, `Terminal-remediation finding lacks a fixed/resolved disposition: ${disposition.comment_id}`);
    assert(terminalReviews.some((review) => review.evidence_id === disposition.review_id), `Terminal-remediation finding is not bound to a completed review: ${disposition.comment_id}`);
  }
  const terminalReviewedHead = sha(remediationPr.reviewed_head, 'terminal_remediation.delivery.remediation_pr.reviewed_head');
  assert(terminalReviews.at(-1).head_sha === terminalReviewedHead, 'Terminal-remediation reviewed HEAD mismatch');
  if (terminalFinalHead !== terminalReviewedHead) {
    const terminalRepair = object(remediationPr.post_review_2_repair, 'terminal_remediation.delivery.remediation_pr.post_review_2_repair');
    assert(terminalReviews.length === 2 && terminalReviews.at(-1).kind === 'submitted_review', 'Unreviewed terminal-remediation final HEAD is allowed only after Review 2 findings');
    assert(terminalRepair.authorization_ref === 'https://github.com/Samsen879/ao-pilot/issues/63#issuecomment-5163994984', 'Terminal-recovery post-Review-2 repair lacks exact final Owner authorization');
    assert(sha(terminalRepair.final_head_sha, 'terminal-remediation post_review_2_repair.final_head_sha') === terminalFinalHead, 'Terminal-remediation post-Review-2 repair does not bind final HEAD');
    assert(Array.isArray(terminalRepair.finding_comment_ids) && terminalRepair.finding_comment_ids.length > 0, 'Terminal-remediation post-Review-2 repair has no finding IDs');
    assert(Array.isArray(github.terminal_review_findings), 'Live terminal-remediation review finding evidence is unavailable');
    const terminalFindings = github.terminal_review_findings.filter((finding) => finding.review_id === terminalReviews.at(-1).evidence_id);
    assert(terminalFindings.length === terminalRepair.finding_comment_ids.length, 'Terminal-remediation post-Review-2 finding evidence is incomplete');
    for (const findingId of terminalRepair.finding_comment_ids) {
      const liveFinding = terminalFindings.find((finding) => finding.comment_id === findingId);
      assert(liveFinding?.resolved === true, `Terminal-remediation Review 2 finding is unresolved or missing: ${findingId}`);
    }
    assert(repository.terminal_reviewed_head_is_ancestor === true && repository.terminal_reviewed_head_merge_base_sha === terminalReviewedHead, 'Post-Review-2 repaired final HEAD does not descend from the reviewed HEAD');
  } else {
    assert(remediationPr.post_review_2_repair == null, 'Unexpected terminal-remediation post-Review-2 repair claim');
  }
  let terminalMergeSha = null;
  let terminalMergeTree = null;
  let terminalMergedAt = null;
  if (preMerge) {
    assert(terminal.merge_execution == null, 'Pre-merge receipt must not claim AO merge execution evidence');
    falsehood(remediationPr.merged, 'terminal_remediation.delivery.remediation_pr.merged');
    assert(remediationPr.merge_sha == null && remediationPr.merge_tree_sha == null, 'Pre-merge receipt must not claim a merge SHA/tree');
    assert(liveRemediationPr.merged === false && liveRemediationPr.merge_sha == null && liveRemediationPr.merge_tree_sha == null && liveRemediationPr.merged_at == null, 'Live recovery PR already has a merge outcome during pre-merge verification');
    assert(repository.current_main_sha === terminalFinalHead && repository.current_main_tree_sha === repository.terminal_worker_tree_sha, 'Pre-merge release check did not run on the exact recovery PR final HEAD/tree');
  } else {
    truth(remediationPr.merged, 'terminal_remediation.delivery.remediation_pr.merged');
    assert(liveRemediationPr.merged === true, 'Terminal-remediation PR is not merged on GitHub');
    terminalMergeSha = sha(remediationPr.merge_sha, 'terminal_remediation.delivery.remediation_pr.merge_sha');
    terminalMergeTree = sha(remediationPr.merge_tree_sha, 'terminal_remediation.delivery.remediation_pr.merge_tree_sha');
    assert(liveRemediationPr.merge_sha === terminalMergeSha && liveRemediationPr.merge_tree_sha === terminalMergeTree, 'Terminal-remediation merge SHA/tree mismatch');
    terminalMergedAt = timestamp(liveRemediationPr.merged_at, 'terminal-remediation PR merged_at');
    for (const review of terminalReviews) assert(Date.parse(review.completed_at) <= Date.parse(terminalMergedAt), `Terminal-remediation Codex Review attempt ${review.attempt} completed after merge`);
  }

  const terminalWorktreeCapture = object(github.terminal_worktree_capture, 'GitHub terminal-remediation worktree capture');
  assert(terminalWorktreeCapture.comment_id === terminalWorktreeCommentId && terminalWorktreeCapture.issue_number === 63 && terminalWorktreeCapture.author === 'Samsen879' && terminalWorktreeCapture.author_association === 'OWNER', 'Terminal-remediation worktree evidence identity mismatch');
  const terminalWorktreePublishedAt = timestamp(terminalWorktreeCapture.created_at, 'terminal-remediation worktree evidence created_at');
  assert(terminalWorktreeCapture.updated_at === terminalWorktreePublishedAt, 'Terminal-remediation worktree evidence was edited');
  const terminalCaptured = object(terminalWorktreeCapture.payload, 'terminal-remediation worktree payload');
  assert(terminalCaptured.schema_version === TERMINAL_WORKTREE_EVIDENCE_SCHEMA_VERSION && terminalCaptured.issue_number === 63, 'Unsupported terminal-remediation worktree evidence');
  const terminalCapturedAt = timestamp(terminalCaptured.captured_at, 'terminal-remediation worktree captured_at');
  assert(Date.parse(terminalCapturedAt) >= Date.parse(terminalAdmittedAt) && Date.parse(terminalCapturedAt) <= Date.parse(terminalWorktreePublishedAt), 'Terminal-remediation worktree evidence is outside the admitted publication window');
  if (!preMerge) assert(Date.parse(terminalWorktreePublishedAt) <= Date.parse(terminalMergedAt), 'Terminal-remediation worktree evidence was published after merge');
  assert(terminalCaptured.source.clone_path === terminalClonePath && terminalCaptured.source.head_sha === terminalSourceHead && terminalCaptured.source.tree_sha === terminalSourceTree, 'Terminal-remediation captured source mismatch');
  assert(terminalCaptured.isolation.remediation_root === terminalRoot && terminalCaptured.isolation.ao_data_dir === terminalAoDataDir && terminalCaptured.isolation.ao_run_file === terminalAoRunFile, 'Terminal-remediation captured isolation mismatch');
  assert(terminalCaptured.recovery_chain?.standing_admission_comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT && terminalCaptured.recovery_chain?.final_admission_comment_id === P0_R08_FINAL_ADMISSION_COMMENT && terminalCaptured.recovery_chain?.attempt === 3 && terminalCaptured.recovery_chain?.prior_attempt_pr_number === P0_R08_FAILED_MERGE_PATH_PR, 'Terminal worktree evidence is not bound to ordered final recovery attempt 3');
  assert(terminalCaptured.recovery_chain?.admitted_main_sha === P0_R08_FINAL_ADMITTED_MAIN && terminalCaptured.recovery_chain?.admitted_tree_sha === P0_R08_FINAL_ADMITTED_TREE, 'Terminal worktree evidence final baseline mismatch');
  assert(terminalCaptured.worker.session_id === terminalWorkerSessionId && terminalCaptured.worker.worktree_path === terminalWorkerPath && terminalCaptured.worker.branch === terminalBranch && terminalCaptured.worker.head_sha === terminalFinalHead, 'Terminal-remediation captured Worker mismatch');
  assert(terminalCaptured.worker.tree_sha === repository.terminal_worker_tree_sha, 'Terminal-remediation captured Worker tree mismatch');
  assert(terminalCaptured.git_relationship?.source_is_ancestor === true, 'Captured source is not an ancestor of the recovery Worker');
  assert(terminalCaptured.git_relationship?.merge_base_sha === terminalSourceHead, 'Captured recovery Worker merge base is not the standing baseline');
  assert(terminalCaptured.git_relationship?.branch_creation_sha === terminalSourceHead, 'Captured recovery Worker branch was not created at the standing baseline');
  const terminalBranchCreatedAt = timestamp(terminalCaptured.git_relationship?.branch_creation_at, 'terminal-remediation Worker branch creation timestamp');
  assert(terminalCaptured.git_relationship?.branch_creation_subject?.startsWith('branch: Created from '), 'Captured recovery Worker lacks a branch-creation reflog event');
  assert(terminalCaptured.git_relationship?.worker_session_created_at === terminalBranchCreatedAt || Math.abs(Date.parse(terminalCaptured.git_relationship?.worker_session_created_at) - Date.parse(terminalBranchCreatedAt)) < 2_000, 'Captured Worker branch creation is not bound to AO Worker session creation');
  assert(repository.terminal_source_is_ancestor === true && repository.terminal_merge_base_sha === terminalSourceHead, 'Live Git history does not confirm the captured recovery fork relationship');
  if (preMerge) assert(repository.terminal_branch_creation_sha === terminalSourceHead && repository.terminal_branch_creation_at === terminalBranchCreatedAt, 'Live Worker branch-creation evidence drifted from the published capture');
  assert(activeAttempt.worktree_evidence_comment_id === terminalWorktreeCommentId, 'Recovery-chain attempt 3 does not bind the terminal worktree evidence');
  const terminalSourceGitCommonDir = canonicalAbsolutePath(terminalCaptured.source.git_common_dir, 'terminal-remediation captured source git_common_dir');
  const terminalWorkerGitCommonDir = canonicalAbsolutePath(terminalCaptured.worker.git_common_dir, 'terminal-remediation captured Worker git_common_dir');
  assertPathResolvesWithin(terminalRoot, terminalSourceGitCommonDir, 'Terminal-remediation captured source git common directory');
  assertPathResolvesWithin(terminalRoot, terminalWorkerGitCommonDir, 'Terminal-remediation captured Worker git common directory');
  assert(terminalWorkerGitCommonDir === terminalSourceGitCommonDir && terminalCaptured.worker.worktree_path !== terminalCaptured.source.clone_path, 'Terminal-remediation Worker is not an independent worktree of the admitted clone');

  const orchestratorProvenance = object(terminalCaptured.orchestrator_provenance, 'terminal-remediation Orchestrator worktree provenance');
  assert(orchestratorProvenance.schema_version === 'ao.workstation-orchestrator-worktree-provenance.v2', 'Unsupported worktree Orchestrator provenance');
  assert(orchestratorProvenance.session_id === terminalOrchestratorSessionId && orchestratorProvenance.worker_session_id === terminalWorkerSessionId, 'Worktree evidence session provenance mismatch');
  assert(orchestratorProvenance.project_id === 'ao-pilot-remediation' && orchestratorProvenance.issue_number === 63 && orchestratorProvenance.kind === 'orchestrator', 'Worktree evidence was not captured by the issue #63 Orchestrator');
  assert(orchestratorProvenance.activity_state === 'active' && orchestratorProvenance.is_terminated === false, 'Worktree evidence Orchestrator was not active');
  string(orchestratorProvenance.runtime_launch_id, 'terminal-remediation Orchestrator runtime_launch_id');
  assert(orchestratorProvenance.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && orchestratorProvenance.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Worktree evidence used unverified Orchestrator runtime provenance');
  assert(JSON.stringify(orchestratorProvenance.session_get?.args) === JSON.stringify(['session', 'get', terminalOrchestratorSessionId, '--json']), 'Worktree evidence did not query the exact Orchestrator session');
  assert(JSON.stringify(orchestratorProvenance.session_get?.worker_args) === JSON.stringify(['session', 'get', terminalWorkerSessionId, '--json']), 'Worktree evidence did not query the exact Worker session');
  assert(orchestratorProvenance.operation?.capture === true && orchestratorProvenance.operation?.publish_issue_comment === true && orchestratorProvenance.operation?.read_back_exact_body === true, 'Worktree evidence lacks complete Orchestrator operation provenance');
  const worktreeProcessBinding = verifySupervisorProcessBinding(orchestratorProvenance.process_binding, {
    sessionId: terminalOrchestratorSessionId,
    runtimeLaunchId: orchestratorProvenance.runtime_launch_id,
  }, 'terminal-remediation worktree Orchestrator process binding');

  const worktreePublication = object(terminalDelivery.worktree_evidence_publication, 'terminal_remediation.delivery.worktree_evidence_publication');
  assert(worktreePublication.schema_version === 'ao.workstation-orchestrator-worktree-publication.v2', 'Unsupported worktree publication receipt');
  assert(worktreePublication.comment_id === terminalWorktreeCommentId && worktreePublication.orchestrator_session_id === terminalOrchestratorSessionId, 'Worktree publication receipt identity mismatch');
  assert(worktreePublication.payload_bytes === terminalWorktreeCapture.body_bytes && worktreePublication.payload_sha256 === terminalWorktreeCapture.body_sha256, 'Worktree publication receipt payload digest/length mismatch');
  assert(worktreePublication.published_at === terminalWorktreePublishedAt && Date.parse(timestamp(worktreePublication.read_back_at, 'worktree evidence read_back_at')) >= Date.parse(terminalWorktreePublishedAt), 'Worktree publication/readback timestamps mismatch');
  truth(worktreePublication.exact_body_read_back, 'terminal_remediation.delivery.worktree_evidence_publication.exact_body_read_back');
  assert(worktreePublication.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && worktreePublication.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Worktree publication receipt runtime provenance mismatch');
  assert(JSON.stringify(worktreePublication.process_binding) === JSON.stringify(worktreeProcessBinding), 'Worktree publication process binding differs from captured Orchestrator provenance');

  if (preMerge) {
    assert(terminal.premerge_verification == null, 'Pending receipt must not claim pre-merge evidence before the staged verifier emits it');
    const pendingReplay = object(terminal.exact_main_replay, 'terminal_remediation.exact_main_replay');
    falsehood(pendingReplay.passed, 'terminal_remediation.exact_main_replay.passed');
    falsehood(pendingReplay.release_check_passed, 'terminal_remediation.exact_main_replay.release_check_passed');
    assert(pendingReplay.main_sha == null && pendingReplay.tree_sha == null, 'Pre-merge receipt must not claim exact-main replay SHA/tree');
    const pendingCleanup = object(terminal.cleanup, 'terminal_remediation.cleanup');
    falsehood(pendingCleanup.orchestrator_done, 'terminal_remediation.cleanup.orchestrator_done');
    assert(pendingCleanup.orchestrator_done_evidence_comment_id === 0, 'Pre-merge receipt must not claim Orchestrator-done evidence');
    falsehood(pendingCleanup.orchestrator_session_stopped, 'terminal_remediation.cleanup.orchestrator_session_stopped');
    falsehood(pendingCleanup.worker_session_stopped, 'terminal_remediation.cleanup.worker_session_stopped');
    falsehood(pendingCleanup.worker_worktree_removed, 'terminal_remediation.cleanup.worker_worktree_removed');
    falsehood(pendingCleanup.stale_ownership_absent, 'terminal_remediation.cleanup.stale_ownership_absent');
    const pendingClaim = object(value.claim, 'claim');
    falsehood(pendingClaim.workstation_self_hosting, 'claim.workstation_self_hosting');
    falsehood(pendingClaim.p0_r08_satisfied, 'claim.p0_r08_satisfied');
    assert(publicationEvidence == null && requirePublication === false, 'Pre-merge verification cannot accept terminal receipt publication evidence');
    return {
      status: 'premerge_verified',
      schema_version: value.schema_version,
      issue_number: delivery.issue_number,
      principal_pr: principalPr.number,
      terminal_recovery_pr: remediationPr.number,
      terminal_reviewed_head: remediationPr.reviewed_head,
      terminal_review_count: terminalReviews.length,
      worktree_evidence_comment: terminalWorktreeCommentId,
      orchestrator_session_id: terminalOrchestratorSessionId,
    };
  }

  const premergeVerification = object(terminal.premerge_verification, 'terminal_remediation.premerge_verification');
  const premergeEvidenceCommentId = Number(premergeVerification.evidence_comment_id);
  assert(Number.isSafeInteger(premergeEvidenceCommentId) && premergeEvidenceCommentId > 0, 'Invalid immutable pre-merge evidence comment ID');
  const premergeCapture = object(github.terminal_premerge_capture, 'GitHub terminal-remediation pre-merge evidence');
  assert(premergeCapture.comment_id === premergeEvidenceCommentId && premergeCapture.issue_number === 63 && premergeCapture.author === 'Samsen879' && premergeCapture.author_association === 'OWNER', 'Immutable pre-merge evidence identity mismatch');
  const premergePublishedAt = timestamp(premergeCapture.created_at, 'pre-merge evidence created_at');
  assert(premergeCapture.updated_at === premergePublishedAt && Date.parse(premergePublishedAt) <= Date.parse(terminalMergedAt), 'Pre-merge evidence was edited or published after merge');
  const preflight = object(premergeCapture.payload, 'pre-merge evidence payload');
  assert(preflight.schema_version === PREMERGE_VERIFICATION_EVIDENCE_SCHEMA_VERSION && preflight.issue_number === 63 && preflight.status === 'premerge_verified', 'Unsupported or unsuccessful immutable pre-merge evidence');
  const preflightVerifiedAt = timestamp(preflight.verified_at, 'pre-merge verified_at');
  assert(Date.parse(preflightVerifiedAt) >= Date.parse(terminalWorktreePublishedAt) && Date.parse(preflightVerifiedAt) <= Date.parse(premergePublishedAt), 'Pre-merge verification timestamp is outside its immutable publication window');
  assert(preflight.standing_admission_comment_id === P0_R08_TERMINAL_ADMISSION_COMMENT && preflight.final_admission_comment_id === P0_R08_FINAL_ADMISSION_COMMENT && preflight.recovery_attempt === 3, 'Pre-merge evidence is outside the final standing recovery chain');
  assert(preflight.remediation_pr?.number === remediationPr.number && preflight.remediation_pr?.head_sha === terminalFinalHead && preflight.remediation_pr?.tree_sha === repository.terminal_worker_tree_sha && preflight.remediation_pr?.reviewed_head === terminalReviewedHead, 'Pre-merge evidence does not bind the final PR head/tree/reviewed head');
  assert(JSON.stringify(preflight.remediation_pr?.review_evidence_ids) === JSON.stringify(remediationPr.codex_reviews.map((review) => review.evidence_id)), 'Pre-merge review evidence IDs drifted');
  assert(JSON.stringify(preflight.remediation_pr?.resolved_finding_comment_ids) === JSON.stringify(remediationPr.finding_dispositions.map((finding) => finding.comment_id)), 'Pre-merge resolved finding IDs drifted');
  assert(preflight.release_check?.command === 'npm run release:check' && preflight.release_check?.checkout_head_sha === terminalFinalHead && preflight.release_check?.checkout_tree_sha === repository.terminal_worker_tree_sha && preflight.release_check?.passed === true, 'Pre-merge evidence does not prove release:check on the exact final checkout');
  assert(preflight.git_relationship?.reviewed_head_is_ancestor === true && preflight.git_relationship?.reviewed_head_merge_base_sha === terminalReviewedHead, 'Pre-merge evidence does not preserve reviewed-head ancestry');
  assert(preflight.git_relationship?.source_is_ancestor === true && preflight.git_relationship?.source_merge_base_sha === terminalSourceHead && preflight.git_relationship?.branch_creation_sha === terminalSourceHead && preflight.git_relationship?.branch_creation_at === terminalBranchCreatedAt, 'Pre-merge evidence does not preserve the admitted Worker creation relationship');
  assert(preflight.worktree_evidence?.comment_id === terminalWorktreeCommentId && preflight.worktree_evidence?.published_at === terminalWorktreePublishedAt && preflight.worktree_evidence?.payload_bytes === terminalWorktreeCapture.body_bytes && preflight.worktree_evidence?.payload_sha256 === terminalWorktreeCapture.body_sha256, 'Pre-merge evidence worktree publication identity mismatch');
  assert(JSON.stringify(preflight.orchestrator_provenance) === JSON.stringify(orchestratorProvenance), 'Pre-merge evidence Orchestrator provenance differs from worktree evidence');
  const premergePublication = object(premergeVerification.publication, 'terminal_remediation.premerge_verification.publication');
  assert(premergePublication.schema_version === PREMERGE_VERIFICATION_PUBLICATION_SCHEMA_VERSION && premergePublication.comment_id === premergeEvidenceCommentId && premergePublication.orchestrator_session_id === terminalOrchestratorSessionId, 'Pre-merge publication receipt identity mismatch');
  assert(premergePublication.payload_bytes === premergeCapture.body_bytes && premergePublication.payload_sha256 === premergeCapture.body_sha256 && premergePublication.published_at === premergePublishedAt, 'Pre-merge publication payload/timestamp mismatch');
  assert(Date.parse(timestamp(premergePublication.read_back_at, 'pre-merge evidence read_back_at')) >= Date.parse(premergePublishedAt) && premergePublication.exact_body_read_back === true, 'Pre-merge publication lacks exact post-publication readback');
  assert(premergePublication.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && premergePublication.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'Pre-merge publication runtime provenance mismatch');
  assert(JSON.stringify(premergePublication.process_binding) === JSON.stringify(worktreeProcessBinding), 'Pre-merge publication did not run under the same AO Orchestrator supervisor');

  const mergeExecution = exactKeys(terminal.merge_execution, 'terminal_remediation.merge_execution', ['evidence_comment_id', 'publication']);
  const mergeEvidenceCommentId = Number(mergeExecution.evidence_comment_id);
  assert(Number.isSafeInteger(mergeEvidenceCommentId) && mergeEvidenceCommentId > 0, 'Invalid immutable AO merge evidence comment ID');
  const mergeCapture = object(github.terminal_merge_capture, 'GitHub terminal-remediation AO merge evidence');
  assert(mergeCapture.comment_id === mergeEvidenceCommentId && mergeCapture.issue_number === 63 && mergeCapture.author === 'Samsen879' && mergeCapture.author_association === 'OWNER', 'Immutable AO merge evidence identity mismatch');
  const mergePublishedAt = timestamp(mergeCapture.created_at, 'AO merge evidence created_at');
  assert(mergeCapture.updated_at === mergePublishedAt && Date.parse(mergePublishedAt) >= Date.parse(terminalMergedAt), 'AO merge evidence was edited or published before the merge');
  const mergePayload = exactKeys(mergeCapture.payload, 'AO merge evidence payload', [
    'schema_version', 'issue_number', 'completed_at', 'orchestrator_session_id',
    'recovery_attempt', 'premerge_evidence', 'command', 'effect', 'orchestrator_provenance',
  ]);
  assert(mergePayload.schema_version === TERMINAL_MERGE_EVIDENCE_SCHEMA_VERSION && mergePayload.issue_number === 63 && mergePayload.orchestrator_session_id === terminalOrchestratorSessionId && mergePayload.recovery_attempt === 3, 'AO merge evidence is outside the admitted terminal recovery operation');
  const mergeCompletedAt = timestamp(mergePayload.completed_at, 'AO merge evidence completed_at');
  assert(Date.parse(mergeCompletedAt) >= Date.parse(terminalMergedAt) && Date.parse(mergeCompletedAt) <= Date.parse(mergePublishedAt), 'AO merge execution completion is outside its immutable post-merge publication window');
  const mergePreflight = exactKeys(mergePayload.premerge_evidence, 'AO merge evidence premerge_evidence', ['comment_id', 'payload_sha256']);
  assert(mergePreflight.comment_id === premergeEvidenceCommentId && mergePreflight.payload_sha256 === premergeCapture.body_sha256, 'AO merge execution is not bound to the immutable pre-merge proof');
  const mergeCommand = exactKeys(mergePayload.command, 'AO merge evidence command', ['runtime_binary_path', 'runtime_binary_sha256', 'args', 'exit_code', 'stdout']);
  assert(mergeCommand.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && mergeCommand.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'AO merge command did not use the admitted immutable p0.2 binary');
  assert(JSON.stringify(mergeCommand.args) === JSON.stringify(['pr', 'merge', String(remediationPr.number)]), 'Unexpected AO merge command');
  assert(mergeCommand.exit_code === 0, 'Pinned AO merge command did not succeed');
  assert(mergeCommand.stdout === `merged PR #${remediationPr.number} using squash (head ${terminalFinalHead}, merge commit ${terminalMergeSha})`, 'Pinned AO merge command result mismatch');
  const mergeEffect = exactKeys(mergePayload.effect, 'AO merge evidence effect', [
    'provider_mutation', 'exact_head_guarded', 'ao_merge_executed', 'github_readback_confirmed',
    'pr_number', 'method', 'head_sha', 'merge_commit_sha', 'main_sha', 'main_tree_sha',
  ]);
  assert(mergeEffect.provider_mutation === 'github_squash_merge' && mergeEffect.exact_head_guarded === true && mergeEffect.ao_merge_executed === true && mergeEffect.github_readback_confirmed === true, 'AO merge effect provenance is incomplete');
  assert(mergeEffect.pr_number === remediationPr.number && mergeEffect.method === 'squash' && mergeEffect.head_sha === terminalFinalHead && mergeEffect.merge_commit_sha === terminalMergeSha, 'AO merge effect does not bind PR #74 exact HEAD/outcome');
  assert(mergeEffect.main_sha === terminalMergeSha && mergeEffect.main_tree_sha === terminalMergeTree, 'AO merge effect does not bind exact main SHA/tree readback');
  assert(JSON.stringify(mergePayload.orchestrator_provenance) === JSON.stringify(orchestratorProvenance), 'AO merge evidence Orchestrator provenance differs from pre-merge evidence');
  const mergePublication = exactKeys(mergeExecution.publication, 'terminal_remediation.merge_execution.publication', [
    'schema_version', 'issue_number', 'comment_id', 'published_at', 'read_back_at',
    'payload_bytes', 'payload_sha256', 'exact_body_read_back', 'orchestrator_session_id',
    'runtime_binary_path', 'runtime_binary_sha256', 'process_binding',
  ]);
  assert(mergePublication.schema_version === TERMINAL_MERGE_PUBLICATION_SCHEMA_VERSION && mergePublication.issue_number === 63 && mergePublication.comment_id === mergeEvidenceCommentId && mergePublication.orchestrator_session_id === terminalOrchestratorSessionId, 'AO merge publication receipt identity mismatch');
  assert(mergePublication.payload_bytes === mergeCapture.body_bytes && mergePublication.payload_sha256 === mergeCapture.body_sha256 && mergePublication.published_at === mergePublishedAt, 'AO merge publication payload/timestamp mismatch');
  assert(Date.parse(timestamp(mergePublication.read_back_at, 'AO merge evidence read_back_at')) >= Date.parse(mergePublishedAt) && mergePublication.exact_body_read_back === true, 'AO merge publication lacks exact post-publication readback');
  assert(mergePublication.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && mergePublication.runtime_binary_sha256 === P0_R08_TERMINAL_RUNTIME_BINARY_SHA256, 'AO merge publication runtime provenance mismatch');
  assert(JSON.stringify(mergePublication.process_binding) === JSON.stringify(worktreeProcessBinding), 'AO merge publication did not run under the same p0.2 Orchestrator supervisor');

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
  assert(terminalDone.command.runtime_binary_path === P0_R08_TERMINAL_RUNTIME_BINARY && terminalDone.command.exit_code === 0, 'Terminal-remediation done used unverified p0.2 runtime or failed');
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
