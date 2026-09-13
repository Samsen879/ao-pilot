import { jest, test, expect, afterEach } from '@jest/globals';
import http from 'node:http';
import { createDashboardServer, validHost, allowedApi } from '../../scripts/ao/lib/dashboard-server.js';
let dashboard, backend;
afterEach(async () => { if (dashboard) await dashboard.shutdown(); if (backend) await new Promise(resolve => backend.close(resolve)); dashboard = backend = null; });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
test('closed localhost host and API boundaries', () => {
  expect(validHost('evil.example:3000', 3000)).toBe(false);
  expect(validHost('localhost:3000', 3000)).toBe(true);
  expect(allowedApi('GET', '/api/v1/sessions')).toBe(true);
  expect(allowedApi('POST', '/api/v1/sessions')).toBe(false);
  expect(allowedApi('GET', '/api/v1/sessions/id/workspace/file')).toBe(false);
});
test('serves packaged assets, rejects foreign origins, proxies native session read', async () => {
  backend = http.createServer((req,res) => res.end(JSON.stringify({ sessions: [{id:'native-1'}] })));
  const runtimePort = await listen(backend);
  dashboard = createDashboardServer({runtimePort}); const port = await listen(dashboard);
  const base = `http://127.0.0.1:${port}`;
  expect((await fetch(base)).status).toBe(200);
  expect((await fetch(`${base}/vendor/xterm.js`)).status).toBe(200);
  expect((await fetch(`${base}/api/v1/sessions`, {headers:{Origin:'https://evil.example'}})).status).toBe(403);
  const hostileHostStatus = await new Promise(resolve => http.get(`${base}/api/v1/sessions`, {headers:{Host:`evil.example:${port}`}}, res => { res.resume(); resolve(res.statusCode); }));
  expect(hostileHostStatus).toBe(403);
  expect((await (await fetch(`${base}/api/v1/sessions`)).json()).sessions[0].id).toBe('native-1');
  expect((await fetch(`${base}/api/v1/sessions/native-1/restore`, {method:'POST'})).status).toBe(403);
  expect((await fetch(`${base}/api/v1/sessions/native-1/restore`, {method:'POST',headers:{'X-AO-Dashboard':'1'}})).status).toBe(200);
});
test('unavailable daemon is explicit rather than indefinite connecting', async () => {
  dashboard = createDashboardServer({runtimePort:1}); const port = await listen(dashboard);
  expect((await fetch(`http://127.0.0.1:${port}/api/v1/sessions`)).status).toBe(502);
});
