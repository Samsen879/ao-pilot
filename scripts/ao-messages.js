#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeMessage, runNativeMessageWatch } from './ao/lib/native-messages.js';
export async function runCli(argv, io = { writeStdout: (text) => process.stdout.write(text), writeStderr: (text) => process.stderr.write(text) }, dependencies = {}) {
  const [command, ...args] = argv;
  // Message text and flag values are opaque, even when they look like flags.
  const flags = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; flags.push(arg);
    if (['--message', '--message-id', '--session', '--ack-timeout', '--timeout', '--started-pid', '--artifact', '--blocked'].includes(arg)) index++;
  }
  if (flags.some((arg) => arg === '--config' || arg.startsWith('--config=') || arg === '--project' || arg.startsWith('--project='))) {
    io.writeStderr('message commands use the installed native namespace; --config/--project are not daemon selectors\n'); return { exitCode: 2 };
  }
  if (flags.includes('--help') || flags.includes('-h')) {
    io.writeStdout('Usage: ao-pilot send --session S --message TEXT [--message-id ID] [--require-ack] [--ack-timeout 30s] [--json]\n       ao-pilot ack ID [--session S] [--json]\n       ao-pilot message checkpoint ID (--started-pid PID | --artifact FILE | --blocked REASON)\n       ao-pilot message show ID --session S [--json]\n       ao-pilot message watch ID --session S [--timeout 30s] [--json]\n'); return { exitCode: 0 };
  }
  if (!['send', 'ack', 'message'].includes(command) || (command === 'message' && !['show', 'watch', 'checkpoint'].includes(args[0]))) {
    io.writeStderr('Expected send, ack, message show, message watch, or message checkpoint\n'); return { exitCode: 2 };
  }
  try {
    if (command === 'message' && args[0] === 'watch') return await runNativeMessageWatch(args, io, dependencies);
    const result = runNativeMessage(command, args, dependencies);
    io.writeStdout(result.stdout); io.writeStderr(result.stderr); return { exitCode: result.exitCode };
  } catch (error) { io.writeStderr(`${error.code ?? 'native_message_unavailable'}\n`); return { exitCode: 1 }; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await runCli(process.argv.slice(2))).exitCode;
