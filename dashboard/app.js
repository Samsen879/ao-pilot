/* Native p0.4 API and mux protocol. No legacy repository or CDN dependency. */
const $ = id => document.getElementById(id);
const id = location.pathname.startsWith('/sessions/') ? decodeURIComponent(location.pathname.slice(10)) : null;
let socket, term, fit, handle, generation = 0, timer;
async function api(path, method = 'GET') {
  const response = await fetch(`/api/v1/${path}`, { method, headers: { 'X-AO-Dashboard': '1', 'Content-Type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}
function node(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
async function refresh() {
  try {
    if (id) {
      const { session } = await api(`sessions/${encodeURIComponent(id)}`);
      $('name').textContent = session.displayName || session.id;
      $('identity').textContent = `${session.projectId} · ${session.branch || 'No branch'} · ${session.kind}`;
      $('activity').textContent = `Status: ${session.status} · Activity: ${session.activity} · Created ${new Date(session.createdAt).toLocaleString()}`;
      $('restore').hidden = !session.isTerminated;
      const nextHandle = session.terminalHandleId;
      if (session.isTerminated || !nextHandle) {
        if (socket) { generation++; socket.close(); socket = null; }
        handle = null; $('connection').textContent = session.isTerminated ? 'Exited — saved session requires explicit restore' : 'Terminal unavailable — no runtime handle';
      } else if (nextHandle !== handle) { handle = nextHandle; connect(); }
    } else {
      const data = await api(`sessions${$('project').value ? `?project=${encodeURIComponent($('project').value)}` : ''}`);
      $('sessions').replaceChildren();
      $('summary').textContent = `${data.sessions.length} sessions · ${data.sessions.filter(s => !s.isTerminated).length} active`;
      for (const session of data.sessions) {
        const row = node('article', '', 'session'); const title = node('h2', ''); const link = node('a', session.displayName || session.id);
        link.href = `/sessions/${encodeURIComponent(session.id)}`; title.append(link); row.append(title, node('p', `${session.projectId} · ${session.branch || 'No branch'} · ${session.kind}`), node('p', `Status: ${session.status} · Activity: ${session.activity}`)); $('sessions').append(row);
      }
      if (!data.sessions.length) $('sessions').append(node('p', 'No native sessions. Legacy sessions are not automatically imported or replaced.'));
    }
    $('health').textContent = 'Runtime connected · localhost'; $('notice').textContent = '';
  } catch (error) { $('health').textContent = `Runtime unavailable: ${error.message}`; $('notice').textContent = error.message; }
}
function connect() {
  const current = ++generation;
  if (socket) socket.close();
  clearTimeout(timer);
  if (!handle) return;
  $('connection').textContent = 'Connecting…';
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/mux`);
  const ws = socket;
  timer = setTimeout(() => { if (current === generation) { $('connection').textContent = 'Connection timed out — choose Reconnect'; ws.close(); } }, 10000);
  ws.onopen = () => { if (current !== generation) return; fit.fit(); ws.send(JSON.stringify({ ch: 'terminal', type: 'open', id: handle, cols: term.cols, rows: term.rows })); };
  ws.onmessage = event => {
    if (current !== generation) return;
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.ch !== 'terminal' || msg.id !== handle) return;
    if (msg.type === 'opened') { clearTimeout(timer); $('connection').textContent = `Connected · ${id}`; }
    if (msg.type === 'data') term.write(Uint8Array.from(atob(msg.data), char => char.charCodeAt(0)));
    if (msg.type === 'resize' && msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
    if (msg.type === 'error') { clearTimeout(timer); $('connection').textContent = `Terminal error: ${msg.error}`; }
    if (msg.type === 'exited') { clearTimeout(timer); $('connection').textContent = 'Terminal exited'; ws.close(); }
  };
  ws.onclose = () => { if (current !== generation) return; clearTimeout(timer); if ($('connection').textContent.startsWith('Connected') || $('connection').textContent === 'Connecting…') $('connection').textContent = 'Disconnected — choose Reconnect'; };
  ws.onerror = () => { if (current === generation) $('connection').textContent = 'Terminal connection failed — choose Reconnect'; };
}
if (id) {
  $('overview').hidden = true; $('detail').hidden = false; $('crumb').textContent = `/ ${id}`;
  term = new Terminal({ cursorBlink: true, screenReaderMode: true, fontSize: 14, theme: { background: '#090c10', foreground: '#e6edf3' } });
  fit = new FitAddon.FitAddon(); term.loadAddon(fit); term.open($('terminal')); fit.fit();
  term.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ch: 'terminal', type: 'data', id: handle, data: btoa(String.fromCharCode(...new TextEncoder().encode(data))) })); });
  term.onResize(({cols, rows}) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ ch:'terminal',type:'resize',id:handle,cols,rows })); });
  new ResizeObserver(() => fit.fit()).observe($('terminal'));
  $('reconnect').onclick = connect;
  $('fullscreen').onclick = () => document.querySelector('.terminal-shell').requestFullscreen().catch(error => { $('notice').textContent = error.message; });
  $('restore').onclick = async () => { if (!confirm(`Restore saved native session ${id}? This relaunches its agent.`)) return; $('restore').disabled = true; try { await api(`sessions/${encodeURIComponent(id)}/restore`, 'POST'); await refresh(); } catch(error) { $('notice').textContent = error.message; } finally { $('restore').disabled = false; } };
} else {
  api('projects').then(({projects}) => { for (const project of projects) { const option = node('option', project.name || project.id); option.value = project.id; $('project').append(option); } }).catch(() => {});
  $('project').onchange = refresh;
}
$('refresh').onclick = refresh;
refresh(); setInterval(refresh, 5000);
