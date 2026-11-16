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
it.each(['send', 'ack', 'message'])('root %s delegates raw arguments before project config loading', async (command) => {
  let forwarded;
  const args = command === 'send' ? ['--session', 'native-original', '--message', 'text', '--json'] : command === 'message' ? ['show', 'original-id', '--session', 'native-original', '--json'] : ['original-id', '--json'];
  const result = await rootCli([command, ...args], { writeStdout: () => {}, writeStderr: () => {} }, { cwd: '/nonexistent-project', nativeMessages: async (argv) => { forwarded = argv; return { exitCode: 5 }; } });
  expect(forwarded).toEqual([command, ...args]); expect(result.exitCode).toBe(5);
});

it.each(['show', 'watch'])('proxies read-only message %s with explicit capability and no send/ack fallback', (subcommand) => {
  const runtime = fixture(); const calls = [];
  const result = runNativeMessage('message', [subcommand, 'original-id', '--session', 'native-original', '--json'], {
    resolve: () => runtime,
    run: (_binary, args, options) => {
      calls.push({ args, timeout: options.timeout });
      return args[0] === 'message-contract'
        ? { status: 0, stdout: JSON.stringify({ ...capability, read_status: true, status_schema_version: 'ao.message-status.v1' }) }
        : { status: 0, stdout: '{"outcome":"ack_timeout"}\n' };
    },
  });
  expect(result.stdout).toContain('ack_timeout');
  expect(calls.map((x) => x.args[0])).toEqual(['message-contract', 'message']);
  expect(calls[1].args).toEqual(['message', subcommand, 'original-id', '--session', 'native-original', '--json']);
  expect(calls[1].timeout).toBe(subcommand === 'watch' ? 920000 : 20000);
});

it('refuses inspection on an old status capability without a command fallback', () => {
  const runtime = fixture(); const calls = [];
  expect(() => runNativeMessage('message', ['show', 'original-id', '--session', 'native-original'], {
    resolve: () => runtime, run: (_binary, args) => { calls.push(args); return { status: 0, stdout: JSON.stringify(capability) }; },
  })).toThrow('message_status_unavailable');
  expect(calls).toEqual([['message-contract', '--json']]);
});

it.each(['send', 'ack', 'restore'])('refuses message %s before runtime discovery', (subcommand) => {
  let called = false;
  expect(() => runNativeMessage('message', [subcommand], { resolve: () => { called = true; } })).toThrow('invalid_message_command');
  expect(called).toBe(false);
});

it('reports invalid inspection subcommands as usage errors without runtime discovery', async () => {
  let called = false;
  const result = await runCli(['message', 'send'], { writeStdout: () => {}, writeStderr: () => {} }, {
    resolve: () => { called = true; },
  });
  expect(result.exitCode).toBe(2); expect(called).toBe(false);
});

it('streams watch snapshots before the native child exits', async () => {
  const runtime = fixture(); const release = path.join(path.dirname(runtime.binary), 'release');
  const supported = { ...capability, read_status: true, status_schema_version: 'ao.message-status.v1' };
  const source = `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'message-contract') {
  process.stdout.write(${JSON.stringify(JSON.stringify(supported))});
} else if (process.argv[2] === 'message' && process.argv[3] === 'watch') {
  process.stdout.write('{"outcome":"ack_timeout"}\\n');
  const deadline = setTimeout(() => process.exit(1), 2000);
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(release)})) {
      clearInterval(poll); clearTimeout(deadline);
      process.stdout.write('{"outcome":"acknowledged"}\\n', () => process.exit(0));
    }
  }, 10);
} else { process.exit(2); }
`;
  fs.writeFileSync(runtime.binary, source, { mode: 0o700 });
  runtime.sha256 = createHash('sha256').update(fs.readFileSync(runtime.binary)).digest('hex');
  const output = []; let finished = false; let first;
  const firstSnapshot = new Promise((resolve) => { first = resolve; });
  const result = runCli(['message', 'watch', 'original-id', '--session', 'native-original', '--json'], {
    writeStdout: (text) => { output.push(text); if (text.includes('ack_timeout')) first(); },
    writeStderr: () => {},
  }, { resolve: () => runtime }).then((value) => { finished = true; return value; });
  try {
    await Promise.race([firstSnapshot, result.then(() => { throw new Error('watch exited before a live snapshot'); })]);
    expect(finished).toBe(false);
    expect(output.join('')).not.toContain('acknowledged');
  } finally { fs.writeFileSync(release, 'release fixture child'); }
  expect((await result).exitCode).toBe(0);
  expect(output.join('')).toBe('{"outcome":"ack_timeout"}\n{"outcome":"acknowledged"}\n');
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
