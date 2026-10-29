import fs from 'node:fs';
import { MANAGED_RECOVERY_BINDINGS_CONTRACT } from './session-recovery.js';
import { verifyPackedRelease, payloadOnlyPath } from './release-tarball.js';
import { NATIVE_ADAPTER_SOURCE } from './release-adapter.js';
import { materializeRegisteredReleaseFiles } from './release-inputs.js';
import { CANDIDATE_RUNTIME_PIN, candidateRuntimeRef } from './release-runtime.js';
import { normalizeRuntimeLock } from './runtime-lock.js';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertRelease, canonical, confined, durableJson, fileSha256, inventoryTree,
  objectSha256, readJson, relativePath, syncDirectory, verifyReleaseTree,
} from './release-manifest.js';

export function releaseCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  assertRelease(!result.error && result.status === 0, 'release_command_failed', `Release command failed: ${command}`);
  return result.stdout?.trim() ?? '';
}
function executable(name, env) {
  for (const directory of String(env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); return fs.realpathSync(file); } catch { /* continue */ }
  }
  throw Object.assign(new Error(`Missing build executable: ${name}`), { code: 'release_toolchain_missing' });
}
export function verifyReleaseEnvelope(bundle, expectedSha256) {
  assertRelease(/^[a-f0-9]{64}$/.test(expectedSha256 ?? ''), 'release_envelope_pin_required');
  const file = path.join(bundle, 'release-envelope.json');
  assertRelease(fileSha256(file) === expectedSha256, 'release_envelope_digest_mismatch');
  const envelope = readJson(file);
  assertRelease(envelope.schema_version === 'ao.release-envelope.v1'
    && Object.keys(envelope).sort().join(',') === 'manifest_sha256,npm_tarball_sha256,platform,release_id,schema_version', 'invalid_release_envelope');
  const manifest = verifyReleaseTree(path.join(bundle, 'payload'), envelope.manifest_sha256);
  assertRelease(fileSha256(path.join(bundle, 'package.tgz')) === envelope.npm_tarball_sha256, 'release_package_digest_mismatch');
  verifyPackedRelease(path.join(bundle, 'package.tgz'), path.join(bundle, 'payload'), manifest);
  assertRelease(envelope.release_id === manifest.release_id && objectSha256(envelope.platform) === objectSha256(manifest.platform), 'release_envelope_identity_mismatch');
  return { envelope, manifest };
}
export async function buildRelease({
  repository, commit = 'HEAD', version, output, adapter = undefined, compatibilityEvidence, oldBinary, diagnosticsFile,
  env = process.env, run = releaseCommand, verifyPackage = true,
  now = () => new Date().toISOString(), onStage = () => {},
} = {}) {
  assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
  assertRelease(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch), 'release_platform_unsupported');
  assertRelease(/^[0-9][0-9A-Za-z._-]*$/.test(version ?? ''), 'invalid_release_version');
  const resolved = run('git', ['rev-parse', '--verify', `${commit}^{commit}`], { cwd: repository, env });
  assertRelease(/^[a-f0-9]{40}$/.test(resolved), 'invalid_release_commit');
  const tree = run('git', ['rev-parse', `${resolved}^{tree}`], { cwd: repository, env });
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-release-build-'));
  const source = path.join(buildRoot, 'payload');
  const archive = path.join(buildRoot, 'source.tar');
  let inventoryPhase = 'archive';
  try {
    fs.mkdirSync(source, { mode: 0o700 });
    run('git', ['archive', '--format=tar', '-o', archive, resolved], { cwd: repository, env });
    run('tar', ['-xf', archive, '-C', source], { env });
    // Reject escaped/special archive inputs before any dependency script or build
    // can read them. A final-only manifest check would be too late.
    inventoryTree(source, { exclude: [] });
    onStage('archive', source);
    // Inputs must belong to this archive. No importing unknown installed code,
    // development worktree dist or another release's node_modules is permitted.
    if (adapter === undefined) adapter = NATIVE_ADAPTER_SOURCE;
    assertRelease(adapter !== null, 'release_adapter_source_missing');
    const adapterRoot = relativePath(adapter.root);
    const adapterEntry = relativePath(adapter.entrypoint);
    assertRelease(adapterEntry.startsWith(`${adapterRoot}/`), 'release_adapter_source_missing');
    assertRelease(fs.existsSync(confined(source, adapterEntry)) && fs.existsSync(confined(source, adapter.license))
      && fs.statSync(confined(source, adapterEntry)).isFile() && fs.statSync(confined(source, adapter.license)).isFile(), 'release_adapter_source_missing');
    const compatibilityFile = confined(source, compatibilityEvidence ?? 'release/compatibility.json');
    assertRelease(fs.existsSync(compatibilityFile), 'release_compatibility_evidence_missing');
    const compatibility = readJson(compatibilityFile);
    assertRelease(compatibility.schema_version === 'ao.schema-compatibility-input.v1'
      && /^[a-f0-9]{64}$/.test(compatibility.old_binary_sha256 ?? '') && oldBinary
      && fileSha256(oldBinary) === compatibility.old_binary_sha256, 'release_compatibility_artifact_missing');
    const fixtureDatabase = confined(source, compatibility.fixture_database);
    assertRelease(fileSha256(fixtureDatabase) === compatibility.fixture_sha256, 'release_compatibility_fixture_mismatch');
    const go = run('go', ['version'], { env }).match(/\bgo(1\.25\.\d+)\b/)?.[1];
    const tmuxPath = executable('tmux', env);
    const tmux = run(tmuxPath, ['-V'], { env });
    const tmuxVersion = tmux.match(/\b(\d+)\.(\d+)/);
    assertRelease(go && tmuxVersion && (Number(tmuxVersion[1]) > 3 || Number(tmuxVersion[1]) === 3 && Number(tmuxVersion[2]) >= 2), 'release_toolchain_unsupported');
    const toolchain = {
      go, CGO_ENABLED: '0', node: process.version, npm: run('npm', ['--version'], { env }),
      git: run('git', ['--version'], { env }), tmux,
      node_executable: fs.realpathSync(process.execPath), node_sha256: fileSha256(process.execPath),
      tmux_executable: tmuxPath, tmux_sha256: fileSha256(tmuxPath),
    };
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, env });
    onStage('root_dependencies', source);
    const browser = path.join(source, 'browser');
    run('npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: browser, env });
    run('npm', ['run', 'build:deps'], { cwd: browser, env });
    run('npm', ['run', 'build'], { cwd: browser, env });
    onStage('dashboard', source);
    if (adapter.build) {
      assertRelease(Array.isArray(adapter.build) && adapter.build.length > 0, 'invalid_adapter_build');
      run(adapter.build[0], adapter.build.slice(1), { cwd: confined(source, adapterRoot), env });
    }
    fs.mkdirSync(path.join(source, 'native'), { mode: 0o755 });
    run('go', ['build', '-trimpath', '-buildvcs=false', '-o', path.join(source, 'native/ao'), './cmd/ao'], {
      cwd: path.join(source, 'runtime/headless/backend'), env: { ...env, CGO_ENABLED: '0', GOOS: 'linux' },
    });

    const schemaCurrent = Math.max(...fs.readdirSync(path.join(source, 'runtime/headless/backend/internal/storage/sqlite/migrations'))
      .filter((file) => /^\d+.*\.sql$/.test(file)).map((file) => Number(file.split('_')[0])));
    const compatibilityResult = path.join(buildRoot, 'compatibility-result.json');
    run(process.execPath, [path.join(source, 'scripts/verify-schema-compatibility.js'), '--candidate', path.join(source, 'native/ao'),
      '--old', oldBinary, '--fixture', fixtureDatabase, '--schema', String(schemaCurrent), '--output', compatibilityResult], { env });
    const observedCompatibility = readJson(compatibilityResult);
    assertRelease(observedCompatibility.schema_version === 'ao.schema-compatibility-result.v1'
      && observedCompatibility.candidate_result === 'passed' && ['passed', 'failed'].includes(observedCompatibility.old_reader_result)
      && observedCompatibility.candidate_binary_sha256 === fileSha256(path.join(source, 'native/ao'))
      && observedCompatibility.old_binary_sha256 === compatibility.old_binary_sha256
      && observedCompatibility.fixture_sha256 === compatibility.fixture_sha256
      && observedCompatibility.schema_after === schemaCurrent && observedCompatibility.integrity === 'ok', 'release_compatibility_result_mismatch');
    fs.copyFileSync(compatibilityResult, path.join(source, 'release/compatibility-result.json'));
    inventoryPhase = 'registered_inputs';
    const materializedFiles = materializeRegisteredReleaseFiles(source);
    durableJson(path.join(source, 'release/materialized-inputs.json'), { schema_version: 'ao.release-materialized-inputs.v1', files: materializedFiles });
    onStage('inputs_materialized', source);
    const lockFile = path.join(source, 'runtime/agent-orchestrator.lock.json');
    normalizeRuntimeLock(readJson(lockFile));
    const runtimePin = { schema_version: 'ao.release-runtime-pin.v1', release_id: `${version}+${resolved}`, version,
      runtime_ref: candidateRuntimeRef(version), commit: resolved, tree, platform: { os: 'linux', arch: process.arch },
      binary_sha256: fileSha256(path.join(source, 'native/ao')), source_lock_sha256: fileSha256(lockFile) };
    durableJson(path.join(source, CANDIDATE_RUNTIME_PIN), runtimePin);
    const packageMetadata = readJson(path.join(source, 'package.json'));
    inventoryPhase = 'built_payload';
    // npm interprets files entries as glob patterns, including literal Next routes.
    packageMetadata.files = [...new Set(['release.json', ...inventoryTree(source).filter((file) => file.type !== 'directory' && !payloadOnlyPath(file.path))
      .map((file) => file.path.replace(/[?*\[\]{}()!+@]/g, '\\$&'))])];
    fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`);
    const files = inventoryTree(source);
    const scopes = {
      daemon: { entrypoint: 'native/ao', roots: ['native'] },
      cli: { entrypoint: 'bin/ao-pilot.js', roots: ['bin', 'scripts', 'lib', 'schemas', 'templates', 'runtime', CANDIDATE_RUNTIME_PIN, 'node_modules', 'package.json', 'package-lock.json'] },
      dashboard: { entrypoint: 'scripts/ao-dashboard.js', roots: ['browser', 'scripts/ao-dashboard.js'] },
      adapter: { entrypoint: adapterEntry, roots: [adapterRoot] },
    };
    const components = Object.fromEntries(Object.entries(scopes).map(([name, spec]) => {
      const componentFiles = files.filter((entry) => spec.roots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)));
      return [name, { entrypoint: spec.entrypoint, source_commit: resolved, files: componentFiles, sha256: objectSha256(componentFiles) }];
    }));
    components.cli.recovery_bindings = MANAGED_RECOVERY_BINDINGS_CONTRACT;
    const manifest = {
      schema_version: 'ao.release.v1', release_id: `${version}+${resolved}`, version, commit: resolved, tree,
      built_at: now(), platform: { os: 'linux', arch: process.arch }, toolchain,
      database: {
        schema_current: schemaCurrent, schema_min_readable: schemaCurrent, schema_max_readable: schemaCurrent,
        compatibility_evidence_sha256: fileSha256(compatibilityResult), previous_binary_sha256: compatibility.old_binary_sha256,
        previous_reader_compatible: observedCompatibility.old_reader_result === 'passed',
      },
      runtime_lock: { kind: 'candidate', runtime_ref: runtimePin.runtime_ref, sha256: fileSha256(path.join(source, CANDIDATE_RUNTIME_PIN)),
        commit: resolved, tree, binary_sha256: runtimePin.binary_sha256 },
      components, files,
      inputs: {
        archive_sha256: fileSha256(archive), root_lock_sha256: fileSha256(path.join(source, 'package-lock.json')),
        browser_lock_sha256: fileSha256(path.join(browser, 'package-lock.json')),
        source_import_sha256: fileSha256(path.join(browser, 'SOURCE_IMPORT.json')),
        unit_templates_sha256: objectSha256(files.filter((entry) => entry.path.startsWith('templates/'))),
        adapter_source: adapterRoot, adapter_license_sha256: fileSha256(confined(source, adapter.license)),
      },
    };
    durableJson(path.join(source, 'release.json'), canonical(manifest));
    inventoryPhase = 'manifest_verification';
    verifyReleaseTree(source);
    onStage('manifest', source);
    const packDir = path.join(buildRoot, 'pack'); fs.mkdirSync(packDir);
    const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: source, env }));
    assertRelease(pack.length === 1 && /^[^/\\]+\.tgz$/.test(pack[0].filename ?? ''), 'release_pack_failed');
    const tarball = path.join(packDir, pack[0].filename);
    const tarballSha = fileSha256(tarball);
    verifyPackedRelease(tarball, source, manifest);
    const packedPaths = run('tar', ['-tzf', tarball], { env }).split('\n');
    for (const entry of ['release.json', 'native/ao', adapterEntry, 'browser/packages/web/.next/BUILD_ID', 'browser/packages/web/dist-server/start-all.js']) {
      assertRelease(packedPaths.includes(`package/${entry}`), 'release_package_component_missing');
    }
    if (verifyPackage) run(process.execPath, [path.join(source, 'scripts/verify-package-install.js'), '--tarball', tarball, '--sha256', tarballSha, '--release-payload', source], { cwd: source, env });
    assertRelease(fileSha256(tarball) === tarballSha, 'release_package_digest_mismatch');
    verifyReleaseTree(source);
    const envelope = { schema_version: 'ao.release-envelope.v1', release_id: manifest.release_id,
      platform: manifest.platform, manifest_sha256: fileSha256(path.join(source, 'release.json')), npm_tarball_sha256: tarballSha };
    // Output is also transactional: a failed build never reserves the final id.
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const final = path.join(output, manifest.release_id);
    assertRelease(!fs.existsSync(final), 'release_output_exists');
    const partial = fs.mkdtempSync(path.join(output, '.build-'));
    try {
      fs.cpSync(source, path.join(partial, 'payload'), { recursive: true, dereference: false, preserveTimestamps: true, verbatimSymlinks: true });
      fs.copyFileSync(tarball, path.join(partial, 'package.tgz'));
      durableJson(path.join(partial, 'release-envelope.json'), envelope);
      const envelopeSha256 = fileSha256(path.join(partial, 'release-envelope.json'));
      verifyReleaseEnvelope(partial, envelopeSha256);
      fs.renameSync(partial, final); syncDirectory(output);
      return { release_id: manifest.release_id, bundle: final, envelope_sha256: envelopeSha256, npm_tarball_sha256: tarballSha };
    } catch (error) { fs.rmSync(partial, { recursive: true, force: true }); throw error; }
  } catch (error) {
    if (inventoryPhase === 'registered_inputs' && Array.isArray(error.violations)) {
      try { inventoryTree(source); }
      catch (inventoryError) {
        if (Array.isArray(inventoryError.violations)) error.violations.push(...inventoryError.violations);
      }
      error.violations.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    }
    if (diagnosticsFile && Array.isArray(error.violations)) {
      try {
        durableJson(path.resolve(diagnosticsFile), { schema_version: 'ao.release-build-diagnostics.v1', commit: resolved, tree,
          phase: inventoryPhase, result: 'FAIL', failure_code: error.code, violation_count: error.violations.length, violations: error.violations });
      } catch (diagnosticsError) {
        error.diagnostics_error_code = diagnosticsError.code ?? 'diagnostics_write_failed';
      }
    }
    throw error;
  } finally { fs.rmSync(buildRoot, { recursive: true, force: true }); }
}
