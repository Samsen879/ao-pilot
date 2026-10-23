import fs from 'node:fs';
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
  assertRelease(envelope.release_id === manifest.release_id && objectSha256(envelope.platform) === objectSha256(manifest.platform), 'release_envelope_identity_mismatch');
  return { envelope, manifest };
}
export async function buildRelease({
  repository, commit = 'HEAD', version, output, adapter = null, compatibilityEvidence,
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
    assertRelease(adapter !== null, 'release_adapter_source_missing');
    const adapterRoot = relativePath(adapter.root);
    const adapterEntry = relativePath(adapter.entrypoint);
    assertRelease(adapterEntry.startsWith(`${adapterRoot}/`), 'release_adapter_source_missing');
    assertRelease(fs.existsSync(confined(source, adapterEntry)) && fs.existsSync(confined(source, adapter.license))
      && fs.statSync(confined(source, adapterEntry)).isFile() && fs.statSync(confined(source, adapter.license)).isFile(), 'release_adapter_source_missing');
    const compatibilityFile = confined(source, compatibilityEvidence ?? 'release/compatibility.json');
    assertRelease(fs.existsSync(compatibilityFile), 'release_compatibility_evidence_missing');
    const compatibility = readJson(compatibilityFile);
    assertRelease(compatibility.schema_version === 'ao.schema-compatibility.v1'
      && compatibility.result === 'passed' && compatibility.old_reader_result === 'passed'
      && /^[a-f0-9]{64}$/.test(compatibility.old_binary_sha256 ?? ''), 'release_compatibility_evidence_missing');
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
    assertRelease(fileSha256(path.join(source, 'native/ao')) === compatibility.candidate_binary_sha256, 'release_compatibility_binary_mismatch');
    const schemaCurrent = Math.max(...fs.readdirSync(path.join(source, 'runtime/headless/backend/internal/storage/sqlite/migrations'))
      .filter((file) => /^\d+.*\.sql$/.test(file)).map((file) => Number(file.split('_')[0])));
    assertRelease(schemaCurrent === compatibility.schema_current, 'release_schema_incompatible');
    const lockFile = path.join(source, 'runtime/agent-orchestrator.lock.json');
    const lock = readJson(lockFile);
    const packageMetadata = readJson(path.join(source, 'package.json'));
    packageMetadata.files = [...new Set([...(packageMetadata.files ?? []), 'release.json', 'native', adapterRoot])];
    fs.writeFileSync(path.join(source, 'package.json'), `${JSON.stringify(packageMetadata, null, 2)}\n`);
    const files = inventoryTree(source);
    const scopes = {
      daemon: { entrypoint: 'native/ao', roots: ['native'] },
      cli: { entrypoint: 'bin/ao-pilot.js', roots: ['bin', 'scripts', 'lib', 'schemas', 'templates', 'runtime', 'node_modules', 'package.json', 'package-lock.json'] },
      dashboard: { entrypoint: 'scripts/ao-dashboard.js', roots: ['browser', 'scripts/ao-dashboard.js'] },
      adapter: { entrypoint: adapterEntry, roots: [adapterRoot] },
    };
    const components = Object.fromEntries(Object.entries(scopes).map(([name, spec]) => {
      const componentFiles = files.filter((entry) => spec.roots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`)));
      return [name, { entrypoint: spec.entrypoint, source_commit: resolved, files: componentFiles, sha256: objectSha256(componentFiles) }];
    }));
    const manifest = {
      schema_version: 'ao.release.v1', release_id: `${version}+${resolved}`, version, commit: resolved, tree,
      built_at: now(), platform: { os: 'linux', arch: process.arch }, toolchain,
      database: {
        schema_current: schemaCurrent, schema_min_readable: compatibility.schema_min_readable,
        schema_max_readable: compatibility.schema_max_readable, compatibility_evidence_sha256: fileSha256(compatibilityFile),
      },
      runtime_lock: { runtime_ref: lock.runtime_ref, sha256: fileSha256(lockFile), commit: lock.artifact.ref.commit_sha, tree: lock.artifact.ref.tree_sha,
        binary_sha256: lock.compatibility.platforms.find((platform) => platform.os === 'linux' && platform.arch === process.arch)?.binary_sha256 },
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
    verifyReleaseTree(source);
    onStage('manifest', source);
    const packDir = path.join(buildRoot, 'pack'); fs.mkdirSync(packDir);
    const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: source, env }));
    assertRelease(pack.length === 1 && /^[^/\\]+\.tgz$/.test(pack[0].filename ?? ''), 'release_pack_failed');
    const tarball = path.join(packDir, pack[0].filename);
    const tarballSha = fileSha256(tarball);
    const packedPaths = run('tar', ['-tzf', tarball], { env }).split('\n');
    for (const entry of ['release.json', 'native/ao', adapterEntry, 'browser/packages/web/.next/BUILD_ID', 'browser/packages/web/dist-server/start-all.js']) {
      assertRelease(packedPaths.includes(`package/${entry}`), 'release_package_component_missing');
    }
    if (verifyPackage) run(process.execPath, [path.join(source, 'scripts/verify-package-install.js'), '--tarball', tarball, '--sha256', tarballSha], { cwd: source, env });
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
  } finally { fs.rmSync(buildRoot, { recursive: true, force: true }); }
}
