// Actual candidate public CLI in ONLY an owned temporary Git/control root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../../bin/ao-pilot.js';
import { fingerprintOwnershipTaskState, ownershipDurationPolicyIdentity } from '../../../lib/contracts.js';
import { resolveControlPlanePaths, readControlPlaneSchema, readControlPlaneState, readControlPlaneAuditEntries } from '../../../lib/repository.js';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const BODY = '## Problem Type\nissue_delivery\n\n## Acceptance Contract\n- isolated ownership duration fixture only\n\n## Runtime Ref\nruntime.github_local\n\n## Policy Ref\npolicy.operator_gated\n\n## Human Gates\n- independent_review\n';
export const BIN = fileURLToPath(new URL('../../../bin/ao-pilot.js', import.meta.url));
export function readOfficial(f) {
  const paths = resolveControlPlanePaths({ repoRoot: f.repoRoot, projectId: f.projectId });
  return { paths, schema: readControlPlaneSchema({ schemaPath: paths.schemaPath }),
    state: readControlPlaneState({ statePath: paths.statePath }), audit: readControlPlaneAuditEntries({ auditPath: paths.auditPath }) };
}
export function writeAdmission(f, patch = {}) {
  const at = Date.now(), current = readOfficial(f).state;
  const d = { schema_version: 'ao.ownership-first-acquire-admission.v1', operation_id: f.operationId,
    project_id: f.projectId, task_id: f.taskId, actor: { session_name: f.owner, session_id: f.ownerId },
    branch_name: f.branch, worktree_path: f.repoRoot, task_spec_raw_sha256: sha(BODY),
    expected_task_state_sha256: fingerprintOwnershipTaskState(current, f.taskId),
    issued_at: new Date(at - 1000).toISOString(), valid_until: new Date(at + 120000).toISOString(),
    stop_path: path.join(path.dirname(f.admissionFile), `${f.operationId}.STOP`),
    policy_source_sha256: ownershipDurationPolicyIdentity().policy_source_sha256, ...patch };
  fs.writeFileSync(f.admissionFile, JSON.stringify(d), { mode: 0o600 }); fs.chmodSync(f.admissionFile, 0o600);
  f.admissionSha256 = sha(fs.readFileSync(f.admissionFile)); f.admission = d; return f;
}
export function makeFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-duration-'));
  execFileSync('git', ['init', '--quiet', repoRoot], { stdio: 'ignore' });
  const f = { repoRoot, projectId: 'duration-offline', taskId: 'duration-fixture-task',
    owner: 'duration-fixture-b', ownerId: 'duration-fixture-b-id', branch: 'task/duration-fixture',
    operationId: `duration_${randomUUID().replaceAll('-', '')}` };
  fs.writeFileSync(path.join(repoRoot, 'ao.config.json'), JSON.stringify({ config_version: 1, project_id: f.projectId }));
  f.specFile = path.join(repoRoot, 'task.md'); fs.writeFileSync(f.specFile, BODY);
  fs.mkdirSync(path.join(repoRoot, 'admission'), { mode: 0o700 });
  f.admissionFile = path.join(repoRoot, 'admission', 'request.json'); return writeAdmission(f);
}
export function argsFor(f, duration = 1800000) {
  return ['manage', 'enroll', '--task', f.taskId, '--title', 'Isolated duration acceptance', '--branch', f.branch,
    '--worktree', f.repoRoot, '--owner-session', f.owner, '--owner-session-id', f.ownerId,
    '--task-spec-file', f.specFile, '--json', ...(duration === null ? [] : [
      '--ownership-duration-ms', String(duration), '--ownership-admission-file', f.admissionFile,
      '--ownership-admission-sha256', f.admissionSha256])];
}
export function runPublic(f, argv = argsFor(f)) {
  const result = spawnSync(process.execPath, [BIN, ...argv], { cwd: f.repoRoot, encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, AO_SESSION_NAME: f.owner, AO_SESSION_ID: f.ownerId } });
  return { ...result, parsed: result.stdout.trim() ? JSON.parse(result.stdout) : null };
}

if (process.argv[2] === '--fixture-run') {
  const { fixture: f, argv, mode, releasePath } = JSON.parse(process.argv[3]);
  if (!f.repoRoot.startsWith(path.join(os.tmpdir(), 'ao-duration-')) || fs.realpathSync(f.repoRoot) !== f.repoRoot) throw new Error('Owned fixture root required');
  const paths = resolveControlPlanePaths({ repoRoot: f.repoRoot, projectId: f.projectId });
  const original = { rename: fs.renameSync, open: fs.openSync, append: fs.appendFileSync, read: fs.readFileSync };
  let prepared = false;
  let afterStagedValidation = false;
  const policyFile = fileURLToPath(new URL('../../../scripts/ao/lib/ownership-duration-policy.js', import.meta.url));
  fs.readFileSync = function (file, ...rest) {
    if (mode === 'cas-after-staging' && file === policyFile && new Error().stack.includes('stageManageCommand')) afterStagedValidation = true;
    if (mode === 'cas-after-staging' && file === paths.statePath && afterStagedValidation) {
      afterStagedValidation = false;
      const external = JSON.parse(original.read(file, 'utf8'));
      external.updated_at = '2001-01-01T00:00:00.000Z';
      fs.writeFileSync(file, JSON.stringify(external));
    }
    return original.read(file, ...rest);
  };
  const pause = () => {
    fs.writeSync(1, 'barrier\n'); const end = Date.now() + 5000;
    while (!fs.existsSync(releasePath)) {
      if (Date.now() >= end) throw new Error('Fixture barrier expired');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  };
  fs.openSync = function (file, flags, ...rest) {
    const fd = original.open(file, flags, ...rest);
    if (file === paths.stateWriteLockPath && flags === 'wx' && mode === 'stop-after-lock') fs.writeFileSync(f.admission.stop_path, 'STOP', { mode: 0o600 });
    return fd;
  };
  fs.renameSync = function (from, to) {
    if (to === paths.stateMutationJournalPath && mode === 'before-journal') pause();
    if (to === paths.statePath && prepared && mode === 'fault-state') throw new Error('Owned fixture state publication failure');
    const result = original.rename(from, to);
    if (to === paths.stateMutationJournalPath) prepared = true;
    return result;
  };
  fs.appendFileSync = function (file, ...rest) {
    if (file === paths.auditPath && prepared && mode === 'fault-audit') throw new Error('Owned fixture audit publication failure');
    return original.append(file, ...rest);
  };
  syncBuiltinESMExports();
  const stdout = [], stderr = [];
  const result = await runCli(argv, { writeStdout: t => stdout.push(t), writeStderr: t => stderr.push(t) }, { cwd: f.repoRoot });
  fs.writeSync(1, `${JSON.stringify({ ...result, stdout: stdout.join(''), stderr: stderr.join(''), prepared })}\n`);
  process.exitCode = result.exitCode;
}
