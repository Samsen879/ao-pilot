import fs from 'node:fs';
import { objectSha256, verifyReleaseTree } from './release-manifest.js';
import { assertRuntimeLockArtifact } from './release-runtime.js';

export const INSTALL_CHECK_IDS = [
  'release_integrity', 'version_drift', 'runtime_lock', 'tmux_cgroup', 'tmux_generation', 'linger',
  'listeners', 'terminal_auth', 'schema', 'ownership_locks', 'lan_disabled', 'trusted_host_disabled',
  'tokenless_lock_safe', 'cid_set', 'ready', 'unit_provenance', 'process_identity',
];
const truth = (value) => value === true ? 'PASS' : value === false ? 'FAIL' : 'UNKNOWN';
// /readyz DTO is distinct from the native CLI's status.state response.
export function isStrictReadyz(value) {
  return value?.status === 'ready' && value.ready === true
    && (value.state === undefined || value.state === 'ready')
    && Array.isArray(value.reasons) && value.reasons.length === 0
    && (value.degraded_reasons === undefined || Array.isArray(value.degraded_reasons) && value.degraded_reasons.length === 0);
}
export function nativeBindingsUnchanged(observation, baseline) {
  return Array.isArray(observation?.native_cids) && Array.isArray(baseline?.native_cids)
    && objectSha256(observation.native_cids) === objectSha256(baseline.native_cids)
    && Array.isArray(observation?.custody) && Array.isArray(baseline?.custody)
    && observation.custody.every((record) => record.record_state !== 'unknown')
    && baseline.custody.every((record) => record.record_state !== 'unknown')
    && objectSha256(observation.custody) === objectSha256(baseline.custody);
}
export function inspectInstall({ releaseRoot, observation = {}, baseline = null, mode = 'daily', manifest = null, requireRestart = true }) {
  const checks = Object.fromEntries(INSTALL_CHECK_IDS.map((id) => [id, 'UNKNOWN']));
  try { manifest = verifyReleaseTree(releaseRoot); checks.release_integrity = 'PASS'; } catch { checks.release_integrity = 'FAIL'; }
  if (!manifest) return { status: 'blocked', checks, evidence: observation };
  const services = observation.services;
  if (services && ['daemon', 'dashboard', 'adapter', 'session-recovery'].every((key) => services[key])) {
    checks.version_drift = observation.cli_bound === undefined || observation.cli_bound === null ? 'UNKNOWN' : truth(observation.cli_bound === true && ['daemon', 'dashboard', 'adapter', 'session-recovery'].every((name) => {
      const service = services[name];
      return service.release_id === manifest.release_id && service.release_root === fs.realpathSync(releaseRoot)
        && (name === 'session-recovery' || service.component_sha256 === manifest.components[name].sha256);
    }));
    checks.process_identity = truth(Object.values(services).every((service) => Number.isSafeInteger(service.pid) && service.pid > 0
      && typeof service.start_token === 'string' && service.start_token !== '' && service.stable === true)
      && (!requireRestart || baseline === null || ['daemon', 'dashboard', 'adapter', 'session-recovery'].every((name) => {
        const old = baseline.services?.[name]; const current = services[name];
        return !old || old.pid !== current.pid || old.start_token !== current.start_token;
      })));
    checks.unit_provenance = truth(Object.values(services).every((service) => service.unit_verified === true));
  }
  try {
    assertRuntimeLockArtifact(releaseRoot, manifest); checks.runtime_lock = 'PASS';
  } catch { checks.runtime_lock = 'FAIL'; }
  const tmux = observation.tmux;
  checks.tmux_cgroup = tmux ? truth(tmux.level === 'PASS' && tmux.status === 'ok') : 'UNKNOWN';
  if (tmux?.server_pid && tmux?.server_start_token && tmux?.executable_sha256) {
    checks.tmux_generation = truth(tmux.executable_sha256 === manifest.toolchain.tmux_sha256
      && (mode === 'first' || !baseline?.tmux || baseline.tmux.server_pid === tmux.server_pid
        && baseline.tmux.server_start_token === tmux.server_start_token));
  }
  checks.linger = truth(observation.linger);
  checks.listeners = truth(observation.listeners_loopback);
  checks.terminal_auth = truth(observation.terminal_auth);
  checks.schema = observation.database ? truth(observation.database.integrity === 'ok'
    && observation.database.schema >= manifest.database.schema_min_readable
    && observation.database.schema <= manifest.database.schema_max_readable
    && observation.database.schema === manifest.database.schema_current) : 'UNKNOWN';
  checks.ownership_locks = truth(observation.ownership_locks);
  checks.lan_disabled = truth(observation.lan_disabled);
  checks.trusted_host_disabled = truth(observation.trusted_host_disabled);
  checks.tokenless_lock_safe = truth(observation.tokenless_lock_safe);
  checks.ready = observation.ready ? truth(isStrictReadyz(observation.ready)) : 'UNKNOWN';
  checks.cid_set = Array.isArray(observation.cids) && baseline && Array.isArray(baseline.cids)
    ? truth(objectSha256([...observation.cids].sort()) === objectSha256([...baseline.cids].sort())
      && nativeBindingsUnchanged(observation, baseline)) : 'UNKNOWN';
  return { status: Object.values(checks).every((value) => value === 'PASS') ? 'passed' : 'blocked', checks, evidence: observation };
}
