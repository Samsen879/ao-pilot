import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { adapterConfiguration, adapterConfigPath } from './release-adapter.js';
import { acquireInstallLock } from './release-lock.js';
import { verifyReleaseEnvelope } from './release-builder.js';
import { assertRelease, durableJson, fileSha256, objectSha256, readJson, syncDirectory, syncTree, verifyReleaseTree } from './release-manifest.js';
import { backupAndInstallUnits, restoreUnitBackup, writeReleaseUnits, renderReleaseUnits, validateEnvironmentOverride, stagingHomeEnvironment } from './release-units.js';
import { inspectInstall, nativeBindingsUnchanged } from './install-doctor.js';
import { publicInstallReceipt, savePrivateInstallReceipt } from './release-receipt.js';
import { assertRuntimeLockArtifact } from './release-runtime.js';
import { createSystemdReleaseRunner, firstRestoreIdentities } from './release-systemd.js';

function pointer(root, name) {
  const file = path.join(root, name);
  try {
    assertRelease(fs.lstatSync(file).isSymbolicLink(), 'install_pointer_not_symlink');
    const target = fs.readlinkSync(file);
    assertRelease(/^releases\/[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(target), 'unsafe_install_pointer');
    const resolved = path.join(root, target);
    assertRelease(fs.realpathSync(resolved) === path.resolve(resolved), 'unsafe_install_pointer');
    return target;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function entryExists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function switchPointer(root, name, target, lock) {
  lock.assertOwned();
  const temp = path.join(root, `.${name}-${randomUUID()}`);
  const final = path.join(root, name);
  if (target === null) { fs.rmSync(final, { force: true }); syncDirectory(root); return; }
  assertRelease(/^releases\/[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(target), 'unsafe_install_pointer');
  fs.symlinkSync(target, temp);
  fs.renameSync(temp, final); syncDirectory(root);
}
function writeEnvironment(configuration, lock, manifest, releaseRoot, deferredBootIDs = []) {
  const environment = {
    AO_DASHBOARD_ADAPTER_CONFIG: adapterConfigPath(configuration),
    DIRECT_TERMINAL_PORT: String(configuration.listenPorts[3]), TERMINAL_PORT: String(configuration.listenPorts[4]),
    AO_INSTALL_CONFIG: configuration.installConfigPath ?? path.join(configuration.stateRoot, 'install.json'),
    AO_INSTALL_ROOT: configuration.installRoot, AO_DATA_DIR: configuration.dataDir,
    AO_RUN_FILE: path.join(configuration.discoveryDir, 'running.json'),
    AO_MANAGED_RUNTIME_DATA_DIR: configuration.dataDir, AO_MANAGED_RUNTIME_RUN_FILE: path.join(configuration.discoveryDir, 'running.json'),
    AO_TMUX_SOCKET: configuration.tmuxSocket, AO_TMUX_UNIT: `${configuration.namespace}-tmux.service`,
    AO_TMUX_TMPDIR: configuration.tmuxTmpdir, TMUX_TMPDIR: configuration.tmuxTmpdir,
    AO_MANAGED_RUNTIME_BINARY: path.join(releaseRoot, manifest.components.daemon.entrypoint),
    AO_MANAGED_RUNTIME_BINARY_SHA256: manifest.components.daemon.files.find((file) => file.path === manifest.components.daemon.entrypoint).sha256,
    AO_CONFIG_PATH: configuration.configPath, AO_INSTALL_NAMESPACE: configuration.namespace,
    AO_HOST: '127.0.0.1', AO_PORT: String(new URL(configuration.daemonURL).port),
    AO_DASHBOARD_PORT: String(configuration.listenPorts[1]),
    AO_DASHBOARD_TERMINAL_ACCESS: '1', AO_DASHBOARD_READ_ONLY: '1', AO_DASHBOARD_AUTOMATION: '0', NODE_ENV: 'production',
  };
  if (deferredBootIDs.length) environment.AO_DEFER_BOOT_RESTORE_IDS = deferredBootIDs.join(',');
  const stagingRoot = configuration.namespace.startsWith('ao-pilot-staging-') ? configuration.stateRoot : null;
  const privateHome = stagingRoot ? stagingHomeEnvironment(stagingRoot) : {};
  Object.assign(environment, privateHome);
  const text = `[Service]\n${Object.entries(environment).map(([key, value]) => `Environment="${key}=${value}"`).join('\n')}\n`;
  validateEnvironmentOverride(text, { stagingRoot });
  // EnvironmentFile uses bare quoted assignments, not unit directives.
  const body = Object.entries(environment).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n';
  lock.assertOwned(); fs.mkdirSync(configuration.stateRoot, { recursive: true, mode: 0o700 });
  if (stagingRoot) {
    for (const directory of [privateHome.HOME, privateHome.XDG_CONFIG_HOME, path.join(privateHome.HOME, '.local'), privateHome.XDG_DATA_HOME]) {
      lock.assertOwned();
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      assertRelease(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid()
        && (stat.mode & 0o077) === 0 && fs.realpathSync(directory) === directory, 'unsafe_staging_home');
    }
  }
  const target = path.join(configuration.stateRoot, 'install.env');
  const temp = `${target}.tmp-${randomUUID()}`;
  fs.writeFileSync(temp, body, { mode: 0o600 });
  const fd = fs.openSync(temp, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, target); syncDirectory(configuration.stateRoot);
}
function installCliLink(configuration, lock) {
  if (!configuration.cliPath) return;
  lock.assertOwned();
  const target = path.join(configuration.installRoot, 'current/bin/ao-pilot.js');
  if (fs.existsSync(configuration.cliPath) || (() => { try { fs.lstatSync(configuration.cliPath); return true; } catch { return false; } })()) {
    assertRelease(fs.lstatSync(configuration.cliPath).isSymbolicLink(), 'unowned_cli_entry');
    const prior = path.resolve(path.dirname(configuration.cliPath), fs.readlinkSync(configuration.cliPath));
    assertRelease(prior === target || configuration.legacyCliTarget === prior, 'unowned_cli_entry');
  }
  fs.mkdirSync(path.dirname(configuration.cliPath), { recursive: true, mode: 0o700 });
  const temp = `${configuration.cliPath}.tmp-${randomUUID()}`;
  fs.symlinkSync(target, temp); fs.renameSync(temp, configuration.cliPath); syncDirectory(path.dirname(configuration.cliPath));
}
function snapshotEnvironment(configuration, txDir, lock) {
  const files = [path.join(configuration.stateRoot, 'install.env'), path.join(configuration.installRoot, 'installation.json'), adapterConfigPath(configuration)];
  const backupRoot = path.join(txDir, 'environment'); fs.mkdirSync(backupRoot, { mode: 0o700 });
  const records = files.map((target, index) => {
    lock.assertOwned();
    const record = { target, backup: String(index), exists: fs.existsSync(target) };
    if (record.exists) {
      const stat = fs.lstatSync(target); assertRelease(stat.isFile() && !stat.isSymbolicLink(), 'unsafe_install_environment');
      record.mode = stat.mode & 0o777; record.sha256 = fileSha256(target);
      fs.copyFileSync(target, path.join(backupRoot, record.backup)); fs.chmodSync(path.join(backupRoot, record.backup), 0o600);
    }
    return record;
  });
  syncTree(backupRoot); return records;
}
function restoreEnvironment(journal, txDir, lock, configuration) {
  const expected = [path.join(configuration.stateRoot, 'install.env'), path.join(configuration.installRoot, 'installation.json'), adapterConfigPath(configuration)];
  assertRelease(Array.isArray(journal.environment_files) && journal.environment_files.length === expected.length, 'invalid_install_journal');
  journal.environment_files.forEach((record, index) => {
    assertRelease(record.target === expected[index] && record.backup === String(index), 'invalid_install_journal');
    try { assertRelease(!fs.lstatSync(record.target).isSymbolicLink(), 'unsafe_install_environment'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (record.exists) assertRelease(fileSha256(path.join(txDir, 'environment', record.backup)) === record.sha256, 'unit_backup_digest_mismatch');
  });
  for (const record of journal.environment_files ?? []) {
    lock.assertOwned();
    if (record.exists) {
      const saved = path.join(txDir, 'environment', record.backup);
      assertRelease(fileSha256(saved) === record.sha256, 'unit_backup_digest_mismatch');
      fs.copyFileSync(saved, record.target); fs.chmodSync(record.target, record.mode);
    } else fs.rmSync(record.target, { force: true });
  }
}
function snapshotCli(configuration) {
  if (!configuration.cliPath) return null;
  try {
    const stat = fs.lstatSync(configuration.cliPath); assertRelease(stat.isSymbolicLink(), 'unowned_cli_entry');
    const rawTarget = fs.readlinkSync(configuration.cliPath);
    const resolved = path.resolve(path.dirname(configuration.cliPath), rawTarget);
    assertRelease(resolved === path.join(configuration.installRoot, 'current/bin/ao-pilot.js') || resolved === configuration.legacyCliTarget, 'unowned_cli_entry');
    return { exists: true, target: rawTarget };
  } catch (error) { if (error.code === 'ENOENT') return { exists: false }; throw error; }
}
function restoreCli(configuration, snapshot, lock) {
  if (!configuration.cliPath || !snapshot) return;
  lock.assertOwned();
  try {
    assertRelease(fs.lstatSync(configuration.cliPath).isSymbolicLink(), 'unowned_cli_entry');
    const target = path.resolve(path.dirname(configuration.cliPath), fs.readlinkSync(configuration.cliPath));
    assertRelease(target === path.join(configuration.installRoot, 'current/bin/ao-pilot.js'), 'unowned_cli_entry');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!snapshot.exists) fs.rmSync(configuration.cliPath, { force: true });
  else {
    const temp = `${configuration.cliPath}.rollback-${randomUUID()}`;
    fs.symlinkSync(snapshot.target, temp); fs.renameSync(temp, configuration.cliPath);
  }
  syncDirectory(path.dirname(configuration.cliPath));
}
async function garbageCollect({ root, lock, runner, protectedTargets, remove = fs.rmSync }) {
  const pins = await runner.pins();
  const retained = new Set(protectedTargets.filter(Boolean).map((target) => path.resolve(root, target)));
  for (const pin of pins) retained.add(path.resolve(pin));
  for (const name of fs.readdirSync(path.join(root, 'releases'))) {
    if (!/^[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(name)) continue;
    const directory = path.join(root, 'releases', name);
    if (retained.has(directory)) continue;
    lock.assertOwned(); verifyReleaseTree(directory);
    remove(directory, { recursive: true });
  }
}
export async function applyRelease({
  bundle, expectedEnvelopeSha256, configuration, runner = null, mode = 'daily',
  resume = false, allowDatabaseRestore = false, adoptLegacy = false, adoptLegacyOffline = false, now = () => new Date().toISOString(),
  inject = () => {}, removeOldRelease = fs.rmSync,
} = {}) {
  assertRelease(['daily', 'first'].includes(mode), 'invalid_install_mode');
  assertRelease(!adoptLegacyOffline || adoptLegacy && mode === 'first' && !resume, 'install_legacy_adoption_not_first');
  runner ??= createSystemdReleaseRunner(configuration);
  const tools = await runner.checkTools?.();
  const root = path.resolve(configuration.installRoot);
  const lock = acquireInstallLock(root, { flock: tools?.flock });
  const transactionRoot = path.join(root, 'transactions');
  const journalPath = path.join(root, 'install-journal.json');
  const stopServices = async () => runner.stop({ baseline: journal.baseline,
    legacyAdoption: !journal.unit_backup_complete && !journal.new_services_started ? journal.legacy_adoption : null,
    legacyStopped: journal.legacy_stop_complete === true });
  let journal = null; let manifest = null; let manifestSha256 = null;
  let phase = 'preflight'; let committed = false; let report = null; let oldManifest = null;
  let prior = null; let previous = null; let txDir; let units;
  try {
    lock.assertOwned();
    assertRelease(!adoptLegacy || mode === 'first' && !resume
      && !entryExists(path.join(root, 'current')) && !entryExists(journalPath), 'install_legacy_adoption_not_first');
    const verified = verifyReleaseEnvelope(bundle, expectedEnvelopeSha256);
    manifest = verified.manifest; assertRuntimeLockArtifact(path.join(bundle, 'payload'), manifest); manifestSha256 = verified.envelope.manifest_sha256;
    assertRelease(manifest.platform.os === process.platform && manifest.platform.arch === process.arch, 'release_platform_unsupported');
    fs.mkdirSync(path.join(root, 'releases'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(transactionRoot, { recursive: true, mode: 0o700 });
    const target = `releases/${manifest.release_id}`;
    const final = path.join(root, target);
    const envFile = path.join(configuration.stateRoot, 'install.env');
    units = renderReleaseUnits({ installRoot: root, stateRoot: configuration.stateRoot, envFile,
      nodePath: manifest.toolchain.node_executable, namespace: configuration.namespace });
    if (fs.existsSync(journalPath)) {
      const pending = readJson(journalPath);
      assertRelease(pending.schema_version === 'ao.install-journal.v1', 'invalid_install_journal');
      if (!['committed', 'rolled_back'].includes(pending.phase)) {
        assertRelease(resume && pending.release_id === manifest.release_id && pending.envelope_sha256 === expectedEnvelopeSha256
          && pending.configuration_sha256 === objectSha256(configuration), 'interrupted_install_requires_resume');
        assertRelease(pending.mode !== 'first' || Array.isArray(pending.restore_baseline?.identities), 'install_restore_scope_unknown');
        journal = pending; txDir = path.join(transactionRoot, journal.transaction_id);
        assertRelease(/^[-a-f0-9]+$/.test(journal.transaction_id) && fs.existsSync(txDir), 'invalid_install_journal');
        prior = journal.old; previous = journal.previous;
        assertRelease(journal.target === target && [prior, previous].every((value) => value === null || /^releases\/[0-9][A-Za-z0-9._-]*\+[a-f0-9]{40}$/.test(value))
          && fs.realpathSync(txDir) === txDir && fs.statSync(txDir).uid === process.getuid(), 'invalid_install_journal');
        const actual = pointer(root, 'current');
        assertRelease(actual === prior || actual === target, 'interrupted_install_pointer_unknown');
        // A previously prepared release is immutable and already renamed. Never
        // infer a successful commit from current alone: repeat verify/readback.
        assertRelease(fs.existsSync(final), 'interrupted_install_release_missing');
        verifyReleaseTree(final, manifestSha256);
        lock.assertOwned(); journal.owner = lock.owner; durableJson(journalPath, journal);
      }
    }
    if (!journal) {
      prior = pointer(root, 'current'); previous = pointer(root, 'previous');
      oldManifest = prior ? verifyReleaseTree(path.join(root, prior)) : null;
      const baseline = await runner.preflight({ releaseRoot: prior ? path.join(root, prior) : path.join(bundle, 'payload'), probeRoot: path.join(bundle, 'payload'), manifest, mode, adoptLegacy, adoptLegacyOffline });
      assertRelease(Array.isArray(baseline.cids) && baseline.database?.integrity === 'ok', 'install_baseline_unknown');
      assertRelease(!adoptLegacy || baseline.legacy_adoption && typeof runner.checkLegacy === 'function', 'install_legacy_inventory_required');
      assertRelease(!adoptLegacyOffline || baseline.legacy_adoption?.adoption_mode === 'offline', 'install_legacy_offline_baseline_required');
      inject('preflight', { manifest });
      const transactionId = lock.owner.transaction_id;
      txDir = path.join(transactionRoot, transactionId); fs.mkdirSync(txDir, { mode: 0o700 });
      journal = { schema_version: 'ao.install-journal.v1', transaction_id: transactionId, release_id: manifest.release_id,
        envelope_sha256: expectedEnvelopeSha256, manifest_sha256: manifestSha256, configuration_sha256: objectSha256(configuration),
        owner: lock.owner, old: prior, previous, target, phase: 'install', mode, baseline,
        restore_baseline: mode === 'first' ? { projects: baseline.projects,
          identities: firstRestoreIdentities(configuration, baseline) } : null,
        old_manifest: oldManifest, database_backup: null, unit_backup_complete: false, switched: false, cli_snapshot: snapshotCli(configuration),
        legacy_adoption: adoptLegacy ? baseline.legacy_adoption : null };
      lock.assertOwned(); durableJson(journalPath, journal);
      phase = 'install';
      const partial = `${final}.partial`; const partialOwner = `${partial}.owner.json`;
      if (!fs.existsSync(final)) {
        if (fs.existsSync(partial)) {
          assertRelease(fs.existsSync(partialOwner), 'unknown_partial_owner');
          const owner = readJson(partialOwner);
          assertRelease(owner.schema_version === 'ao.install-partial.v1' && owner.release_id === manifest.release_id
            && owner.envelope_sha256 === expectedEnvelopeSha256 && typeof owner.nonce === 'string', 'unknown_partial_owner');
          lock.assertOwned(); fs.rmSync(partial, { recursive: true });
        }
        lock.assertOwned(); durableJson(partialOwner, { schema_version: 'ao.install-partial.v1', release_id: manifest.release_id,
          envelope_sha256: expectedEnvelopeSha256, nonce: lock.owner.nonce });
        fs.cpSync(path.join(bundle, 'payload'), partial, { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
        inject('partial', { partial }); lock.assertOwned();
        verifyReleaseTree(partial, manifestSha256); syncTree(partial);
        fs.renameSync(partial, final); syncDirectory(path.dirname(final)); fs.rmSync(partialOwner, { force: true });
      }
      verifyReleaseTree(final, manifestSha256);
      journal.phase = 'prepared'; lock.assertOwned(); durableJson(journalPath, journal);
      inject('prepared', { final });
    }
    oldManifest ??= journal.old_manifest;
    phase = 'switch';
    if (journal.phase === 'install') throw Object.assign(new Error('Incomplete prepare requires retry after preserving owned partial'), { code: 'interrupted_install_release_missing' });
    if (journal.legacy_adoption && !journal.unit_backup_complete && !journal.new_services_started) {
      await runner.checkLegacy({ evidence: journal.legacy_adoption, stopped: journal.legacy_stop_complete === true });
    }
    // Durable intent precedes the first external stop. Freeze existing service
    // entrypoints and all DB writers before taking the rollback snapshot.
    journal.service_mutation_started = true; lock.assertOwned(); durableJson(journalPath, journal);
    await stopServices();
    if (journal.legacy_adoption) { journal.legacy_stop_complete = true; lock.assertOwned(); durableJson(journalPath, journal); }
    inject('stopped', {});
    const stopped = await runner.quiescent({ offline: journal.legacy_adoption?.adoption_mode === 'offline' });
    journal.stopped_snapshot = stopped; lock.assertOwned(); durableJson(journalPath, journal);
    assertRelease(Array.isArray(stopped.cids) && stopped.database?.integrity === 'ok'
      && objectSha256([...stopped.cids].sort()) === objectSha256([...journal.baseline.cids].sort()) && nativeBindingsUnchanged(stopped, journal.baseline), 'install_baseline_changed');
    if (!journal.database_backup) {
      journal.database_backup = await runner.backupDatabase({ backupRoot: path.join(txDir, 'database'), offline: journal.legacy_adoption?.adoption_mode === 'offline' });
      assertRelease(journal.database_backup?.sha256 && fs.existsSync(journal.database_backup.path)
        && fileSha256(journal.database_backup.path) === journal.database_backup.sha256, 'install_database_backup_invalid');
      lock.assertOwned(); durableJson(journalPath, journal);
    }
    const unitBackup = path.join(txDir, 'units');
    if (!journal.environment_files) {
      journal.environment_files = snapshotEnvironment(configuration, txDir, lock); lock.assertOwned(); durableJson(journalPath, journal);
    }
    if (!journal.unit_backup_complete) {
      // Snapshot install.env independently; units and environment form one
      // rollback input. Unknown files are never silently treated as absent.
      fs.mkdirSync(unitBackup, { recursive: true, mode: 0o700 });
      backupAndInstallUnits({ unitRoot: configuration.unitRoot, backupRoot: unitBackup, units, lock,
        environmentOverride: configuration.environmentOverride ?? null,
        onBackup: () => { journal.unit_backup_complete = true; lock.assertOwned(); durableJson(journalPath, journal); } });
    } else writeReleaseUnits({ unitRoot: configuration.unitRoot, units, lock, environmentOverride: configuration.environmentOverride ?? null });
    lock.assertOwned(); durableJson(adapterConfigPath(configuration), adapterConfiguration(configuration));
    const deferredBootIDs = mode === 'first' ? journal.baseline.identities.map(row => row.ao_session_id) : [];
    writeEnvironment(configuration, lock, manifest, final, deferredBootIDs);
    lock.assertOwned(); durableJson(path.join(root, 'installation.json'), configuration);
    journal.phase = 'switching'; lock.assertOwned(); durableJson(journalPath, journal);
    switchPointer(root, 'previous', prior, lock); inject('previous', {});
    switchPointer(root, 'current', target, lock);
    journal.switched = true; journal.phase = 'switched'; lock.assertOwned(); durableJson(journalPath, journal);
    inject('current', {});
    journal.cli_installed = true; lock.assertOwned(); durableJson(journalPath, journal);
    installCliLink(configuration, lock);
    journal.new_services_started = true; lock.assertOwned(); durableJson(journalPath, journal);
    await runner.reload();
    journal.start_result = await runner.start({ releaseRoot: final, mode,
      baseline: mode === 'first' ? journal.restore_baseline : journal.stopped_snapshot });
    lock.assertOwned(); durableJson(journalPath, journal);
    phase = 'verify'; journal.phase = phase; lock.assertOwned(); durableJson(journalPath, journal);
    assertRelease(!configuration.cliPath || fs.realpathSync(configuration.cliPath) === path.join(final, 'bin/ao-pilot.js'), 'install_cli_drift');
    const observed = await runner.observe({ releaseRoot: final });
    report = inspectInstall({ releaseRoot: final, observation: observed, baseline: journal.baseline, mode: journal.mode });
    assertRelease(report.status === 'passed', 'install_verify_failed'); inject('verify', {});
    phase = 'readback'; journal.phase = phase; lock.assertOwned(); durableJson(journalPath, journal);
    const readback = await runner.observe({ releaseRoot: final });
    const confirmed = inspectInstall({ releaseRoot: final, observation: readback, baseline: journal.baseline, mode: journal.mode });
    assertRelease(confirmed.status === 'passed' && pointer(root, 'current') === target
      && pointer(root, 'previous') === prior, 'install_readback_failed');
    assertRelease(['daemon', 'dashboard', 'adapter', 'session-recovery'].every((name) =>
      observed.services[name].pid === readback.services[name].pid
      && observed.services[name].start_token === readback.services[name].start_token), 'install_identity_changed');
    journal.phase = 'committed'; journal.completed_at = now(); lock.assertOwned(); durableJson(journalPath, journal);
    committed = true;
    const privateReceipt = { journal, verify: observed, readback, checks: confirmed.checks };
    savePrivateInstallReceipt(path.join(txDir, 'private-receipt.json'), privateReceipt);
    let warnings = 0;
    if(deferredBootIDs.length)try{writeEnvironment(configuration,lock,manifest,final)}catch(error){warnings+=1;savePrivateInstallReceipt(path.join(txDir,'boot-deferral-cleanup-warning.json'),{code:error.code??'boot_deferral_cleanup_failed',message:error.message});}

    try {
      inject('gc', {});
      await garbageCollect({ root, lock, runner, protectedTargets: [target, prior, previous], remove: removeOldRelease });
    } catch (error) {
      warnings += 1; lock.assertOwned();
      savePrivateInstallReceipt(path.join(txDir, 'gc-warning.json'), { code: error.code ?? 'gc_failed', message: error.message });
    }
    const receipt = publicInstallReceipt({ manifest, manifestSha256, phase: 'committed', result: 'passed', checks: confirmed.checks,
      warnings, failureCode: warnings ? 'gc_warning' : 'none', now });
    lock.assertOwned(); durableJson(path.join(txDir, 'public-receipt.json'), receipt);
    return receipt;
  } catch (error) {
    if (error.simulatedCrash) throw error;
    let rollbackRequired = false;
    if (journal && !committed && journal.service_mutation_started && ['switch', 'verify', 'readback'].includes(phase)) {
      try {
        lock.assertOwned();
        await stopServices();
        const old = journal.old_manifest;
        let schema = journal.new_services_started ? report?.evidence?.database?.schema : journal.baseline?.database?.schema;
        if (journal.new_services_started && !Number.isSafeInteger(schema)) {
          try { schema = (await runner.observe({ releaseRoot: path.join(root, journal.target) })).database?.schema; } catch { /* unknown stays fail-closed */ }
        }
        const oldCompatible = old && (!journal.new_services_started || manifest.database.previous_reader_compatible
          && manifest.database.previous_binary_sha256 === old.components.daemon.files.find((file) => file.path === old.components.daemon.entrypoint)?.sha256
          && Number.isSafeInteger(schema)
          && schema >= old.database.schema_min_readable && schema <= old.database.schema_max_readable);
        if (old && !oldCompatible && !allowDatabaseRestore) throw Object.assign(new Error('Backup restore with explicit data-loss acceptance required'), { code: 'install_rollback_requires_backup' });
        if (old && !oldCompatible) await runner.restoreDatabase({ backup: journal.database_backup });
        switchPointer(root, 'current', journal.old, lock); switchPointer(root, 'previous', journal.previous, lock);
        if (journal.unit_backup_complete) restoreUnitBackup({ unitRoot: configuration.unitRoot, backupRoot: path.join(txDir, 'units'), units, lock });
        if (journal.environment_files) restoreEnvironment(journal, txDir, lock, configuration);
        if (journal.cli_installed) restoreCli(configuration, journal.cli_snapshot, lock);
        await runner.reload();
        assertRelease(journal.old !== null, 'legacy_restore_requires_manual_start');
        await runner.start({ releaseRoot: path.join(root, journal.old), rollback: true });
        const rollbackObservation = await runner.observe({ releaseRoot: path.join(root, journal.old), tmuxProbeRoot: path.join(root, journal.target) });
        const rollbackReport = inspectInstall({ releaseRoot: path.join(root, journal.old), observation: rollbackObservation,
          baseline: journal.stopped_snapshot?.cids ? { ...journal.baseline, cids: journal.stopped_snapshot.cids } : journal.baseline, mode: journal.mode });
        assertRelease(rollbackReport.status === 'passed', 'install_rollback_readback_failed');
        journal.phase = 'rolled_back'; lock.assertOwned(); durableJson(journalPath, journal);
      } catch (rollbackError) {
        rollbackRequired = true; lock.assertOwned();
        journal.phase = 'recovery_required'; journal.rollback_error = { code: rollbackError.code, message: rollbackError.message };
        durableJson(journalPath, journal);
      }
    } else if (journal && !committed) {
      // A failed prepare owns no service changes; allow same-version retry.
      journal.phase = 'rolled_back'; lock.assertOwned(); durableJson(journalPath, journal);
    }
    if (manifest && txDir) {
      savePrivateInstallReceipt(path.join(txDir, 'private-failure.json'), { phase, code: error.code, message: error.message, journal });
      const receipt = publicInstallReceipt({ manifest, manifestSha256, phase,
        result: rollbackRequired || error.code === 'install_baseline_changed' ? 'hold' : 'failed', checks: report?.checks,
        failureCode: rollbackRequired ? 'rollback_required' : `${phase}_failed`, now });
      lock.assertOwned(); durableJson(path.join(txDir, 'public-receipt.json'), receipt);
      error.publicReceipt = receipt;
    }
    throw error;
  } finally { lock.release(); }
}
export async function preflightRelease({ bundle, expectedEnvelopeSha256, configuration, runner = null, mode = 'daily', adoptLegacy = false, adoptLegacyOffline = false } = {}) {
  assertRelease(['daily', 'first'].includes(mode), 'invalid_install_mode');
  assertRelease(!adoptLegacyOffline || adoptLegacy && mode === 'first', 'install_legacy_adoption_not_first');
  runner ??= createSystemdReleaseRunner(configuration);
  await runner.checkTools?.();
  const verified = verifyReleaseEnvelope(bundle, expectedEnvelopeSha256);
  assertRuntimeLockArtifact(path.join(bundle, 'payload'), verified.manifest);
  assertRelease(verified.manifest.platform.os === process.platform && verified.manifest.platform.arch === process.arch, 'release_platform_unsupported');
  const root = path.resolve(configuration.installRoot), prior = pointer(root, 'current');
  assertRelease(!adoptLegacy || mode === 'first' && !prior && !entryExists(path.join(root, 'current')) && !entryExists(path.join(root, 'install-journal.json')), 'install_legacy_adoption_not_first');
  const baseline = await runner.preflight({ releaseRoot: prior ? path.join(root, prior) : path.join(bundle, 'payload'), probeRoot: path.join(bundle, 'payload'), manifest: verified.manifest, mode, adoptLegacy, adoptLegacyOffline });
  assertRelease(Array.isArray(baseline.cids) && baseline.database?.integrity === 'ok', 'install_baseline_unknown');
  assertRelease(!adoptLegacyOffline || baseline.legacy_adoption?.adoption_mode === 'offline', 'install_legacy_offline_baseline_required');
  return { status: 'passed', phase: 'preflight', release_id: verified.manifest.release_id, tools: await runner.checkTools?.(), baseline, production_mutated: false };
}
export { pointer as readReleasePointer };
