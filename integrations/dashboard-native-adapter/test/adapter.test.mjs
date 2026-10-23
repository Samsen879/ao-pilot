import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createAdapter } from '../server.mjs';
import { loadConfig } from '../config.mjs';

const host = '127.0.0.1'; // Only isolated test listeners; production has no endpoint defaults.
function input(daemonPort = 1, dashboardPort = 1, directPort = 1) {
  return {
    LISTEN_HOST: host, LISTEN_PORT: '0',
    AO_DAEMON_HOST: host, AO_DAEMON_PORT: String(daemonPort),
    DASHBOARD_UPSTREAM_HOST: host, DASHBOARD_UPSTREAM_PORT: String(dashboardPort),
    DIRECT_TERMINAL_HOST: host, DIRECT_TERMINAL_PORT: String(directPort),
    DIRECT_TERMINAL_BROWSER_PORT: '45678', TERMINAL_ORIGIN: 'http://localhost:8080',
    PROJECT_NAME: 'Test project', ISSUE_BASE_URL: 'https://example.com/issues',
  };
}
async function listen(t, server) {
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}
const session = {
  id: 'worker-1', projectId: 'example', status: 'working', kind: 'worker', issueId: '42',
  terminalHandleId: 'terminal-1', activity: { state: 'active' }, createdAt: '2026-01-01T00:00:00Z',
};
async function fixture(t) {
  const requests = [];
  const daemon = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/v1/sessions'
      ? { sessions: [session, { ...session, id: 'old', isTerminated: true },
        { ...session, id: 'orchestrator', kind: 'orchestrator' }] }
      : { session: req.url.endsWith('/old') ? { ...session, isTerminated: true } : session }));
  });
  const dashboard = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.setHeader('etag', 'stale');
    res.end('<html><head></head><body>Mock Dashboard</body></html>');
  });
  const daemonPort = await listen(t, daemon);
  const dashboardPort = await listen(t, dashboard);
  const env = input(daemonPort, dashboardPort);
  const adapter = createAdapter(loadConfig(env));
  const port = await listen(t, adapter);
  return { base: `http://${host}:${port}`, env, requests };
}

test('configuration requires explicit endpoints and validates ports/origins', () => {
  assert.throws(() => loadConfig({}), /LISTEN_HOST/);
  for (const [key, value] of [ ['AO_DAEMON_PORT', '0'], ['LISTEN_PORT', '65536'],
    ['DIRECT_TERMINAL_PORT', 'garbage'], ['AO_DAEMON_HOST', 'http://invalid'],
    ['TERMINAL_ORIGIN', 'http://user:secret@example.com'], ['ISSUE_BASE_URL', 'javascript:alert(1)'] ]) {
    assert.throws(() => loadConfig({ ...input(), [key]: value }));
  }
});

test('JSON configuration and environment overrides need no npm dependencies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adapter-config-'));
  try {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify(input()));
    assert.equal(loadConfig({ AO_DASHBOARD_ADAPTER_CONFIG: path, PROJECT_NAME: 'Override' }).projectName, 'Override');
    writeFileSync(path, JSON.stringify({ ...input(), UNEXPECTED: 'value' }));
    assert.throws(() => loadConfig({ AO_DASHBOARD_ADAPTER_CONFIG: path }), /configuration keys/);
  } finally { rmSync(dir, { recursive: true }); }
});

test('real CLI starts on an ephemeral port and connects to a mock daemon', { timeout: 10000 }, async t => {
  const { env, requests } = await fixture(t);
  const child = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  });
  let output = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', data => {
      output += data;
      const match = /listening on port (\d+)/.exec(output);
      if (match) resolve(Number(match[1]));
    });
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`CLI exited: ${code}`)));
  });
  const response = await fetch(`http://${host}:${port}/api/sessions`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessions[0].id, session.id);
  assert.ok(requests.includes('/api/v1/sessions'));
});

