import assert from 'node:assert/strict';
import { parseOwnershipDurationMs, validateOwnershipDurationMs, checkedOwnershipExpiry, MAX_OWNERSHIP_LEASE_DURATION_MS } from '../../scripts/ao/lib/ownership-duration-policy.js';
import { transitionOwnershipLease } from '../../scripts/ao/lib/transition-engine.js';
const { test } = process.env.JEST_WORKER_ID ? await import('@jest/globals') : await import('node:test');
for (const value of [1, 1200000, 1800000, 3600000]) test(`duration accepts bounded numeric ${value}`, () => {
  assert.equal(validateOwnershipDurationMs(value), value); assert.equal(parseOwnershipDurationMs(String(value)), value);
});
for (const value of [0, -1, 0.5, NaN, Infinity, 3600001, Number.MAX_SAFE_INTEGER + 1, '1800000', null, undefined]) {
  test(`duration refuses type/range ${String(value)} (${typeof value})`, () => assert.throws(() => validateOwnershipDurationMs(value)));
}
for (const value of ['0', '-1', '1.2', '1e3', '+1', '01', ' 1', '1 ', '', 'garbage', '999999999999999999999999999999']) {
  test(`duration parser refuses ${JSON.stringify(value)}`, () => assert.throws(() => parseOwnershipDurationMs(value)));
}
test('checked expiry rejects invalid/overflow Date even for bounded duration', () => {
  assert.throws(() => checkedOwnershipExpiry('not-a-date', 1));
  assert.throws(() => checkedOwnershipExpiry('+275760-09-13T00:00:00.000Z', 1));
  assert.equal(MAX_OWNERSHIP_LEASE_DURATION_MS, 3600000);
});
test('legacy transition keeps20min while explicit first duration reaches checked expiry', () => {
  const base = { intent: 'acquire', leaseId: 'ownership-fixture-owner', taskId: 'fixture', ownerSessionName: 'fixture-owner', now: '2026-01-01T00:00:00.000Z' };
  const legacy = transitionOwnershipLease(base), custom = transitionOwnershipLease({ ...base, durationMs: 1800000 });
  assert.equal(Date.parse(legacy.expires_at) - Date.parse(legacy.acquired_at), 1200000);
  assert.equal(Date.parse(custom.expires_at) - Date.parse(custom.acquired_at), 1800000);
  for (const status of ['active', 'expired', 'released']) assert.throws(() => transitionOwnershipLease({ ...base, durationMs: 1800000, existingLease: { ...legacy, status } }));
  assert.throws(() => transitionOwnershipLease({ ...base, durationMs: 1800000, expiresAt: '2026-01-02T00:00:00.000Z' }));
  assert.throws(() => transitionOwnershipLease({ ...base, intent: 'release', durationMs: 1800000 }));
});
