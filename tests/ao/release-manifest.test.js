import { assertManagedReleaseEnvironment } from '../../scripts/ao/lib/release-runtime.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from '@jest/globals';
import { inspectInstall, INSTALL_CHECK_IDS } from '../../scripts/ao/lib/install-doctor.js';
import { publicInstallReceipt } from '../../scripts/ao/lib/release-receipt.js';
import { validateReleaseManifest, verifyReleaseTree, inventoryTree, durableJson, objectSha256, fileSha256 } from '../../scripts/ao/lib/release-manifest.js';
import { validateEnvironmentOverride, renderReleaseUnits } from '../../scripts/ao/lib/release-units.js';
import { assertStrictReady, assertOwnedDaemonGone } from '../../scripts/verify-fresh-clone.js';
import { fixtureRoot, createBundle, healthyObservation, configuration } from './release-fixture.js';
const roots = [];
function fixture() { const root = fixtureRoot(); roots.push(root); const bundle = createBundle(root); return { root, ...bundle }; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
it('validates strict manifest keys, component hash and all payload bytes', () => {
  const bundle = fixture(); expect(verifyReleaseTree(bundle.payload).release_id).toBe(bundle.manifest.release_id);
  expect(() => validateReleaseManifest({ ...bundle.manifest, extra: 'not allowed' })).toThrow('manifest.extra');
  const changed = structuredClone(bundle.manifest); changed.components.adapter.sha256 = '1'.repeat(64);
  expect(() => validateReleaseManifest(changed)).toThrow('release_component_digest_mismatch');
  fs.writeFileSync(path.join(bundle.payload, 'browser/dist.js'), 'stale or reused dist');
  expect(() => verifyReleaseTree(bundle.payload)).toThrow('release_payload_digest_mismatch');
});
it.each(['/etc/passwd', '../../escape'])('rejects an escaping archive symlink %s', (target) => {
  const bundle = fixture(); fs.symlinkSync(target, path.join(bundle.payload, 'outside'));
  expect(() => inventoryTree(bundle.payload)).toThrow('escaping_release_symlink');
});
it('permits in-release relative dependency symlinks and binds their targets', () => {
  const bundle = fixture(); fs.symlinkSync('browser/dist.js', path.join(bundle.payload, 'inside'));
  expect(inventoryTree(bundle.payload).find((entry) => entry.path === 'inside')).toMatchObject({ type: 'symlink', target: 'browser/dist.js' });
});
it('reports every unsupported entry and unsafe symlink while preserving the first failure code', () => {
  const root = fixtureRoot(); roots.push(root);
  fs.writeFileSync(path.join(root, 'a-hardlink'), 'must remain rejected');
  fs.linkSync(path.join(root, 'a-hardlink'), path.join(root, 'b-hardlink'));
  fs.symlinkSync('missing', path.join(root, 'c-dangling'));
  fs.symlinkSync('/outside', path.join(root, 'd-escaping'));
  execFileSync('mkfifo', [path.join(root, 'e-fifo')]);
  let error;
  try { inventoryTree(root); } catch (observed) { error = observed; }
  expect(error).toMatchObject({ code: 'unsupported_release_file', message: 'unsupported_release_file' });
  expect(error.violations).toEqual([
    { path: 'a-hardlink', code: 'unsupported_release_file', reason: 'multiple_links', type: 'file', nlink: 2, link_group: expect.any(String) },
    { path: 'b-hardlink', code: 'unsupported_release_file', reason: 'multiple_links', type: 'file', nlink: 2, link_group: expect.any(String) },
    { path: 'c-dangling', code: 'dangling_release_symlink', reason: 'dangling_symlink', type: 'symlink' },
    { path: 'd-escaping', code: 'escaping_release_symlink', reason: 'escaping_symlink', type: 'symlink' },
    { path: 'e-fifo', code: 'unsupported_release_file', reason: 'unsupported_type', type: 'fifo', nlink: 1 },
  ]);
  expect(error.violations[0].link_group).toBe(error.violations[1].link_group);
});
it('keeps a first escaping-symlink error even when a later entry has a different violation', () => {
  const root = fixtureRoot(); roots.push(root);
  fs.symlinkSync('/outside', path.join(root, 'a-escaping'));
  fs.symlinkSync('missing', path.join(root, 'b-dangling'));
  expect(() => inventoryTree(root)).toThrow('escaping_release_symlink');
  try { inventoryTree(root); } catch (error) { expect(error.violations.map((item) => item.path)).toEqual(['a-escaping', 'b-dangling']); }
});
it.each(INSTALL_CHECK_IDS.filter((id) => !['release_integrity', 'runtime_lock'].includes(id)))('doctor detects %s drift or unavailable evidence', (id) => {
  const bundle = fixture(); const good = healthyObservation(bundle.manifest, bundle.payload);
  const baseline = healthyObservation(bundle.manifest, bundle.payload, { generation: 1 });
  expect(inspectInstall({ releaseRoot: bundle.payload, observation: good, baseline }).status).toBe('passed');
  const bad = structuredClone(good);
  const mutations = {
    version_drift: () => { bad.services.adapter.release_id = 'old'; }, tmux_cgroup: () => { bad.tmux.status = 'unknown'; },
    tmux_generation: () => { bad.tmux.server_start_token = 'restarted'; }, linger: () => { bad.linger = null; },
    listeners: () => { bad.listeners_loopback = false; }, terminal_auth: () => { bad.terminal_auth = false; },
    schema: () => { bad.database.integrity = 'corrupt'; }, ownership_locks: () => { bad.ownership_locks = false; },
    lan_disabled: () => { bad.lan_disabled = false; }, trusted_host_disabled: () => { bad.trusted_host_disabled = false; },
    tokenless_lock_safe: () => { bad.tokenless_lock_safe = false; }, cid_set: () => { bad.cids = ['different']; },
    ready: () => { bad.ready = { health: 'ok', state: 'degraded', reasons: ['reconcile'] }; },
    unit_provenance: () => { bad.services.daemon.unit_verified = false; }, process_identity: () => { bad.services.daemon.stable = false; },
  };
  mutations[id](); const report = inspectInstall({ releaseRoot: bundle.payload, observation: bad, baseline });
  expect(report.status).toBe('blocked'); expect(report.checks[id]).not.toBe('PASS');
});
it('compares the daemon with independent lock binary SHA, not root commit equality or component self-report', () => {
  const bundle = fixture();
  expect(bundle.manifest.commit).not.toBe(bundle.manifest.runtime_lock.commit);
  const good = healthyObservation(bundle.manifest, bundle.payload);
  expect(inspectInstall({ releaseRoot: bundle.payload, observation: good, baseline: healthyObservation(bundle.manifest, bundle.payload, { generation: 1 }) }).checks.runtime_lock).toBe('PASS');
  const lockFile = path.join(bundle.payload, 'runtime/agent-orchestrator.lock.json'); const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  lock.compatibility.platforms[0].binary_sha256 = '1'.repeat(64); durableJson(lockFile, lock);
  const changed = structuredClone(bundle.manifest); changed.runtime_lock.sha256 = fileSha256(lockFile);
  changed.files = inventoryTree(bundle.payload); durableJson(path.join(bundle.payload, 'release.json'), changed);
  expect(verifyReleaseTree(bundle.payload)).toBeDefined();
  expect(inspectInstall({ releaseRoot: bundle.payload, observation: good }).checks.runtime_lock).toBe('FAIL');
  lock.compatibility.platforms = []; durableJson(lockFile, lock);
  changed.runtime_lock.sha256 = fileSha256(lockFile); changed.files = inventoryTree(bundle.payload); durableJson(path.join(bundle.payload, 'release.json'), changed);
  expect(inspectInstall({ releaseRoot: bundle.payload, observation: good }).checks.runtime_lock).toBe('FAIL');
});
it('public receipts are a strict allowlist, even with hostile private evidence', () => {
  const bundle = fixture(); const secret = '/private/home/user PID=123 192.168.9.10:4333 token=secret';
  const privateInput = { manifest: bundle.manifest, manifestSha256: bundle.envelope.manifest_sha256, phase: 'verify', result: 'failed', checks: { ...Object.fromEntries(INSTALL_CHECK_IDS.map((id) => [id, 'PASS'])), secret }, failureCode: 'verify_failed', error: secret, pid: 123, address: secret };
  const receipt = publicInstallReceipt(privateInput);
  expect(Object.keys(receipt).sort()).toEqual(['schema_version', 'release_id', 'commit', 'tree', 'manifest_sha256', 'platform', 'phase', 'result', 'checks', 'failure_code', 'warning_count', 'performed_at'].sort());
  expect(Object.keys(receipt.checks)).toEqual(INSTALL_CHECK_IDS);
  expect(JSON.stringify(receipt)).not.toMatch(/private\/home|192\.168|token=|PID=|secret/);
  expect(() => publicInstallReceipt({ ...privateInput, failureCode: secret })).toThrow('invalid_public_receipt');
});
it('units use current, preserve mixed, isolate tmux, and permit only environment overrides', () => {
  const { root } = fixture(); const config = configuration(root);
  const units = renderReleaseUnits({ ...config, envFile: path.join(config.stateRoot, 'install.env'), nodePath: process.execPath });
  const daemon = units[`${config.namespace}-runtime.service`]; const tmux = units[`${config.namespace}-tmux.service`];
  expect(daemon).toContain('/current/scripts/ao-release-entry.js'); expect(daemon).toContain('KillMode=mixed');
  expect(daemon).toContain(`Wants=${config.namespace}-tmux.service`); expect(daemon).not.toMatch(/BindsTo=|PartOf=/);
  expect(tmux).toContain('RefuseManualStop=yes'); expect(tmux).toContain('KillMode=control-group');
  expect(validateEnvironmentOverride('[Service]\nEnvironment="AO_DASHBOARD_AUTOMATION=0"')).toEqual({ AO_DASHBOARD_AUTOMATION: '0' });
  for (const text of ['[Service]\nExecStart=/tmp/evil', '[Service]\nKillMode=process', '[Service]\nEnvironment="LD_PRELOAD=evil"', '[Service]\nEnvironment="AO_DATA_DIR=/tmp/a"\nEnvironment="AO_DATA_DIR=/tmp/b"']) expect(() => validateEnvironmentOverride(text)).toThrow('unsafe_unit_override');
});
it('strict fresh-clone ready and ownership exit never infer success from HTTP failure', () => {
  for (const value of [{ health: 'ok' }, { state: 'degraded', health: 'ok' }, { state: 'ready', reasons: ['partial recovery'] }, { state: 'not_ready', ready: true }, { state: 'ready', ready: false }, { state: 'ready', ready: true, status: 'degraded' }, { state: 'ready', ready: 'not_ready' }]) expect(() => assertStrictReady(value)).toThrow('non-degraded');
  expect(assertStrictReady({ state: 'ready', reasons: [] })).toBe(true);
  const owned = { pid: 4321, startToken: 'old', lockFiles: ['/fake/data/.daemon-owner.lock', '/fake/discovery/.daemon-discovery.lock'] };
  expect(() => assertOwnedDaemonGone(owned, { readStartToken: () => 'old', probeLock: () => true })).toThrow('still present');
  expect(() => assertOwnedDaemonGone(owned, { readStartToken: () => { throw Object.assign(Error('unknown'), { code: 'EACCES' }); }, probeLock: () => true })).toThrow('unknown');
  expect(() => assertOwnedDaemonGone(owned, { readStartToken: () => { throw Object.assign(Error(), { code: 'ENOENT' }); }, probeLock: () => null })).toThrow('not proven');
  expect(assertOwnedDaemonGone(owned, { readStartToken: () => 'new-reused-pid-token', probeLock: () => true })).toBe(true);
});

it('blocks native CID drift and missing custody records independently from equal AO ID sets', () => {
  const bundle = fixture(); const baseline = healthyObservation(bundle.manifest, bundle.payload, { generation: 1 });
  const observed = healthyObservation(bundle.manifest, bundle.payload); observed.native_cids[0].native_conversation_id = 'new-native-cid';
  expect(inspectInstall({ releaseRoot: bundle.payload, baseline, observation: observed }).checks.cid_set).toBe('FAIL');
  observed.native_cids = structuredClone(baseline.native_cids);
  baseline.custody = [{ session_id: 'orphan', attempt_id: 'attempt', raw_outcome: 'running', record_sha256: '0'.repeat(64), validation: 'UNKNOWN' }];
  expect(inspectInstall({ releaseRoot: bundle.payload, baseline, observation: observed }).checks.cid_set).toBe('FAIL');
  observed.custody = structuredClone(baseline.custody);
  expect(inspectInstall({ releaseRoot: bundle.payload, baseline, observation: observed }).checks.cid_set).toBe('PASS');
  expect(observed.custody[0].validation).toBe('UNKNOWN');
});

it('rejects partial launcher bindings before execution instead of falling back to legacy', () => {
  const root = '/fixture/install/releases/1.0.0+' + 'a'.repeat(40);
  const env = { AO_INSTALL_ROOT: '/fixture/install', AO_INSTALL_NAMESPACE: 'ao-pilot-staging-fixture', AO_DATA_DIR: '/fixture/data', AO_MANAGED_RUNTIME_DATA_DIR: '/fixture/data', AO_RUN_FILE: '/fixture/run/running.json', AO_MANAGED_RUNTIME_RUN_FILE: '/fixture/run/running.json',
    AO_TMUX_SOCKET: 'ao-pilot-staging-fixture', AO_TMUX_UNIT: 'ao-pilot-staging-fixture-tmux.service', AO_TMUX_TMPDIR: '/fixture/tmux', TMUX_TMPDIR: '/fixture/tmux' };
  expect(() => assertManagedReleaseEnvironment(env, root)).not.toThrow();
  for (const key of Object.keys(env)) expect(() => assertManagedReleaseEnvironment({ ...env, [key]: undefined }, root)).toThrow('release_managed_environment_incomplete');
});
