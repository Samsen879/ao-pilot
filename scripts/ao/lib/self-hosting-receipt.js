import fs from 'node:fs';

import { loadRuntimeLock } from './runtime-lock.js';

export const SELF_HOSTING_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v1';

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

function truth(value, field) {
  assert(value === true, `${field} must be true`);
  return true;
}

function falsehood(value, field) {
  assert(value === false, `${field} must be false`);
  return false;
}

export function verifySelfHostingReceipt(receipt, {
  runtimeLock = loadRuntimeLock().lock,
} = {}) {
  const value = object(receipt, 'receipt');
  assert(value.schema_version === SELF_HOSTING_RECEIPT_SCHEMA_VERSION, 'Unsupported self-hosting receipt schema');
  assert(value.status === 'passed', 'Self-hosting receipt is not passed');
  string(value.performed_at, 'performed_at');

  const environment = object(value.environment, 'environment');
  assert(environment.kind === 'fresh_workstation', 'Self-hosting proof must use a fresh workstation');
  falsehood(environment.old_home_read, 'environment.old_home_read');
  falsehood(environment.old_runtime_state_read, 'environment.old_runtime_state_read');
  falsehood(environment.credentials_copied, 'environment.credentials_copied');
  truth(environment.credentials_user_provided, 'environment.credentials_user_provided');
  falsehood(environment.global_npm_link_used, 'environment.global_npm_link_used');

  const source = object(value.source, 'source');
  assert(source.repository === 'https://github.com/Samsen879/ao-pilot.git', 'Unexpected ao-pilot source repository');
  sha(source.clone_head_sha, 'source.clone_head_sha');
  sha(source.clone_tree_sha, 'source.clone_tree_sha');
  truth(source.clean_before_bootstrap, 'source.clean_before_bootstrap');

  const runtime = object(value.runtime, 'runtime');
  assert(runtime.runtime_ref === runtimeLock.runtime_ref, 'Runtime ref does not match the committed lock');
  assert(runtime.repository === runtimeLock.artifact.repository, 'Runtime repository does not match the committed lock');
  assert(runtime.version === runtimeLock.artifact.version, 'Runtime version does not match the committed lock');
  assert(runtime.tag === runtimeLock.artifact.ref.name, 'Runtime tag does not match the committed lock');
  assert(runtime.commit_sha === runtimeLock.artifact.ref.commit_sha, 'Runtime commit does not match the committed lock');
  assert(runtime.tree_sha === runtimeLock.artifact.ref.tree_sha, 'Runtime tree does not match the committed lock');
  assert(runtime.integrity?.algorithm === runtimeLock.artifact.integrity.algorithm, 'Runtime integrity algorithm mismatch');
  assert(runtime.integrity?.digest === runtimeLock.artifact.integrity.digest, 'Runtime integrity digest mismatch');
  string(runtime.binary_path, 'runtime.binary_path');
  assert(/^[0-9a-f]{64}$/.test(string(runtime.binary_sha256, 'runtime.binary_sha256')), 'Invalid runtime.binary_sha256');
  assert(runtimeLock.compatibility.platforms.some((target) => target.binary_sha256 === runtime.binary_sha256), 'Runtime binary digest is not locked');

  const bootstrap = object(value.bootstrap, 'bootstrap');
  assert(bootstrap.command === './scripts/bootstrap.sh', 'Unexpected bootstrap command');
  assert(['installed', 'reused', 'reinstalled'].includes(bootstrap.status), 'Invalid bootstrap.status');
  assert(bootstrap.doctor_runtime_status === 'verified', 'Doctor did not verify the runtime');

  const delivery = object(value.delivery, 'delivery');
  assert(delivery.issue_number === 63, 'Self-hosting delivery must implement P0-R08 issue #63');
  truth(delivery.worker_created_by_new_ao, 'delivery.worker_created_by_new_ao');
  string(delivery.worker_worktree_path, 'delivery.worker_worktree_path');
  const principalPr = object(delivery.principal_pr, 'delivery.principal_pr');
  assert(Number.isInteger(principalPr.number) && principalPr.number > 0, 'Invalid delivery.principal_pr.number');
  assert(/^https:\/\/github\.com\/Samsen879\/ao-pilot\/pull\/\d+$/.test(string(principalPr.url, 'delivery.principal_pr.url')), 'Invalid principal PR URL');
  const reviewedHead = sha(principalPr.reviewed_head, 'delivery.principal_pr.reviewed_head');
  assert(principalPr.ci_conclusion === 'success', 'Principal PR CI is not green');
  assert(Array.isArray(principalPr.codex_reviews) && principalPr.codex_reviews.length >= 1 && principalPr.codex_reviews.length <= 2, 'Self-hosting proof requires one or two Codex Reviews');
  assert(principalPr.codex_reviews.some((review) => sha(review.head_sha, 'review.head_sha') === reviewedHead), 'No Codex Review binds the reviewed HEAD');
  truth(principalPr.merged, 'delivery.principal_pr.merged');
  sha(principalPr.merge_sha, 'delivery.principal_pr.merge_sha');

  const replay = object(value.exact_main_replay, 'exact_main_replay');
  truth(replay.passed, 'exact_main_replay.passed');
  assert(sha(replay.main_sha, 'exact_main_replay.main_sha') === principalPr.merge_sha, 'Exact-main replay is not bound to the merge SHA');

  const cleanup = object(value.cleanup, 'cleanup');
  truth(cleanup.session_stopped, 'cleanup.session_stopped');
  truth(cleanup.worker_worktree_removed, 'cleanup.worker_worktree_removed');
  truth(cleanup.stale_ownership_absent, 'cleanup.stale_ownership_absent');

  const claim = object(value.claim, 'claim');
  truth(claim.workstation_self_hosting, 'claim.workstation_self_hosting');
  truth(claim.p0_r08_satisfied, 'claim.p0_r08_satisfied');

  return {
    status: 'verified',
    schema_version: value.schema_version,
    issue_number: delivery.issue_number,
    runtime_ref: runtime.runtime_ref,
    ao_pilot_head: source.clone_head_sha,
    principal_pr: principalPr.number,
    reviewed_head: reviewedHead,
    merge_sha: principalPr.merge_sha,
    review_count: principalPr.codex_reviews.length,
  };
}

export function loadAndVerifySelfHostingReceipt(receiptPath, options = {}) {
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read self-hosting receipt: ${error.message}`);
  }
  return verifySelfHostingReceipt(receipt, options);
}
