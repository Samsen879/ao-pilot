import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const OWNERSHIP_DURATION_POLICY_VERSION = 'ao.ownership-duration.v1';
export const MAX_OWNERSHIP_LEASE_DURATION_MS = 60 * 60 * 1000;
const ADMISSION_MAX_AGE_MS = 5 * 60 * 1000;
const sha = value => createHash('sha256').update(value).digest('hex');
export const canonicalOwnershipJson = value => JSON.stringify(value, (_, item) => (
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item
));
function reject(reason) {
  throw Object.assign(new Error(`Ownership first-acquire refused: ${reason}`), { code: 'OWNERSHIP_FIRST_ACQUIRE_REFUSED' });
}
export function validateOwnershipDurationMs(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_OWNERSHIP_LEASE_DURATION_MS) reject('duration must be an integer from1 through3600000ms');
  return value;
}
export function parseOwnershipDurationMs(raw) {
  if (typeof raw !== 'string' || !/^[1-9][0-9]*$/.test(raw)) reject('duration must be canonical positive decimal milliseconds');
  return validateOwnershipDurationMs(Number(raw));
}
export function checkedOwnershipExpiry(now, durationMs) {
  validateOwnershipDurationMs(durationMs);
  const start = new Date(now).getTime(), end = start + durationMs;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isFinite(new Date(end).getTime())) reject('invalid or overflowing expiry timestamp');
  return new Date(end).toISOString();
}
export function ownershipDurationPolicyIdentity() {
  return { schema_version: OWNERSHIP_DURATION_POLICY_VERSION,
    policy_source_sha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    max_duration_ms: MAX_OWNERSHIP_LEASE_DURATION_MS };
}
export function fingerprintOwnershipTaskState(state, taskId) {
  const footprint = { task_id: taskId };
  for (const name of ['managed_tasks', 'task_specs', 'ownership_leases', 'pr_bindings']) {
    footprint[name] = (state?.[name] ?? []).filter(row => row.task_id === taskId)
      .map(row => JSON.parse(JSON.stringify(row)))
      .sort((a, b) => canonicalOwnershipJson(a).localeCompare(canonicalOwnershipJson(b)));
  }
  return sha(canonicalOwnershipJson(footprint));
}
function privateBytes(file) {
  if (typeof process.getuid !== 'function') reject('private admission owner identity unavailable');
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) reject('canonical private admission file required');
  for (let cursor = file; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) reject('admission symlink');
  }
  const st = fs.statSync(file);
  if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o077)) reject('admission ownership/mode');
  return fs.readFileSync(file);
}
function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) reject('canonical UTC admission timestamp required');
  return Date.parse(value);
}
// No registry writer, renewal, auth provider or global user-stop API is added.
// This is a cooperative task-scoped request/precondition, not an authority grant.
export function validateOwnershipDurationInput(options) {
  const durationMs = validateOwnershipDurationMs(options.ownershipDurationMs);
  if (options.command !== 'enroll' || options.expiresAt != null) reject('custom duration only supports first enroll, no expiresAt override');
  if (!options.ownerSessionName || !options.ownerSessionId || !options.branchName || !options.worktreePath || typeof options.taskSpecBody !== 'string') reject('explicit actor, branch, worktree and TaskSpec required');
  if (path.resolve(options.worktreePath) !== options.worktreePath || fs.realpathSync(options.worktreePath) !== options.worktreePath) reject('canonical worktree required');
  const bytes = privateBytes(options.ownershipAdmissionFile);
  if (!/^[a-f0-9]{64}$/.test(options.ownershipAdmissionSha256 ?? '') || sha(bytes) !== options.ownershipAdmissionSha256) reject('admission raw hash differs');
  const admission = JSON.parse(bytes);
  const keys = ['schema_version','operation_id','project_id','task_id','actor','branch_name','worktree_path','task_spec_raw_sha256','expected_task_state_sha256','issued_at','valid_until','stop_path','policy_source_sha256'];
  if (Object.keys(admission).sort().join() !== keys.sort().join()
    || admission.schema_version !== 'ao.ownership-first-acquire-admission.v1'
    || !/^[A-Za-z0-9_-]{8,100}$/.test(admission.operation_id)) reject('admission schema/operation differs');
  if (admission.project_id !== options.projectId || admission.task_id !== options.taskId
    || admission.actor?.session_name !== options.ownerSessionName || admission.actor?.session_id !== options.ownerSessionId
    || Object.keys(admission.actor ?? {}).sort().join() !== 'session_id,session_name'
    || admission.branch_name !== options.branchName || admission.worktree_path !== options.worktreePath
    || admission.task_spec_raw_sha256 !== sha(Buffer.from(options.taskSpecBody))
    || !/^[a-f0-9]{64}$/.test(admission.expected_task_state_sha256 ?? '')) reject('actor/task/spec/binding differs');
  const policy = ownershipDurationPolicyIdentity();
  if (admission.policy_source_sha256 !== policy.policy_source_sha256) reject('policy source differs');
  const issued = timestamp(admission.issued_at), until = timestamp(admission.valid_until);
  if (until <= issued || until - issued > ADMISSION_MAX_AGE_MS) reject('admission lifetime exceeds bounded precondition validity');
  const stop = path.join(path.dirname(options.ownershipAdmissionFile), `${admission.operation_id}.STOP`);
  if (admission.stop_path !== stop) reject('scoped STOP path differs');
  return { durationMs, admission, policy, requestSha256: sha(bytes) };
}
export function assertOwnershipFirstAcquire(options, state, now) {
  const request = validateOwnershipDurationInput(options);
  const current = new Date(typeof now === 'function' ? now() : now).getTime();
  if (!Number.isFinite(current) || current < timestamp(request.admission.issued_at) || current >= timestamp(request.admission.valid_until)) reject('stale/future admission');
  checkedOwnershipExpiry(new Date(current).toISOString(), request.durationMs);
  try { fs.lstatSync(request.admission.stop_path); reject('scoped STOP exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (fingerprintOwnershipTaskState(state, options.taskId) !== request.admission.expected_task_state_sha256) reject('task-state fingerprint changed');
  for (const name of ['managed_tasks','task_specs','ownership_leases','pr_bindings']) {
    if ((state[name] ?? []).some(row => row.task_id === options.taskId)) reject('not a genuinely fresh first acquire; no renewal/revival/replacement');
  }
  return request;
}