test('native list/detail mapping, project filtering, and read-only API remain intact', { timeout: 10000 }, async t => {
  const { base, requests } = await fixture(t);
  const data = await (await fetch(`${base}/api/sessions?project=example`)).json();
  assert.deepEqual(data.sessions.map(s => s.id), ['worker-1']);
  assert.equal(data.sessions[0].issueUrl, 'https://example.com/issues/42');
  assert.equal(data.orchestrators[0].projectName, 'Test project');
  assert.equal(data.stats.workingSessions, 1);
  assert.equal((await (await fetch(`${base}/api/sessions?project=other`)).json()).sessions.length, 0);
  assert.equal((await fetch(`${base}/api/sessions/worker-1`)).status, 200);
  assert.equal((await fetch(`${base}/api/sessions/old`)).status, 404);
  const before = requests.length;
  assert.equal((await fetch(`${base}/api/sessions`, { method: 'POST' })).status, 403);
  assert.equal(requests.length, before);
  assert.equal((await fetch(`${base}/api/sessions/worker-1/unsupported`)).status, 404);
});

test('HTML proxy injects a shim using the configured browser terminal port', { timeout: 10000 }, async t => {
  const { base } = await fixture(t);
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.headers.get('etag'), null);
  assert.ok(html.includes('Mock Dashboard'));
  const urls = [];
  const window = {
    WebSocket: class { constructor(url) { urls.push(String(url)); } },
    location: { href: 'https://example.com/', hostname: 'example.com', host: 'example.com', port: '', protocol: 'https:' },
  };
  runInNewContext(/<script>(.*?)<\/script>/.exec(html)[1], { window, URL });
  new window.WebSocket('ws://example.com:45678/ws?session=worker-1');
  assert.equal(urls[0], 'wss://example.com/ao-terminal-ws?session=worker-1');
});

test('SSE emits a native snapshot', { timeout: 10000 }, async t => {
  const { base } = await fixture(t);
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, { signal: controller.signal });
  try {
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const { value } = await response.body.getReader().read();
    assert.match(new TextDecoder().decode(value), /"type":"snapshot"/);
  } finally { controller.abort(); }
});

test('real WebSocket handshake and bidirectional frames proxy to the mock terminal', { timeout: 10000 }, async t => {
  let upgraded;
  const terminal = http.createServer();
  terminal.on('upgrade', (req, socket, head) => {
    upgraded = { url: req.url, origin: req.headers.origin, protocol: req.headers['sec-websocket-protocol'] };
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: test-echo\r\n\r\n`);
    let buffer = head;
    const consume = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 6) {
        const length = buffer[1] & 127;
        assert.ok(length < 126, 'test frames are deliberately short');
        if (buffer.length < 6 + length) return;
        const opcode = buffer[0] & 15;
        const payload = Buffer.from(buffer.subarray(6, 6 + length));
        for (let i = 0; i < length; i++) payload[i] ^= buffer[2 + i % 4];
        buffer = buffer.subarray(6 + length);
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
      }
    };
    socket.on('data', consume);
    consume(Buffer.alloc(0));
  });
  const terminalPort = await listen(t, terminal);
  const adapterPort = await listen(t, createAdapter(loadConfig(input(1, 1, terminalPort))));
  const ws = new WebSocket(`ws://${host}:${adapterPort}/ao-terminal-ws?session=worker-1`, ['test-echo']);
  t.after(() => ws.close());
  await once(ws, 'open');
  const echoed = once(ws, 'message');
  ws.send('mock-terminal-output');
  assert.equal((await echoed)[0].data, 'mock-terminal-output');
  assert.deepEqual(upgraded, { url: '/ws?session=worker-1', origin: 'http://localhost:8080', protocol: 'test-echo' });
  const closed = once(ws, 'close');
  ws.close();
  await closed;
});

test('mock daemon failure returns 502', { timeout: 10000 }, async t => {
  const daemon = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  const daemonPort = await listen(t, daemon);
  const port = await listen(t, createAdapter(loadConfig(input(daemonPort))));
  assert.equal((await fetch(`http://${host}:${port}/api/sessions`)).status, 502);
});
