import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { verifySchemaCompatibility, assertOwnedHealth } from '../../scripts/verify-schema-compatibility.js';
import { fixtureRoot } from './release-fixture.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fixtureRoot(); roots.push(root);
  for (const name of ['old', 'candidate', 'fixture']) fs.writeFileSync(path.join(root, name), name);
  const options = { candidateBinary: path.join(root, 'candidate'), oldBinary: path.join(root, 'old'), fixtureDatabase: path.join(root, 'fixture'), expectedSchema: 43, output: path.join(root, 'report.json') };
  const inspect = (file) => ({ schema: file === options.fixtureDatabase ? 42 : 43, integrity: 'ok', foreign_keys: '', session_count: 0, worktree_count: 0, project_count: 0, projects: [], schema_sha256: 'f'.repeat(64) });
  return { root, options, inspect };
}
function scratchProject(data) {
  return { id: 'scratch', path: path.join(data, 'scratch/default'), repo_origin_url: '', display_name: 'Scratch',
    registered_at: new Date().toISOString(), archived_at: null, kind: 'scratch', config: JSON.stringify({
      agentConfig: {}, worker: { agent: 'claude-code', agentConfig: {} }, orchestrator: { agent: 'claude-code', agentConfig: {} }, trackerIntake: {},
    }) };
}
function seededFixture({ candidateRows = (rows) => rows, oldRows = (rows) => rows } = {}) {
  const base = fixture(); const snapshots = new Map(); const calls = [];
  const inspect = (file) => {
    const original = base.inspect(file);
    if (file === base.options.fixtureDatabase) return original;
    const projects = snapshots.get(file);
    return { ...original, project_count: projects?.length, projects };
  };
  let seeded;
  const probe = async (binary, data) => {
    calls.push(binary);
    const projects = binary === base.options.candidateBinary
      ? (seeded = candidateRows([scratchProject(data)])) : oldRows(structuredClone(seeded));
    snapshots.set(path.join(data, 'ao.db'), projects);
  };
  return { ...base, inspect, probe, calls };
}
it('probes both exact artifacts on separate temporary fixture copies, never the input database', async () => {
  const { options, inspect } = fixture(); const calls = [];
  const result = await verifySchemaCompatibility(options, { inspect, probe: async (binary, data) => { calls.push(binary); expect(data).not.toContain(path.dirname(options.fixtureDatabase)); expect(fs.readFileSync(path.join(data, 'ao.db'), 'utf8')).toBe('fixture'); } });
  expect(calls).toEqual([options.candidateBinary, options.oldBinary]); expect(result).toMatchObject({ candidate_result: 'passed', old_reader_result: 'passed', schema_before: 42, schema_after: 43 });
});
it('records actual old-reader failure as incompatible rather than trusting supplied labels', async () => {
  const { options, inspect } = fixture();
  const result = await verifySchemaCompatibility(options, { inspect, probe: async (binary) => { if (binary === options.oldBinary) throw Error('cannot read schema'); } });
  expect(result.old_reader_result).toBe('failed');
});
it('rejects nonempty fixtures before any binary can run', async () => {
  const { options, inspect } = fixture(); let calls = 0;
  await expect(verifySchemaCompatibility(options, { inspect: (file) => ({ ...inspect(file), project_count: 1 }), probe: async () => { calls += 1; } })).rejects.toMatchObject({ code: 'compatibility_fixture_not_empty' });
  expect(calls).toBe(0); expect(fs.existsSync(options.output)).toBe(false);
});
it('rejects candidate corruption and artifact replacement during the probe', async () => {
  const { options, inspect } = fixture();
  await expect(verifySchemaCompatibility(options, { inspect: (file) => ({ ...inspect(file), integrity: file === options.fixtureDatabase ? 'ok' : 'corrupt' }), probe: async () => {} })).rejects.toMatchObject({ code: 'compatibility_candidate_failed' });
  await expect(verifySchemaCompatibility(options, { inspect, probe: async () => { fs.writeFileSync(options.oldBinary, 'replaced'); } })).rejects.toMatchObject({ code: 'compatibility_input_changed' });
});
it('never suppresses an unknown process exit when probing the old reader', async () => {
  const { options, inspect } = fixture();
  await expect(verifySchemaCompatibility(options, { inspect, probe: async (binary) => { if (binary === options.oldBinary) throw Object.assign(Error('cannot prove exit'), { code: 'compatibility_process_exit_unknown' }); } })).rejects.toMatchObject({ code: 'compatibility_process_exit_unknown' });
});

