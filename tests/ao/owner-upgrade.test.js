import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from '@jest/globals';
import { fixtureRoot, configuration, createBundle } from './release-fixture.js';
import { durableJson, fileSha256 } from '../../scripts/ao/lib/release-manifest.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const script = fileURLToPath(new URL('../../scripts/ao-owner-upgrade.py', import.meta.url));
function fixture() {
  const root = fixtureRoot(); roots.push(root); const config = configuration(root), bundle = createBundle(root, { extraFiles: { 'scripts/ao/helper.js': '/* directory/file prefix ordering regression */' } });
  const local = path.join(root, 'L2-production'); fs.mkdirSync(local);
  durableJson(path.join(local, 'install-config.json'), config);
  durableJson(path.join(root, 'build-result.json'), { status: 'PASS', release_id: bundle.manifest.release_id,
    bundle: bundle.bundle, npm_tarball_sha256: fileSha256(path.join(bundle.bundle, 'package.tgz')), envelope_sha256: bundle.envelopeSha });
  const bwrap = path.join(root, 'fixture-bwrap');
  fs.writeFileSync(bwrap, '#!/bin/sh\nprintf \'{"status":"passed","path":"%s","node_options":"%s","argv":"%s"}\\n\' "$PATH" "${NODE_OPTIONS-}" "$*"\n', { mode: 0o755 });
  const apply = path.join(local, 'owner-apply.py'), marker = path.join(root, 'applied');
  fs.writeFileSync(apply, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('owner only')\n`);
  const tools = Object.fromEntries(['flock', 'systemctl', 'sqlite3', 'loginctl', 'ss', 'tmux', 'git'].map(name => [name, '/bin/true']));
  Object.assign(tools, { node: process.execPath, python3: '/usr/bin/python3', bwrap });
  durableJson(path.join(local, 'owner-environment.json'), { release_id: bundle.manifest.release_id, home: root, user: 'fixture', PATH: '/fixed-owner-path', tools, apply_script_sha256: fileSha256(apply) });
  return { root, marker, apply };
}
it('check-only freezes the environment, requires a read-only root, runs real preflight arguments and never invokes apply', () => {
  const { root, marker } = fixture(); const before = fs.readdirSync(root, { recursive: true }).sort();
  const run = spawnSync('/usr/bin/python3', ['-I', script, '--receipt', root, '--check-only'], { env: { ...process.env, PATH: '/poisoned-caller', NODE_OPTIONS: '--require /untrusted.js' }, encoding: 'utf8' });
  expect(run.status).toBe(0); const output = JSON.parse(run.stdout);
  expect(output.path).toBe('/fixed-owner-path'); expect(output.node_options).toBe('');
  expect(output.argv).toContain('--ro-bind / /'); expect(output.argv).toContain(' preflight --release ');
  expect(output.argv).toContain('--prepared-config'); expect(output.argv).not.toContain(' apply ');
  expect(fs.existsSync(marker)).toBe(false); expect(fs.readdirSync(root, { recursive: true }).sort()).toEqual(before);
});
it('only explicit apply delegates to the hash-bound Owner draft after preflight', () => {
  const { root, marker } = fixture(); const run = spawnSync('/usr/bin/python3', ['-I', script, '--receipt', root, '--apply'], { encoding: 'utf8' });
  expect(run.status).toBe(0); expect(fs.readFileSync(marker, 'utf8')).toBe('owner only');
});
it('rejects a changed Owner apply draft without running it', () => {
  const { root, marker, apply } = fixture(); fs.appendFileSync(apply, '# drift\n');
  const run = spawnSync('/usr/bin/python3', ['-I', script, '--receipt', root, '--apply'], { encoding: 'utf8' });
  expect(run.status).not.toBe(0); expect(run.stderr).toContain('Owner apply draft changed'); expect(fs.existsSync(marker)).toBe(false);
});

it('rejects drift of payload code before executing it or delegating to apply', () => {
  const { root, marker } = fixture();
  const build = JSON.parse(fs.readFileSync(path.join(root, 'build-result.json')));
  fs.writeFileSync(path.join(build.bundle, 'payload/scripts/ao-release-entry.js'), 'process.exit(0)');
  const result = spawnSync('/usr/bin/python3', ['-I', script, '--receipt', root, '--apply'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('Release payload drift'); expect(fs.existsSync(marker)).toBe(false);
});
it('rejects a manifest change even when package and envelope bytes are unchanged', () => {
  const { root, marker } = fixture(); const build = JSON.parse(fs.readFileSync(path.join(root, 'build-result.json')));
  fs.appendFileSync(path.join(build.bundle, 'payload/release.json'), ' ');
  const result = spawnSync('/usr/bin/python3', ['-I', script, '--receipt', root, '--apply'], { encoding: 'utf8' });
  expect(result.status).not.toBe(0); expect(result.stderr).toContain('Release manifest drift'); expect(fs.existsSync(marker)).toBe(false);
});
