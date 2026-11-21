import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStateRepository } from '../../lib/repository.js';
import { canonicalOwnershipJson, fingerprintOwnershipTaskState } from '../../lib/contracts.js';
import { makeFixture, writeAdmission, runPublic, argsFor, readOfficial, sha } from './fixtures/ownership-duration-cli-worker.mjs';
const { test, afterEach } = process.env.JEST_WORKER_ID ? await import('@jest/globals') : await import('node:test');
const roots = []; const children = [];
const fixture = () => { const f = makeFixture(); roots.push(f.repoRoot); return f; };
afterEach(async () => {
  // These are own bounded fixture processes only, never runtime/unknown PIDs.
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function saved(f) {
  const r = readOfficial(f); return { state: r.state, audit: r.audit };
}
function bootstrap(f) {
  const argv = argsFor(f, null); argv[argv.indexOf('--task') + 1] = 'unrelated-default-task';
  const r = runPublic(f, argv); assert.equal(r.status, 0, r.stderr);
}
for (const duration of [null, 1, 1800000, 3600000]) test(`actual public CLI persists/readbacks duration ${duration ?? 'legacy20min'}`, () => {
  const f = fixture(), r = runPublic(f, argsFor(f, duration)); assert.equal(r.status, 0, r.stderr);
  const state = readOfficial(f), lease = state.state.ownership_leases.find(x => x.task_id === f.taskId);
  assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), duration ?? 1200000);
  const commandAudit = state.audit.filter(x => x.entity_kind === 'managed_task_command' && x.entity_id === f.taskId);
  assert.equal(commandAudit.length, 1);
  if (duration === null) assert.equal(lease.metadata.ownership_acquisition, undefined);
  else {
    const proof = lease.metadata.ownership_acquisition;
    assert.equal(proof.requested_duration_ms, duration); assert.equal(proof.granted_duration_ms, duration);
    assert.equal(proof.request_sha256, f.admissionSha256); assert.equal(proof.actor.session_name, f.owner);
    const spec = state.state.task_specs.find(x => x.task_id === f.taskId);
    assert.equal(proof.task_spec_record_sha256, sha(canonicalOwnershipJson(spec)));
    assert.deepEqual(commandAudit[0].details.ownership_duration, proof);
  }
});
for (const raw of ['0', '-1', '1.5', '3600001', '1e6', 'garbage', '9007199254740992']) test(`public parser rejects ${raw} before state creation`, () => {
  const f = fixture(), r = runPublic(f, argsFor(f, raw)); assert.notEqual(r.status, 0);
  assert.equal(readOfficial(f).state, null);
});
test('public parser refuses duplicate or incomplete custom options before state creation', () => {
  const f = fixture();
  assert.notEqual(runPublic(f, [...argsFor(f), '--ownership-duration-ms', '1800000']).status, 0);
  const incomplete = argsFor(f); incomplete.splice(incomplete.indexOf('--ownership-admission-sha256'), 2);
  assert.notEqual(runPublic(f, incomplete).status, 0);
  assert.equal(readOfficial(f).state, null);
});
test('private admission refuses readable-by-others and symlink inputs before state creation', () => {
  const f = fixture(); fs.chmodSync(f.admissionFile, 0o644);
  assert.notEqual(runPublic(f).status, 0); assert.equal(readOfficial(f).state, null);
  fs.chmodSync(f.admissionFile, 0o600);
  const symlink = path.join(path.dirname(f.admissionFile), 'link.json'); fs.symlinkSync(f.admissionFile, symlink);
  const argv = argsFor(f); argv[argv.indexOf('--ownership-admission-file') + 1] = symlink;
  assert.notEqual(runPublic(f, argv).status, 0); assert.equal(readOfficial(f).state, null);
});
for (const command of ['adopt', 'resume', 'unmanage', 'retire', 'scan-metadata']) test(`public custom duration refuses unsupported ${command}`, () => {
  const f = fixture(); bootstrap(f); const before = saved(f); const argv = argsFor(f); argv[1] = command;
  assert.notEqual(runPublic(f, argv).status, 0); assert.deepEqual(saved(f), before);
});
for (const fault of ['actor', 'spec', 'source', 'fingerprint', 'stale', 'STOP']) test(`guarded first acquire rejects ${fault} without partial task/audit`, () => {
  const f = fixture(); bootstrap(f);
  if (fault === 'actor') writeAdmission(f, { actor: { session_name: 'foreign-owner', session_id: f.ownerId } });
  if (fault === 'spec') writeAdmission(f, { task_spec_raw_sha256: 'a'.repeat(64) });
  if (fault === 'source') writeAdmission(f, { policy_source_sha256: 'a'.repeat(64) });
  if (fault === 'fingerprint') writeAdmission(f, { expected_task_state_sha256: 'a'.repeat(64) });
  if (fault === 'stale') writeAdmission(f, { issued_at: '2000-01-01T00:00:00.000Z', valid_until: '2000-01-01T00:01:00.000Z' });
  if (fault === 'STOP') fs.writeFileSync(f.admission.stop_path, 'STOP');
  const before = saved(f); assert.notEqual(runPublic(f).status, 0); assert.deepEqual(saved(f), before);
});
for (const status of ['active', 'released', 'expired']) test(`custom route cannot revive/renew existing ${status} lease`, () => {
  const f = fixture(); assert.equal(runPublic(f, argsFor(f, null)).status, 0);
  const repo = createStateRepository({ repoRoot: f.repoRoot, projectId: f.projectId });
  const existing = readOfficial(f).state.ownership_leases.find(x => x.task_id === f.taskId);
  if (status !== 'active') repo.upsertOwnershipLease({ ...existing, status, expires_at: '2000-01-01T00:00:00.000Z' });
  writeAdmission(f); const before = saved(f);
  assert.notEqual(runPublic(f).status, 0); assert.deepEqual(saved(f), before);
});
function worker(f, mode) {
  const releasePath = path.join(f.repoRoot, `release-${children.length}`);
  const entry = fileURLToPath(new URL('./fixtures/ownership-duration-cli-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--fixture-run', JSON.stringify({ fixture: f, argv: argsFor(f), mode, releasePath })],
    { cwd: f.repoRoot, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let output = '', stderr = '', barrierResolve; const barrier = new Promise(resolve => { barrierResolve = resolve; });
  child.stdout.on('data', b => { output += b; if (output.includes('barrier\n')) barrierResolve(); });
  child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => {
    try { resolve({ code, ...JSON.parse(output.trim().split('\n').at(-1)) }); } catch { reject(new Error(stderr + output)); }
  }); });
  return { child, barrier, done, release: () => fs.writeFileSync(releasePath, '') };
}
test('actual public CLI rereads STOP after acquiring state lock', async () => {
  const f = fixture(); bootstrap(f); const before = saved(f);
  const r = await worker(f, 'stop-after-lock').done; assert.notEqual(r.code, 0); assert.deepEqual(saved(f), before);
});
test('actual public CLI full-state CAS refuses an external change during staging', async () => {
  const f = fixture(); bootstrap(f); const priorAudit = readOfficial(f).audit;
  const r = await worker(f, 'cas-after-staging').done; assert.notEqual(r.code, 0); assert.match(r.stderr, /CAS changed/);
  const after = readOfficial(f);
  assert.equal(after.state.updated_at, '2001-01-01T00:00:00.000Z');
  assert.equal(after.state.managed_tasks.some(x => x.task_id === f.taskId), false);
  assert.deepEqual(after.audit, priorAudit); assert.equal(fs.existsSync(after.paths.stateMutationJournalPath), false);
});
test('custom cannot replace a foreign owner even with an updated expected footprint', () => {
  const f = fixture(), foreign = { ...f, owner: 'duration-existing-foreign', ownerId: 'duration-existing-foreign-id' };
  assert.equal(runPublic(foreign, argsFor(foreign, null)).status, 0); writeAdmission(f);
  const before = saved(f); assert.notEqual(runPublic(f).status, 0); assert.deepEqual(saved(f), before);
});
test('default same-owner enrollment retains original expiry, not an implicit renewal', () => {
  const f = fixture(); const first = runPublic(f, argsFor(f, null)); assert.equal(first.status, 0);
  const second = runPublic(f, argsFor(f, null)); assert.equal(second.status, 0);
  assert.equal(second.parsed.ownershipLease.expires_at, first.parsed.ownershipLease.expires_at);
  assert.equal(second.parsed.ownershipLease.acquired_at, first.parsed.ownershipLease.acquired_at);
});
test('concurrent public CLI first acquires serialize and loser cannot overwrite owner/task', async () => {
  const f = fixture(); bootstrap(f); const a = worker(f, 'before-journal'); await a.barrier;
  const other = { ...f, owner: 'duration-fixture-c', ownerId: 'duration-fixture-c-id', operationId: f.operationId + '_c', admissionFile: path.join(path.dirname(f.admissionFile), 'other.json') };
  // Both requests explicitly expect the same pre-commit absent task footprint.
  writeAdmission(other); const b = worker(other, null); a.release();
  const [ra, rb] = await Promise.all([a.done, b.done]); assert.equal(ra.code, 0); assert.notEqual(rb.code, 0);
  const r = readOfficial(f); assert.equal(r.state.ownership_leases.filter(x => x.task_id === f.taskId).length, 1);
  assert.equal(r.state.ownership_leases.find(x => x.task_id === f.taskId).owner_session_name, f.owner);
  assert.equal(r.audit.filter(x => x.entity_id === f.taskId && x.entity_kind === 'managed_task_command').length, 1);
});
for (const mode of ['fault-state', 'fault-audit']) test(`public CLI ${mode} preserves possible commit/no replay`, async () => {
  const f = fixture(); bootstrap(f); const r = await worker(f, mode).done;
  assert.equal(r.code, 3); assert.match(r.stderr, /HOLD_COMMIT_RECOVERY_REQUIRED/);
  assert.equal(fs.existsSync(readOfficial(f).paths.stateMutationJournalPath), true);
  // Explicit controlled fixture recovery is not replaying first enrollment.
  createStateRepository({ repoRoot: f.repoRoot, projectId: f.projectId }).getSnapshot();
  const before = saved(f); assert.notEqual(runPublic(f).status, 0); assert.deepEqual(saved(f), before);
  assert.equal(before.audit.filter(x => x.entity_id === f.taskId && x.entity_kind === 'managed_task_command').length, 1);
});
