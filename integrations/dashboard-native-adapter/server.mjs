import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { createTerminalAuth } from './auth.mjs';

export function createAdapter(config) {
const {listenHost, port, dashboardHost, dashboardPort, daemonHost, daemonPort,
  directTerminalHost, directTerminalPort, browserTerminalPort, terminalOrigin,
  projectName, issueBaseUrl} = config;
const auth = createTerminalAuth(config.terminalTokenFile, terminalOrigin, Boolean(process.env.AO_RELEASE_ID));

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});
  res.end(body);
}

async function native(path) {
  const response = await fetch(`http://${daemonHost}:${daemonPort}${path}`, {signal:AbortSignal.timeout(4000)});
  if (!response.ok) throw new Error(`AO daemon returned ${response.status}`);
  return response.json();
}

function active(session) {
  return !session.isTerminated && session.status !== 'terminated';
}

function mapSession(session) {
  const issueId = session.issueId || null;
  return {
    id:session.id,
    projectId:session.projectId,
    status:session.isTerminated ? 'killed' : session.status === 'working' ? 'working' : 'working',
    activity:session.isTerminated ? 'exited' : session.activity?.state === 'active' ? 'active' : 'idle',
    branch:session.branch || null,
    issueId,
    issueUrl:issueId && issueBaseUrl ? `${issueBaseUrl}/${encodeURIComponent(issueId)}` : null,
    issueLabel:issueId ? `#${issueId}` : null,
    issueTitle:session.displayName || null,
    summary:session.displayName || null,
    summaryIsFallback:false,
    createdAt:session.createdAt,
    lastActivityAt:session.activity?.lastActivityAt || session.updatedAt || session.createdAt,
    pr:null,
    metadata:{role:session.kind || 'worker', ...(session.terminalHandleId ? {tmuxName:session.terminalHandleId} : {})},
  };
}

async function listSessions(projectFilter) {
  const data = await native('/api/v1/sessions');
  const all = (data.sessions || []).filter(active).filter(s => !projectFilter || projectFilter === 'all' || s.projectId === projectFilter);
  const mapped = all.map(mapSession);
  const orchestrators = all.filter(s => s.kind === 'orchestrator').map(s => ({id:s.id,projectId:s.projectId,projectName:projectName || s.projectId}));
  const workers = mapped.filter(s => s.metadata.role !== 'orchestrator');
  return {
    sessions:workers,
    stats:{totalSessions:workers.length,workingSessions:workers.filter(s => s.activity === 'active').length,openPRs:0,needsReview:0},
    orchestratorId:orchestrators.length === 1 ? orchestrators[0].id : null,
    orchestrators,
    globalPause:null,
  };
}

function proxy(req,res) {
  const headers = {...req.headers,host:`${dashboardHost}:${dashboardPort}`,'accept-encoding':'identity'};
  const upstream = http.request({hostname:dashboardHost,port:dashboardPort,path:req.url,method:req.method,headers}, response => {
    const contentType = String(response.headers['content-type'] || '');
    if (!contentType.includes('text/html')) {
      res.writeHead(response.statusCode || 502,response.headers);
      response.pipe(res);
      return;
    }
    const chunks = [];
    response.on('data',chunk => chunks.push(chunk));
    response.on('end',() => {
      const shim = `<script>(()=>{const NativeWebSocket=window.WebSocket;window.WebSocket=class extends NativeWebSocket{constructor(url,protocols){const target=new URL(url,window.location.href);if(target.hostname===window.location.hostname&&target.port==='${browserTerminalPort}'&&target.pathname==='/ws'){target.protocol=window.location.protocol==='https:'?'wss:':'ws:';target.host=window.location.host;target.port=window.location.port;target.pathname='/ao-terminal-ws';}protocols===undefined?super(target):super(target,protocols);}};})();</script>`;
      const body = Buffer.concat(chunks).toString('utf8').replace('</head>',`${shim}</head>`);
      const responseHeaders = {...response.headers,'content-length':Buffer.byteLength(body),'cache-control':'no-store'};
      delete responseHeaders['content-encoding'];
      delete responseHeaders['transfer-encoding'];
      delete responseHeaders.etag;
      res.writeHead(response.statusCode || 502,responseHeaders);
      res.end(body);
    });
  });
  upstream.on('error', error => json(res,502,{error:`Dashboard unavailable: ${error.code || 'upstream error'}`}));
  req.pipe(upstream);
}

