#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function runCli(args, io = {writeStdout:text=>process.stdout.write(text),writeStderr:text=>process.stderr.write(text)}) {
if (args.includes('--help') || args.includes('-h')) { io.writeStdout('Usage: ao-pilot dashboard [--port 3000]\nOriginal browser Dashboard; requires browser build and AO_CONFIG_PATH.\n'); return {exitCode:0}; }
let port = 3000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else throw new Error(`Unknown Dashboard argument: ${args[i]}`);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Dashboard port');
const entry = fileURLToPath(new URL('../browser/packages/web/dist-server/start-all.js', import.meta.url));
const build = fileURLToPath(new URL('../browser/packages/web/.next/BUILD_ID', import.meta.url));
if (!fs.existsSync(entry) || !fs.existsSync(build)) throw new Error('Original Dashboard not built: cd browser && npm ci && npm run build:deps && NODE_ENV=production npm run build');
if (!process.env.AO_CONFIG_PATH) throw new Error('Set AO_CONFIG_PATH explicitly to preserve existing session identity');
const child = spawn(process.execPath, [entry], { stdio: 'inherit', env: {...process.env, NODE_ENV:'production', PORT:String(port), AO_DASHBOARD_AUTOMATION:process.env.AO_DASHBOARD_AUTOMATION ?? '0'} });
return new Promise(resolve => {
  const shutdown = () => child.kill('SIGTERM');
  const finish = code => { for (const signal of ['SIGTERM','SIGINT']) process.off(signal, shutdown); resolve({exitCode:code ?? 1}); };
  child.once('error', error => { io.writeStderr(`${error.message}\n`); finish(1); });
  child.once('exit', finish);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
});
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { const {exitCode} = await runCli(process.argv.slice(2)); process.exitCode = exitCode; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
