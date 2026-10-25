import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createTerminalAuth, loadTerminalAuth } from '../auth.mjs';
import { createAdapter } from '../server.mjs';

const token = 'a'.repeat(64); const origin = 'http://127.0.0.1:43210';
function capability(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-terminal-auth-'));
  const file = path.join(root, 'token'); fs.writeFileSync(file, token, { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return { root, file };
}
test('requires a private owned capability and preserves explicit credential precedence', t => {
  const { root, file } = capability(t);
  assert.throws(() => createTerminalAuth(undefined, origin, true), /required/);
  const auth = createTerminalAuth(file, origin, true);
  for (const headers of [{ authorization: `Bearer ${token}` }, { authorization: `Basic ${Buffer.from('ao:'+token).toString('base64')}` }, { cookie: `ao_terminal=${token}` }]) {
    assert.equal(auth.authenticate({ headers }), true);
  }
  for (const headers of [{}, { authorization: 'Bearer invalid' }, { authorization: 'Bearer invalid', cookie: `ao_terminal=${token}` }, { cookie: `ao_terminal=${token}; ao_terminal=${token}` }, { authorization: `Basic ${Buffer.from('other:'+token).toString('base64')}` }]) {
    assert.equal(auth.authenticate({ headers }), false);
  }
  assert.match(auth.cookie, /HttpOnly; SameSite=Strict/);
  assert.equal(auth.originAllowed({ headers: { origin } }), true);
  assert.equal(auth.originAllowed({ headers: { origin: 'http://invalid.example' } }), false);
  fs.chmodSync(file, 0o644); assert.throws(() => createTerminalAuth(file, origin), /Unsafe/); fs.chmodSync(file, 0o600);
  const linked = path.join(root, 'link'); fs.symlinkSync(file, linked); assert.throws(() => createTerminalAuth(linked, origin));
  const hard = path.join(root, 'hard'); fs.linkSync(file, hard); assert.throws(() => createTerminalAuth(file, origin), /Unsafe/);
});
test('uses only the existing private adapter-config pointer for managed terminal credentials', t => {
  const { root, file } = capability(t); const config = path.join(root, 'adapter.json');
  fs.writeFileSync(config, JSON.stringify({ TERMINAL_TOKEN_FILE: file, TERMINAL_ORIGIN: origin }), { mode: 0o600 });
  assert.equal(loadTerminalAuth(config, true).authenticate({ headers: { authorization: `Bearer ${token}` } }), true);
  assert.throws(() => loadTerminalAuth(undefined, true), /required/);
  fs.chmodSync(config, 0o644); assert.throws(() => loadTerminalAuth(config, true), /Unsafe/);
});
async function listen(t, server) {
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ao-terminal-ws?session=worker-1', headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.alloc(16, 1).toString('base64'), ...headers,
    } });
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('upgrade', (res, socket, head) => {
      const finish = bytes => { socket.destroy(); resolve({ status: res.statusCode, bytes: bytes.toString() }); };
      if (head.length) finish(head); else socket.once('data', finish);
    });
    req.on('error', reject); req.setTimeout(3000, () => req.destroy(Error('upgrade timeout'))); req.end();
  });
}
test('managed adapter denies missing/invalid credentials and original bad Origin before proxying', { timeout: 10000 }, async t => {
  const { file } = capability(t); let upgrades = 0;
  const upstream = http.createServer((_req, res) => { res.end('dashboard'); });
  upstream.on('upgrade', (req, socket) => {
    upgrades += 1;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.concat([Buffer.from([0x81, 8]), Buffer.from('canary:1')]));
  });
  const upstreamPort = await listen(t, upstream);
  const adapterPort = await listen(t, createAdapter({ listenHost: '127.0.0.1', port: 0, dashboardHost: '127.0.0.1', dashboardPort: upstreamPort,
    daemonHost: '127.0.0.1', daemonPort: upstreamPort, directTerminalHost: '127.0.0.1', directTerminalPort: upstreamPort,
    browserTerminalPort: upstreamPort, terminalOrigin: origin, terminalTokenFile: file }));
  const base = `http://127.0.0.1:${adapterPort}`;
  assert.equal((await fetch(base)).status, 401);
  const login = await fetch(base, { headers: { authorization: 'Basic '+Buffer.from('ao:'+token).toString('base64') } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(base, { headers: { cookie: `ao_terminal=${token}` } })).status, 200);
  assert.equal((await upgrade(adapterPort, { origin })).status, 401);
  assert.equal((await upgrade(adapterPort, { origin, authorization: 'Bearer invalid' })).status, 401);
  assert.equal((await upgrade(adapterPort, { origin: 'http://invalid.example', authorization: `Bearer ${token}` })).status, 403);
  assert.equal(upgrades, 0);
  const valid = await upgrade(adapterPort, { origin, authorization: `Bearer ${token}` });
  assert.equal(valid.status, 101); assert.match(valid.bytes, /canary:1/);
  assert.equal((await upgrade(adapterPort, { origin, cookie: `ao_terminal=${token}` })).status, 101);
  assert.equal(upgrades, 2);
});