it('binds real health DTO to the owned PID and service rather than a different listener on the chosen port', () => {
  expect(() => assertOwnedHealth({ status: 'ok', service: 'agent-orchestrator-daemon', pid: 123 }, 123)).not.toThrow();
  for (const payload of [{ status: 'ok', service: 'agent-orchestrator-daemon', pid: 999 }, { status: 'ok', service: 'other', pid: 123 }, { status: 'ok' }]) {
    expect(() => assertOwnedHealth(payload, 123)).toThrow('compatibility_process_unknown');
  }
});

it('accepts only the default scratch seeded in the private candidate data directory and preserved by the old reader', async () => {
  const { options, inspect, probe, calls } = seededFixture();
  const result = await verifySchemaCompatibility(options, { inspect, probe });
  expect(result).toMatchObject({ candidate_result: 'passed', old_reader_result: 'passed' });
  expect(calls).toEqual([options.candidateBinary, options.oldBinary]);
});

it.each([
  ['id', 'business'], ['kind', 'workspace'], ['path', '/outside/scratch/default'], ['repo_origin_url', 'https://example.invalid/repo'],
  ['display_name', 'Business'], ['archived_at', '2026-01-01T00:00:00Z'], ['registered_at', 'invalid'],
  ['registered_at', '2000-01-01T00:00:00Z'], ['registered_at', '2999-01-01T00:00:00Z'],
  ['config', '{"postCreate":["unreviewed"]}'], ['config', 'invalid'],
  ['config', 'null'], ['unexpected_column', 'unreviewed'],
])('rejects a candidate scratch with unexpected %s=%s before probing the old reader', async (field, value) => {
  const { options, inspect, probe, calls } = seededFixture({ candidateRows: ([row]) => [{ ...row, [field]: value }] });
  await expect(verifySchemaCompatibility(options, { inspect, probe })).rejects.toMatchObject({ code: 'compatibility_candidate_failed' });
  expect(calls).toEqual([options.candidateBinary]);
  expect(fs.existsSync(options.output)).toBe(false);
});

it('rejects additional projects and missing project evidence rather than relaxing the count check', async () => {
  for (const candidateRows of [(rows) => [...rows, { ...rows[0], id: 'extra' }], () => undefined]) {
    const { options, inspect, probe } = seededFixture({ candidateRows });
    await expect(verifySchemaCompatibility(options, { inspect, probe })).rejects.toMatchObject({ code: 'compatibility_candidate_failed' });
  }
});

it('keeps a pre-seeded input fixture forbidden even when its only project resembles the default scratch', async () => {
  const { options, inspect, probe, calls } = seededFixture();
  await expect(verifySchemaCompatibility(options, { probe, inspect: (file) => file === options.fixtureDatabase
    ? { ...inspect(file), project_count: 1, projects: [scratchProject('/fixture')] } : inspect(file) }))
    .rejects.toMatchObject({ code: 'compatibility_fixture_not_empty' });
  expect(calls).toHaveLength(0);
});

it.each([
  ['removed', () => []], ['renamed', ([row]) => [{ ...row, id: 'changed' }]],
  ['relocated', ([row]) => [{ ...row, path: '/old/own/scratch/default' }]],
  ['reconfigured', ([row]) => [{ ...row, config: '{}' }]],
  ['retimestamped', ([row]) => [{ ...row, registered_at: '2000-01-01T00:00:00Z' }]],
  ['extra', (rows) => [...rows, { ...rows[0], id: 'extra' }]], ['unknown', () => undefined],
])('marks the old reader incompatible when it leaves the validated seed %s', async (_name, oldRows) => {
  const { options, inspect, probe } = seededFixture({ oldRows });
  const result = await verifySchemaCompatibility(options, { inspect, probe });
  expect(result.old_reader_result).toBe('failed');
});

it.each(['session_count', 'worktree_count'])('still rejects nonzero %s after candidate boot', async (field) => {
  const { options, inspect, probe } = seededFixture();
  await expect(verifySchemaCompatibility(options, { probe, inspect: (file) => ({ ...inspect(file),
    [field]: file === options.fixtureDatabase ? 0 : 1 }) })).rejects.toMatchObject({ code: 'compatibility_candidate_failed' });
});

it.each([
  ['schema', 999], ['schema_sha256', 'e'.repeat(64)], ['integrity', 'corrupt'],
  ['foreign_keys', 'violation'], ['session_count', 1], ['worktree_count', 1],
])('does not let a preserved scratch bypass the old reader %s check', async (field, value) => {
  const { options, inspect, probe } = seededFixture();
  const result = await verifySchemaCompatibility(options, { probe, inspect: (file) => file.includes(`${path.sep}old${path.sep}`)
    ? { ...inspect(file), [field]: value } : inspect(file) });
  expect(result.old_reader_result).toBe('failed');
});
