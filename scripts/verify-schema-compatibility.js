#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertRelease, durableJson, fileSha256, objectSha256 } from './ao/lib/release-manifest.js';
import { processStartToken } from './ao/lib/release-lock.js';

function sql(database, statement) {
  const result = spawnSync('sqlite3', ['-readonly', database, statement], { encoding: 'utf8', timeout: 10000 });
  assertRelease(!result.error && result.status === 0, 'compatibility_database_unknown'); return result.stdout.trim();
}
function databaseEvidence(database) {
  return { schema: Number(sql(database, 'SELECT MAX(version_id) FROM goose_db_version WHERE is_applied=1;')),
    integrity: sql(database, 'PRAGMA integrity_check;'), foreign_keys: sql(database, 'PRAGMA foreign_key_check;'),
    session_count: Number(sql(database, 'SELECT count(*) FROM sessions;')), project_count: Number(sql(database, 'SELECT count(*) FROM projects;')),
    worktree_count: Number(sql(database, 'SELECT count(*) FROM session_worktrees;')),
    schema_sha256: objectSha256(sql(database, "SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name;")) };
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port;
}
async function probeBinary(binary, data, root) {
  const port = await freePort(); const home = path.join(root, 'home'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const discovery = path.join(root, 'discovery'); fs.mkdirSync(discovery, { mode: 0o700 });
  const log = fs.openSync(path.join(root, 'private-daemon.log'), 'wx', 0o600);
  const namespace = `ao-pilot-staging-schema-${path.basename(root).replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const environment = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    AO_DATA_DIR: data, AO_RUN_FILE: path.join(discovery, 'running.json'), AO_HOST: '127.0.0.1', AO_PORT: String(port), AO_NETWORK_DISABLED: '1',
    AO_TMUX_SOCKET: namespace, AO_TMUX_UNIT: `${namespace}-tmux.service`, AO_TMUX_TMPDIR: path.join(root, 'tmux'), TMUX_TMPDIR: path.join(root, 'tmux') };
  const child = spawn(binary, ['daemon'], { env: environment, cwd: root, stdio: ['ignore', log, log] });
  let exited = false; let spawnError = null;
  child.once('exit', () => { exited = true; }); child.once('error', (error) => { spawnError = error; exited = true; });
  let token = null;
  try {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !exited) {
      if (Number.isSafeInteger(child.pid)) { try { token ??= processStartToken(child.pid); } catch { /* wait for owned spawn */ } }
      try {
        const health = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(250) });
        const response = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`, { signal: AbortSignal.timeout(250) });
        if (health.ok && response.ok) {
          const sessions = (await response.json()).sessions;
          assertRelease(Array.isArray(sessions) && sessions.length === 0, 'compatibility_fixture_not_empty');
          assertRelease(token && processStartToken(child.pid) === token && !exited
            && fileSha256(`/proc/${child.pid}/exe`) === fileSha256(binary), 'compatibility_process_unknown');
          return { opened: true, queries: true };
        }
      } catch (error) { if (error.code?.startsWith('compatibility_')) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw Object.assign(new Error(spawnError ? 'Owned candidate failed to start' : 'Owned candidate failed to answer isolated queries'), { code: 'compatibility_reader_failed' });
  } finally {
    if (!exited && child.pid && token && processStartToken(child.pid) === token) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      if (!exited && processStartToken(child.pid) === token) { child.kill('SIGKILL'); await new Promise((resolve) => child.once('exit', resolve)); }
    }
    fs.closeSync(log);
    assertRelease(exited, 'compatibility_process_exit_unknown');
  }
}
export async function verifySchemaCompatibility({ candidateBinary, oldBinary, fixtureDatabase, expectedSchema, output }, { probe = probeBinary, inspect = databaseEvidence } = {}) {
  assertRelease(process.platform === 'linux', 'release_platform_unsupported');
  const candidateSha = fileSha256(candidateBinary); const oldSha = fileSha256(oldBinary); const fixtureSha = fileSha256(fixtureDatabase);
  const fixture = inspect(fixtureDatabase);
  assertRelease(fixture.session_count === 0 && fixture.project_count === 0 && fixture.worktree_count === 0 && fixture.integrity === 'ok' && fixture.foreign_keys === '', 'compatibility_fixture_not_empty');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-schema-compatibility-'));
  try {
    const candidateRoot = path.join(root, 'candidate'); const candidateData = path.join(candidateRoot, 'data'); fs.mkdirSync(candidateData, { recursive: true, mode: 0o700 });
    fs.copyFileSync(fixtureDatabase, path.join(candidateData, 'ao.db'));
    await probe(candidateBinary, candidateData, candidateRoot);
    const candidate = inspect(path.join(candidateData, 'ao.db'));
    assertRelease(candidate.schema === expectedSchema && candidate.integrity === 'ok' && candidate.foreign_keys === ''
      && candidate.session_count === 0 && candidate.project_count === 0 && candidate.worktree_count === 0, 'compatibility_candidate_failed');
    const oldRoot = path.join(root, 'old'); const oldData = path.join(oldRoot, 'data'); fs.mkdirSync(oldData, { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(candidateData, 'ao.db'), path.join(oldData, 'ao.db'));
    let oldResult = 'failed';
    try {
      await probe(oldBinary, oldData, oldRoot); const old = inspect(path.join(oldData, 'ao.db'));
      if (old.schema === expectedSchema && old.schema_sha256 === candidate.schema_sha256 && old.integrity === 'ok'
        && old.foreign_keys === '' && old.session_count === 0 && old.project_count === 0 && old.worktree_count === 0) oldResult = 'passed';
    } catch (error) { if (error.code === 'compatibility_process_exit_unknown') throw error; }
    assertRelease(fileSha256(candidateBinary) === candidateSha && fileSha256(oldBinary) === oldSha && fileSha256(fixtureDatabase) === fixtureSha, 'compatibility_input_changed');
    const report = { schema_version: 'ao.schema-compatibility-result.v1', candidate_binary_sha256: candidateSha,
      old_binary_sha256: oldSha, fixture_sha256: fixtureSha, schema_before: fixture.schema, schema_after: candidate.schema,
      candidate_result: 'passed', old_reader_result: oldResult, integrity: 'ok', schema_sha256: candidate.schema_sha256 };
    durableJson(output, report); return report;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2); const value = (key) => args[args.indexOf(key) + 1];
  try {
    await verifySchemaCompatibility({ candidateBinary: value('--candidate'), oldBinary: value('--old'), fixtureDatabase: value('--fixture'), expectedSchema: Number(value('--schema')), output: value('--output') });
    process.stdout.write('schema compatibility checked on isolated empty fixture copies\n');
  } catch (error) { process.stderr.write(`${error.code ?? 'schema_compatibility_failed'}\n`); process.exitCode = 2; }
}
