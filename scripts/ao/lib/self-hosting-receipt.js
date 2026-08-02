import fs from 'node:fs';
import path from 'node:path';

import { loadRuntimeLock } from './runtime-lock.js';

export const SELF_HOSTING_RECEIPT_SCHEMA_VERSION = 'ao.workstation-self-hosting-receipt.v1';
export const P0_R07_ADMISSION_PR = 69;
export const P0_R07_ADMITTED_MAIN = 'be8ea9d408920e0728ac980097db758796144714';
export const P0_R07_ADMITTED_TREE = '00f93b164a75af044e63532fc7ac64479a390ab9';
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
      head_sha: sha(item.head_sha, `codex_reviews[${index}].head_sha`),
      completed_at: timestamp(item.completed_at, `codex_reviews[${index}].completed_at`),
    };
    assert(Number.isSafeInteger(normalizedItem.evidence_id) && normalizedItem.evidence_id > 0, `Invalid codex_reviews[${index}].evidence_id`);
    const live = liveReviews.find((candidate) => (
      candidate.kind === normalizedItem.kind
      && candidate.evidence_id === normalizedItem.evidence_id
    ));
    assert(live != null, `Codex Review attempt ${item.attempt} has no live completion evidence`);
    assert(live.actor === 'chatgpt-codex-connector[bot]', `Codex Review attempt ${item.attempt} has the wrong actor`);
    assert(live.head_sha === normalizedItem.head_sha, `Codex Review attempt ${item.attempt} head mismatch`);
    assert(live.completed_at === normalizedItem.completed_at, `Codex Review attempt ${item.attempt} completion timestamp mismatch`);
    assert(live.completed === true, `Codex Review attempt ${item.attempt} is not completed`);
    return normalizedItem;
  });
  assert(new Set(normalized.map((review) => `${review.kind}:${review.evidence_id}`)).size === normalized.length, 'Duplicate Codex Review evidence');
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

  const source = object(value.source, 'source');
  assert(source.repository === 'https://github.com/Samsen879/ao-pilot.git', 'Unexpected ao-pilot source repository');
  assert(source.admission_pr_number === P0_R07_ADMISSION_PR, 'Source is not bound to the P0-R07 admission PR');
  const sourceHead = sha(source.clone_head_sha, 'source.clone_head_sha');
  const sourceTree = sha(source.clone_tree_sha, 'source.clone_tree_sha');
  assert(sourceHead === P0_R07_ADMITTED_MAIN, 'Fresh clone is not the exact admitted P0-R07 main');
  assert(sourceTree === P0_R07_ADMITTED_TREE, 'Fresh clone tree is not the exact admitted P0-R07 tree');
  const sourceClonePath = string(source.clone_path, 'source.clone_path');
  assert(path.isAbsolute(sourceClonePath), 'source.clone_path must be absolute');
  truth(source.clean_before_bootstrap, 'source.clean_before_bootstrap');

  const repository = object(repositoryEvidence, 'repository evidence');
  assert(repository.source_commit_sha === sourceHead, 'Repository source commit evidence mismatch');
  assert(repository.source_tree_sha === sourceTree, 'Repository commit-to-tree binding mismatch');

  const github = object(githubEvidence, 'GitHub evidence');
  const admissionPr = object(github.admission_pr, 'GitHub admission PR');
  assert(admissionPr.number === P0_R07_ADMISSION_PR && admissionPr.merged === true, 'P0-R07 admission PR is not merged');
  assert(admissionPr.base_ref === 'main', 'P0-R07 admission PR did not target main');
  assert(admissionPr.merge_sha === sourceHead, 'Fresh clone is not bound to the P0-R07 merge SHA');

  const runtime = object(value.runtime, 'runtime');
  assert(runtime.runtime_ref === runtimeLock.runtime_ref, 'Runtime ref does not match the committed lock');
  assert(runtime.repository === runtimeLock.artifact.repository, 'Runtime repository does not match the committed lock');
  assert(runtime.version === runtimeLock.artifact.version, 'Runtime version does not match the committed lock');
  assert(runtime.tag === runtimeLock.artifact.ref.name, 'Runtime tag does not match the committed lock');
  assert(runtime.commit_sha === runtimeLock.artifact.ref.commit_sha, 'Runtime commit does not match the committed lock');
  assert(runtime.tree_sha === runtimeLock.artifact.ref.tree_sha, 'Runtime tree does not match the committed lock');
  assert(runtime.integrity?.algorithm === runtimeLock.artifact.integrity.algorithm, 'Runtime integrity algorithm mismatch');
  assert(runtime.integrity?.digest === runtimeLock.artifact.integrity.digest, 'Runtime integrity digest mismatch');
  assert(path.isAbsolute(string(runtime.binary_path, 'runtime.binary_path')), 'runtime.binary_path must be absolute');
  assert(/^[0-9a-f]{64}$/.test(string(runtime.binary_sha256, 'runtime.binary_sha256')), 'Invalid runtime.binary_sha256');
  const runtimeTarget = object(runtime.target, 'runtime.target');
  const lockedTarget = runtimeLock.compatibility.platforms.find((target) => (
    target.os === runtimeTarget.os && target.arch === runtimeTarget.arch
  ));
  assert(lockedTarget != null, 'Runtime target is not supported by the lock');
  assert(lockedTarget.binary_sha256 === runtime.binary_sha256, 'Runtime binary digest does not match the workstation target');

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
  const workerWorktreePath = string(delivery.worker_worktree_path, 'delivery.worker_worktree_path');
  assert(path.isAbsolute(workerWorktreePath), 'delivery.worker_worktree_path must be absolute');
  assert(path.resolve(workerWorktreePath) !== path.resolve(sourceClonePath), 'Worker worktree must be distinct from the bootstrap clone');
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
  const livePrincipalPr = object(github.principal_pr, 'GitHub principal PR');
  assert(principalPr.number === livePrincipalPr.number, 'Principal PR number does not match GitHub');
  assert(principalPr.url === `https://github.com/Samsen879/ao-pilot/pull/${principalPr.number}`, 'Invalid principal PR URL');
  assert(/^ao\//.test(delivery.worker_branch), 'Worker branch is not AO-owned');
  assert(livePrincipalPr.head_ref === delivery.worker_branch, 'Live PR branch does not match the Worker branch');
  assert(livePrincipalPr.linked_issue_63 === true, 'Live PR is not authoritatively linked to issue #63');
  const finalHead = sha(principalPr.head_sha, 'delivery.principal_pr.head_sha');
  assert(livePrincipalPr.head_sha === finalHead, 'Principal PR final HEAD does not match GitHub');
  assert(livePrincipalPr.base_ref === 'main', 'Principal PR did not target main');
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

  const replay = object(value.exact_main_replay, 'exact_main_replay');
  truth(replay.passed, 'exact_main_replay.passed');
  truth(replay.release_check_passed, 'exact_main_replay.release_check_passed');
  truth(repository.release_check_passed, 'repository evidence release_check_passed');
  assert(sha(replay.main_sha, 'exact_main_replay.main_sha') === mergeSha, 'Exact-main replay is not bound to the merge SHA');
  const replayTree = sha(replay.tree_sha, 'exact_main_replay.tree_sha');
  assert(repository.current_main_sha === mergeSha, 'Verifier checkout is not exact post-merge main');
  assert(repository.current_main_tree_sha === replayTree, 'Exact-main replay tree does not match verifier checkout');

  const cleanup = object(value.cleanup, 'cleanup');
  truth(cleanup.orchestrator_session_stopped, 'cleanup.orchestrator_session_stopped');
  truth(cleanup.worker_session_stopped, 'cleanup.worker_session_stopped');
  truth(cleanup.worker_worktree_removed, 'cleanup.worker_worktree_removed');
  truth(cleanup.stale_ownership_absent, 'cleanup.stale_ownership_absent');

  if (requirePublication) {
    const publication = object(publicationEvidence, 'issue #63 publication evidence');
    assert(publication.issue_number === 63, 'Receipt was not published to issue #63');
    assert(publication.author === 'Samsen879', 'Receipt publication has the wrong author');
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
