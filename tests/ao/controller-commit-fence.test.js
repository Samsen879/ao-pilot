import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { createStateRepository } from '../../scripts/ao/lib/state-repository.js';
import { createControllerModeRecord } from '../../scripts/ao/lib/state-contracts.js';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-commit-fence-'));
  roots.push(repoRoot);
  const repository = createStateRepository({ repoRoot, projectId: 'fixture' });
  const lease = repository.upsertControllerLease({
    lease_id: 'lease', controller_id: 'default', holder_id: 'holder', holder_type: 'manual',
    incarnation_id: 'epoch-1', status: 'active', acquired_at: '2026-10-23T00:00:00.000Z',
    heartbeat_at: '2026-10-23T00:00:00.000Z', expires_at: '2026-10-23T00:00:10.000Z',
    lease_timeout_ms: 10000, runtime_kind: 'oneshot',
  });
  const mode = createControllerModeRecord({
    controller_id: 'default', mode: 'observe', updated_at: '2026-10-23T00:00:00.000Z',
    updated_by: 'fixture', reason: 'commit fencing',
  });
  return { repository, lease, mode };
}

it.each(['epoch', 'expiry', 'revoked'])('fences a %s change before any state or audit publication', (kind) => {
  const { repository, lease, mode } = fixture();
  if (kind === 'epoch') repository.upsertControllerLease({ ...lease, incarnation_id: 'epoch-2' });
  const fenced = repository.createControllerFencedRepository({
    controllerId: 'default', leaseId: lease.lease_id, incarnationId: 'epoch-1',
    now: () => kind === 'expiry' ? lease.expires_at : lease.acquired_at,
    isActive: () => kind !== 'revoked',
  });
  const stateBefore = fs.readFileSync(repository.getSnapshot().paths.statePath, 'utf8');
  const auditBefore = repository.listAuditEntries();
  expect(() => fenced.upsertControllerMode(mode)).toThrow('no longer active at commit');
  expect(fs.readFileSync(repository.getSnapshot().paths.statePath, 'utf8')).toBe(stateBefore);
  expect(repository.listAuditEntries()).toEqual(auditBefore);
});

it('rechecks lease expiry inside the state write lock immediately before publication', () => {
  const { repository, lease, mode } = fixture();
  const paths = repository.getSnapshot().paths;
  let calls = 0;
  const fenced = repository.createControllerFencedRepository({
    controllerId: 'default', leaseId: lease.lease_id, incarnationId: 'epoch-1', isActive: () => true,
    now: () => {
      calls += 1;
      if (calls === 1) return lease.acquired_at;
      expect(fs.existsSync(paths.stateWriteLockPath)).toBe(true);
      expect(fs.existsSync(`${paths.controllerLeasesPath}.lock`)).toBe(true);
      return lease.expires_at;
    },
  });
  const before = fs.readFileSync(paths.statePath, 'utf8');
  const auditBefore = repository.listAuditEntries();
  expect(() => fenced.upsertControllerMode(mode)).toThrow('no longer active at commit');
  expect(calls).toBe(2);
  expect(fs.readFileSync(paths.statePath, 'utf8')).toBe(before);
  expect(repository.listAuditEntries()).toEqual(auditBefore);
  expect(fs.existsSync(paths.stateMutationJournalPath)).toBe(false);
});
