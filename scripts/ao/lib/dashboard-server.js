import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const assets = new Map([
  ['/', ['../../../dashboard/index.html', 'text/html']],
  ['/app.js', ['../../../dashboard/app.js', 'text/javascript']],
  ['/style.css', ['../../../dashboard/style.css', 'text/css']],
  ['/vendor/xterm.js', [require.resolve('@xterm/xterm'), 'text/javascript']],
  ['/vendor/xterm.css', [require.resolve('@xterm/xterm/css/xterm.css'), 'text/css']],
  ['/vendor/fit.js', [require.resolve('@xterm/addon-fit'), 'text/javascript']],
]);

export function validHost(host, port) {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}
export function allowedApi(method, pathname) {
  if (pathname.includes('..')) return false;
  if (method === 'GET') return /^\/api\/v1\/(projects|sessions)(\/[A-Za-z0-9._-]+)?$/.test(pathname);
  return method === 'POST' && /^\/api\/v1\/sessions\/[A-Za-z0-9._-]+\/(restore|resume-agent|send)$/.test(pathname);
}

export function createDashboardServer({ runtimePort = 3001 } = {}) {
  if (!Number.isInteger(runtimePort) || runtimePort < 1 || runtimePort > 65535) throw new Error('Invalid runtime port');
  const sockets = new Set();
  const reject = (res, code, message) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message }));
  };
  const server = http.createServer((req, res) => {
    const port = server.address()?.port;
    if (!validHost(req.headers.host, port)) return reject(res, 403, 'Localhost Host required');
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return reject(res, 403, 'Same origin required');
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (pathname.startsWith('/api/')) {
      if (!allowedApi(req.method, pathname)) return reject(res, 404, 'Unsupported Dashboard API');
      if (req.method !== 'GET' && req.headers['x-ao-dashboard'] !== '1') return reject(res, 403, 'Dashboard request header required');
      const upstream = http.request({ host: '127.0.0.1', port: runtimePort, path: req.url, method: req.method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 10000 }, incoming => {
        res.writeHead(incoming.statusCode, { 'Content-Type': 'application/json' });
        incoming.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Runtime timeout')));
      upstream.on('error', () => { if (!res.headersSent) reject(res, 502, 'AO runtime unavailable'); else res.destroy(); });
      let bytes = 0, tooLarge = false;
      req.on('data', chunk => { if (tooLarge) return; bytes += chunk.length; if (bytes > 65536) { tooLarge = true; reject(res, 413, 'Request too large'); upstream.destroy(); } else upstream.write(chunk); });
      req.on('end', () => upstream.end());
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reject(res, 405, 'GET required');
    const asset = assets.get(pathname.startsWith('/sessions/') ? '/' : pathname);
    if (!asset) return reject(res, 404, 'Not found');
    try {
      const data = fs.readFileSync(fileURLToPath(new URL(asset[0], import.meta.url)));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { reject(res, 500, 'Dashboard asset unavailable'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/mux' || !validHost(req.headers.host, server.address()?.port) ||
        req.headers.origin !== `http://${req.headers.host}`) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = http.request({ host: '127.0.0.1', port: runtimePort, path: '/mux', headers: {
      host: `127.0.0.1:${runtimePort}`, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-key': req.headers['sec-websocket-key'], 'sec-websocket-version': '13',
    } });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key,value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.setTimeout(10000, () => upstream.destroy());
    upstream.end();
  });
  server.shutdown = () => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); };
  return server;
}
