import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from '@jest/globals';
import { verifySchemaCompatibility } from '../../scripts/verify-schema-compatibility.js';
import { fixtureRoot } from './release-fixture.js';
const roots = [];
afterEach(() => { roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })); });
function fixture() {
  const root = fixtureRoot(); roots.push(root);
  for (const name of ['old', 'candidate', 'fixture']) fs.writeFileSync(path.join(root, name), name);
  const options = { candidateBinary: path.join(root, 'candidate'), oldBinary: path.join(root, 'old'), fixtureDatabase: path.join(root, 'fixture'), expectedSchema: 43, output: path.join(root, 'report.json') };
  const inspect = (file) => ({ schema: file === options.fixtureDatabase ? 42 : 43, integrity: 'ok', foreign_keys: '', session_count: 0, worktree_count: 0, project_count: 0, schema_sha256: 'f'.repeat(64) });
  return { root, options, inspect };
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
