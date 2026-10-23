import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from '@jest/globals';
import { runCli as rootCli } from '../../bin/ao-pilot.js';
import { runCli } from '../../scripts/ao-messages.js';
import { runNativeMessage } from '../../scripts/ao/lib/native-messages.js';
const roots = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
const capability = { schema_version: 'ao.message-contract.v1', authority: 'native', require_ack: true, default_ack_timeout_ms: 30000, max_ack_timeout_ms: 60000, send_timeout_ms: 90000,
  outcomes: ['submitted_confirmed', 'submitted_unconfirmed', 'rejected', 'acknowledged', 'ack_timeout'] };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-message-cli-')); roots.push(root);
  const binary = path.join(root, 'ao'); fs.writeFileSync(binary, 'fake native fixture only', { mode: 0o700 });
  return { binary, sha256: createHash('sha256').update(fs.readFileSync(binary)).digest('hex'), env: { AO_DATA_DIR: path.join(root, 'data'), AO_RUN_FILE: path.join(root, 'discovery/running.json'), AO_SESSION_ID: 'native-original' } };
}
it.each([0, 1, 2, 3, 4, 5])('preserves native stdout/stderr and exit %s after a read-only per-command handshake', async (exit) => {
  const runtime = fixture(); const calls = []; const output = []; const errors = [];
  const result = await runCli(['send', '--session', 'native-original', '--message', 'text', '--message-id', 'same-id', '--require-ack', '--json'], { writeStdout: (value) => output.push(value), writeStderr: (value) => errors.push(value) }, {
    resolve: () => runtime, run: (binary, args, options) => { calls.push({ binary, args, options }); return args[0] === 'message-contract' ? { status: 0, stdout: JSON.stringify(capability) } : { status: exit, stdout: 'exact stdout\n', stderr: 'exact stderr\n' }; },
  });
  expect(result.exitCode).toBe(exit); expect(output.join('')).toBe('exact stdout\n'); expect(errors.join('')).toBe('exact stderr\n');
  expect(calls.map((call) => call.args[0])).toEqual(['message-contract', 'send']); expect(calls[1].args).not.toContain('--project'); expect(calls[1].options.env).toEqual(runtime.env);
});
it.each([null, { ...capability, require_ack: false }, { ...capability, schema_version: 'unknown' }])('rejects old or unknown capability with zero mutation calls', (contract) => {
  const runtime = fixture(); const calls = [];
  expect(() => runNativeMessage('send', ['--session', 'native-original', '--message', 'do work', '--require-ack'], { resolve: () => runtime, run: (_binary, args) => { calls.push(args); return { status: contract ? 0 : 1, stdout: JSON.stringify(contract) }; } })).toThrow('message_contract_unavailable');
  expect(calls).toEqual([['message-contract', '--json']]);
});
it('never falls back or generates a new ID when a probed daemon changes to an older unsupported protocol', () => {
  const runtime = fixture(); const calls = [];
  const result = runNativeMessage('send', ['--session', 'native-original', '--message-id', 'same-id', '--require-ack'], { resolve: () => runtime, run: (_binary, args) => { calls.push(args); return args[0] === 'message-contract' ? { status: 0, stdout: JSON.stringify(capability) } : { status: 1, stderr: 'new /messages endpoint returned 404' }; } });
  expect(result.exitCode).toBe(1); expect(calls).toHaveLength(2); expect(calls[1]).toContain('same-id');
});
it('rejects binary replacement after handshake before mutation', () => {
  const runtime = fixture(); let mutations = 0;
  expect(() => runNativeMessage('ack', ['same-id'], { resolve: () => runtime, run: (_binary, args) => { if (args[0] !== 'message-contract') mutations += 1; fs.writeFileSync(runtime.binary, 'replaced'); return { status: 0, stdout: JSON.stringify(capability) }; } })).toThrow('message_binary_drift');
  expect(mutations).toBe(0);
});
it('rejects config/project daemon selectors before probing or mutation', async () => {
  let calls = 0;
  const result = await runCli(['send', '--config', '/unrelated/config'], { writeStdout: () => {}, writeStderr: () => {} }, { resolve: () => { calls += 1; } });
  expect(result.exitCode).toBe(2); expect(calls).toBe(0);
});
it.each(['send', 'ack'])('root %s delegates raw arguments before project config loading', async (command) => {
  let forwarded;
  const args = command === 'send' ? ['--session', 'native-original', '--message', 'text', '--json'] : ['original-id', '--json'];
  const result = await rootCli([command, ...args], { writeStdout: () => {}, writeStderr: () => {} }, { cwd: '/nonexistent-project', nativeMessages: async (argv) => { forwarded = argv; return { exitCode: 5 }; } });
  expect(forwarded).toEqual([command, ...args]); expect(result.exitCode).toBe(5);
});

it.each(['--project', '--help'])('forwards flag-looking message text %s as opaque content', async (message) => {
  const runtime = fixture(); const calls = [];
  const result = await runCli(['send', '--session', 'native-original', '--message', message], { writeStdout: () => {}, writeStderr: () => {} }, {
    resolve: () => runtime, run: (_binary, args) => { calls.push(args); return args[0] === 'message-contract' ? { status: 0, stdout: JSON.stringify(capability) } : { status: 3, stdout: '{}' }; },
  });
  expect(result.exitCode).toBe(3); expect(calls[1]).toEqual(['send', '--session', 'native-original', '--message', message]);
});
it('legacy session require_ack refuses before loading config, bindings, or a manager', async () => {
  const { runCli: legacyCli } = await import('../../scripts/ao-session.js'); const errors = [];
  const result = await legacyCli(['send', 'old-session', 'task', '--require-ack', '--config', '/nonexistent/no-side-effects.yaml'], { writeStdout: () => {}, writeStderr: (value) => errors.push(value) });
  expect(result.exitCode).not.toBe(0); expect(errors.join('')).toContain('Invalid option --require-ack');
});
