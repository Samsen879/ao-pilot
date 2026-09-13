#!/usr/bin/env node
import { createDashboardServer } from './ao/lib/dashboard-server.js';
import { pathToFileURL } from 'node:url';
export async function runCli(args, io = {writeStdout:text=>process.stdout.write(text),writeStderr:text=>process.stderr.write(text)}) {
if (args.includes('--help') || args.includes('-h')) { io.writeStdout('Usage: ao-pilot dashboard [--port 3000] [--runtime-port 3001]\n'); return {exitCode:0}; }
let port = 3000;
let runtimePort = 3001;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (args[i] === '--runtime-port') runtimePort = Number(args[++i]);
  else throw new Error(`Unknown Dashboard argument: ${args[i]}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Dashboard port');
const server = createDashboardServer({ runtimePort });
return new Promise(resolve => {
  const shutdown = async () => { await server.shutdown(); resolve({exitCode:0}); };
  server.once('error', error => { io.writeStderr(`${error.message}\n`); resolve({exitCode:1}); });
  server.once('close', () => { for (const signal of ['SIGTERM','SIGINT']) process.off(signal, shutdown); });
  server.listen(port, '127.0.0.1', () => io.writeStdout(`AO Pilot Dashboard: http://localhost:${port}\n`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
});
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { const {exitCode} = await runCli(process.argv.slice(2)); process.exitCode = exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
