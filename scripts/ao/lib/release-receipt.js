import { INSTALL_CHECK_IDS } from './install-doctor.js';
import { assertRelease, durableJson } from './release-manifest.js';
export const INSTALL_FAILURE_CODES = ['none', 'preflight_failed', 'install_failed', 'switch_failed', 'verify_failed', 'readback_failed', 'rollback_required', 'interrupted_transaction', 'gc_warning', 'invalid_input'];
export function publicInstallReceipt({ manifest, manifestSha256, phase, result, checks = {}, failureCode = 'none', warnings = 0, now = () => new Date().toISOString() }) {
  assertRelease(manifest && /^[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(manifest.release_id)
    && /^[a-f0-9]{40}$/.test(manifest.commit) && /^[a-f0-9]{40}$/.test(manifest.tree)
    && /^[a-f0-9]{64}$/.test(manifestSha256), 'invalid_public_receipt');
  assertRelease(['preflight', 'install', 'switch', 'verify', 'readback', 'committed', 'rollback'].includes(phase)
    && ['passed', 'failed', 'hold'].includes(result) && INSTALL_FAILURE_CODES.includes(failureCode), 'invalid_public_receipt');
  const timestamp = now(); assertRelease(Number.isFinite(Date.parse(timestamp)), 'invalid_public_receipt');
  return {
    schema_version: 'ao.install-public-receipt.v1', release_id: manifest.release_id, commit: manifest.commit, tree: manifest.tree,
    manifest_sha256: manifestSha256, platform: { os: 'linux', arch: manifest.platform.arch }, phase, result,
    checks: Object.fromEntries(INSTALL_CHECK_IDS.map((id) => [id, ['PASS', 'FAIL', 'UNKNOWN'].includes(checks[id]) ? checks[id] : 'UNKNOWN'])),
    failure_code: failureCode, warning_count: Number.isSafeInteger(warnings) && warnings >= 0 ? warnings : 0,
    performed_at: new Date(timestamp).toISOString(),
  };
}
export function savePrivateInstallReceipt(file, receipt) { durableJson(file, receipt); }
