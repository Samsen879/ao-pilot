import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from '@jest/globals';
import { runManageCommand } from '../../scripts/ao/lib/manage-runner.js';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';

const roots = [];
const children = [];
const projectId = 'manage-transaction-test';
const now = '2026-09-26T00:00:00.000Z';
const worker = fileURLToPath(new URL('./fixtures/manage-transaction-worker.mjs', import.meta.url));

async function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-manage-transaction-'));
  roots.push(repoRoot);
  const options = { repoRoot, projectId, issueNumber: 127, now };
  await runManageCommand({ ...options, command: 'enroll', ownerSessionName: 'original', prNumber: 100 });
  const repository = createStateRepository({ repoRoot, projectId });
  return { options, repository, paths: repository.getSnapshot().paths };
}
function start(options, mode = null) {
  const releasePath = path.join(options.repoRoot, `release-${children.length}`);
  const child = spawn(process.execPath, [worker, JSON.stringify({ options, mode, releasePath })], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  let stderr = '';
  const waiters = new Map();
  child.stdout.on('data', chunk => {
    output += chunk;
    for (const [line, resolve] of waiters) if (output.split('\n').includes(line)) { waiters.delete(line); resolve(); }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      if (signal) { resolve({ exitCode, signal }); return; }
      try { resolve({ exitCode, ...JSON.parse(output.trim().split('\n').at(-1)) }); }
      catch { reject(new Error(`Worker ended without result: ${stderr} ${output}`)); }
    });
  });
  return {
    child, done,
    release: () => fs.writeFileSync(releasePath, ''),
    wait: async line => {
      if (output.split('\n').includes(line)) return;
      let timer;
      try {
        await Promise.race([
          new Promise(resolve => waiters.set(line, resolve)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Missing ${line}: ${stderr} ${output}`)), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
function bytes(paths) {
  return { state: fs.readFileSync(paths.statePath, 'utf8'), audit: fs.readFileSync(paths.auditPath, 'utf8') };
}
function assertOwnerAndPr(state, owner, pr) {
  expect(state.managed_tasks.find(task => task.task_id === 'issue-127').status).toBe('active');
  expect(state.ownership_leases.filter(record => record.task_id === 'issue-127' && record.status === 'active').map(record => record.owner_session_name)).toEqual([owner]);
  expect(state.pr_bindings.filter(record => record.task_id === 'issue-127' && record.status === 'bound').map(record => record.pr_number)).toEqual([pr]);
  expect(state.task_specs.some(record => record.task_id === 'issue-127')).toBe(true);
  expect(state.execution_attempt_metrics.some(record => record.task_id === 'issue-127' && record.owner_session_name === owner)).toBe(true);
}
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('managed task command transaction', () => {
  it('rereads after lock admission so a waiting adopt cannot undo a completed retire', async () => {
    const { options, repository, paths } = await fixture();
    const adopter = start({ ...options, command: 'adopt', ownerSessionName: 'successor', prNumber: 200 }, 'before-lock');
    await adopter.wait('barrier');
    await runManageCommand({ ...options, command: 'retire' });
    const retired = bytes(paths);
    adopter.release();
    expect(await adopter.done).toMatchObject({ ok: false, publications: [] });
    expect(bytes(paths)).toEqual(retired);
    expect(repository.getSnapshot().state.managed_tasks[0].status).toBe('retired');
  });

  it('publishes owner, PR, task spec and attempt together for two independent writers', async () => {
    const { options, repository } = await fixture();
    repository.upsertManagedTask({ task_id: 'unrelated', title: 'Preserve me', status: 'active', created_at: now, updated_at: now });
    const prior = repository.getSnapshot().state;
    const a = start({ ...options, command: 'adopt', ownerSessionName: 'a', prNumber: 201 }, 'before-publish');
    await a.wait('barrier');
    const b = start({ ...options, command: 'adopt', ownerSessionName: 'b', prNumber: 202 });
    await b.wait('contended');
    a.release();
    const [first, second] = await Promise.all([a.done, b.done]);
    expect(first.ok).toBe(true); expect(second.ok).toBe(true);
    expect(first.publications).toHaveLength(1); expect(second.publications).toHaveLength(1);
    assertOwnerAndPr(first.publications[0], 'a', 201);
    assertOwnerAndPr(second.publications[0], 'b', 202);
    const final = repository.getSnapshot().state;
    assertOwnerAndPr(final, 'b', 202);
    expect(final.managed_tasks.find(task => task.task_id === 'unrelated')).toEqual(prior.managed_tasks.find(task => task.task_id === 'unrelated'));
    expect(final.runtime_preflights).toEqual(prior.runtime_preflights);
  });

  it('discards all staged changes on late PR validation failure', async () => {
    const { options, paths } = await fixture();
    const before = bytes(paths);
    await expect(runManageCommand({ ...options, command: 'adopt', ownerSessionName: 'rejected', prNumber: -1 })).rejects.toThrow();
    expect(bytes(paths)).toEqual(before);
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(false);
  });

  it.each(['fault-journal', 'fault-state', 'fault-audit', 'fault-unlink'])('recovers the whole transaction after %s', async mode => {
    const { options, paths, repository } = await fixture();
    const before = bytes(paths);
    const writer = start({ ...options, command: 'adopt', ownerSessionName: 'recovered', prNumber: 300 }, mode);
    const outcome = await writer.done;
    expect(outcome.ok).toBe(false);
    if (mode === 'fault-journal') {
      expect(bytes(paths)).toEqual(before);
      expect(outcome.code).toBeUndefined();
      expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(false);
      return;
    }
    expect(outcome.code).toBe('MANAGED_TASK_COMMIT_RECOVERY_REQUIRED');
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(true);
    const recovered = repository.getSnapshot().state;
    assertOwnerAndPr(recovered, 'recovered', 300);
    const audits = repository.listAuditEntries().filter(entry => entry.entity_kind === 'managed_task_command' && entry.operation === 'adopt');
    expect(audits).toHaveLength(1);
    expect(audits[0].details.changes.map(change => change.entity_kind)).toEqual(expect.arrayContaining(['managed_task', 'ownership_lease', 'pr_binding', 'execution_attempt_metric']));
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(false);
    expect(repository.getSnapshot().state).toEqual(recovered);
  });

  it.each(['manage', 'ordinary-write'])('repairs a partial audit before the next %s bootstraps', async nextWriter => {
    const { options, paths, repository } = await fixture();
    const writer = start({ ...options, command: 'adopt', ownerSessionName: 'partial', prNumber: 350 }, 'fault-partial-audit');
    expect(await writer.done).toMatchObject({ ok: false, code: 'MANAGED_TASK_COMMIT_RECOVERY_REQUIRED' });
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(true);
    if (nextWriter === 'manage') {
      await runManageCommand({ ...options, command: 'retire' });
      expect(repository.getSnapshot().state.managed_tasks[0].status).toBe('retired');
    } else {
      repository.upsertManagedTask({ task_id: 'unrelated', title: 'After recovery', status: 'active', created_at: now, updated_at: now });
      assertOwnerAndPr(repository.getSnapshot().state, 'partial', 350);
    }
    expect(repository.listAuditEntries().filter(entry => entry.entity_kind === 'managed_task_command' && entry.operation === 'adopt')).toHaveLength(1);
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(false);
  });

  it('recovers a killed writer from its durable whole-command journal', async () => {
    const { options, repository, paths } = await fixture();
    const before = bytes(paths).state;
    const writer = start({ ...options, command: 'adopt', ownerSessionName: 'interrupted', prNumber: 400 }, 'before-publish');
    await writer.wait('barrier');
    expect(fs.readFileSync(paths.statePath, 'utf8')).toBe(before);
    expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(true);
    writer.child.kill('SIGKILL');
    expect((await writer.done).signal).toBe('SIGKILL');
    assertOwnerAndPr(repository.getSnapshot().state, 'interrupted', 400);
    expect(repository.listAuditEntries().filter(entry => entry.entity_kind === 'managed_task_command' && entry.operation === 'adopt')).toHaveLength(1);
  });

  it('rejects async callbacks, escaped capabilities, and cross-instance reentry without publication', async () => {
    const { repository, options, paths } = await fixture();
    const before = bytes(paths);
    expect(() => repository.mutateManagedTaskAtomically({ command: 'adopt', mutate: async () => {} })).toThrow('synchronous');
    let escaped;
    expect(() => repository.mutateManagedTaskAtomically({ command: 'adopt', mutate: tx => {
      escaped = tx;
      tx.upsertManagedTask({ ...tx.getSnapshot().state.managed_tasks[0], title: 'Discard this' });
      return Promise.resolve({});
    } })).toThrow('Promise');
    expect(() => escaped.getSnapshot()).toThrow('no longer active');
    expect(() => repository.mutateManagedTaskAtomically({ command: 'adopt', mutate: () => {
      createStateRepository(options).upsertManagedTask(repository.getSnapshot().state.managed_tasks[0]);
    } })).toThrow('reenter');
    expect(bytes(paths)).toEqual(before);
  });
});