function proxyTerminalUpgrade(req,clientSocket,head) {
  const target = new URL(req.url || '/ao-terminal-ws',`http://${directTerminalHost}:${directTerminalPort}`);
  target.pathname = '/ws';
  const headers = {
    ...req.headers,
    host:`${directTerminalHost}:${directTerminalPort}`,
    origin:terminalOrigin,
  };
  const upstream = http.request({hostname:directTerminalHost,port:directTerminalPort,path:`${target.pathname}${target.search}`,method:req.method,headers});
  clientSocket.on('error',() => upstream.destroy());
  clientSocket.on('close',() => upstream.destroy());
  upstream.on('upgrade',(response,upstreamSocket,upstreamHead) => {
    const status = `HTTP/${response.httpVersion} ${response.statusCode} ${response.statusMessage}\r\n`;
    const responseHeaders = [];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      responseHeaders.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`);
    }
    clientSocket.write(status + responseHeaders.join('') + '\r\n');
    if (upstreamHead.length > 0) clientSocket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
    upstreamSocket.on('close',() => clientSocket.destroy());
    clientSocket.on('close',() => upstreamSocket.destroy());
    upstreamSocket.on('error',() => clientSocket.destroy());
    clientSocket.on('error',() => upstreamSocket.destroy());
  });
  upstream.on('response',response => {
    clientSocket.write(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || 'Upgrade failed'}\r\nConnection: close\r\n\r\n`);
    clientSocket.destroy();
  });
  upstream.on('error',() => clientSocket.destroy());
  upstream.end();
}

const server = http.createServer(async (req,res) => {
  if (auth) {
    if (req.headers.origin && !auth.originAllowed(req)) return json(res,403,{error:'Origin not allowed'});
    if (!auth.authenticate(req)) {
      res.setHeader('WWW-Authenticate','Basic realm="AO Pilot", charset="UTF-8"');
      return json(res,401,{error:'Authentication required'});
    }
  }
  const url = new URL(req.url || '/',`http://${dashboardHost}:${port}`);
  if (url.pathname.startsWith('/api/') && req.method !== 'GET') return json(res,403,{error:'Dashboard is read-only'});
  try {
    if (url.pathname === '/api/sessions') {
      return json(res,200,await listSessions(url.searchParams.get('project')));
    }
    const detail = /^\/api\/sessions\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (detail) {
      const data = await native(`/api/v1/sessions/${encodeURIComponent(detail[1])}`);
      if (!data.session || !active(data.session)) return json(res,404,{error:'Session not found'});
      return json(res,200,mapSession(data.session));
    }
    if (url.pathname === '/api/events') {
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive'});
      const emit = async () => {
        try {
          const list = await listSessions(url.searchParams.get('project'));
          const sessions = list.sessions.map(s => ({id:s.id,status:s.status,activity:s.activity,attentionLevel:s.activity === 'active' ? 'working' : 'pending',lastActivityAt:s.lastActivityAt}));
          res.write(`data: ${JSON.stringify({type:'snapshot',sessions})}\n\n`);
        } catch { res.write(': AO daemon temporarily unavailable\n\n'); }
      };
      await emit();
      const timer = setInterval(emit,5000);
      req.on('close',() => clearInterval(timer));
      return;
    }
    if (url.pathname.startsWith('/api/sessions/')) return json(res,404,{error:'Unsupported session route'});
    return proxy(req,res);
  } catch (error) {
    return json(res,502,{error:error instanceof Error ? error.message : 'AO daemon unavailable'});
  }
});

server.on('upgrade',(req,clientSocket,head) => {
  if (auth && (!auth.originAllowed(req) || !auth.authenticate(req))) {
    const status = auth.originAllowed(req) ? 401 : 403;
    clientSocket.end(`HTTP/1.1 ${status} Access denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  const url = new URL(req.url || '/',`http://${dashboardHost}:${port}`);
  if (url.pathname !== '/ao-terminal-ws') {
    clientSocket.destroy();
    return;
  }
  proxyTerminalUpgrade(req,clientSocket,head);
});

return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = loadConfig();
    const server = createAdapter(config);
    server.listen(config.port, config.listenHost, () => {
      console.log(`AO Dashboard adapter listening on port ${server.address().port}`);
    });
    server.on('error', () => { console.error('Adapter listener failed'); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
