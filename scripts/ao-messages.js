#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeMessage } from './ao/lib/native-messages.js';
export async function runCli(argv, io = { writeStdout: (text) => process.stdout.write(text), writeStderr: (text) => process.stderr.write(text) }, dependencies = {}) {
  const [command, ...args] = argv;
  // Message text and flag values are opaque, even when they look like flags.
  const flags = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]; flags.push(arg);
    if (['--message', '--message-id', '--session', '--ack-timeout'].includes(arg)) index++;
  }
  if (flags.some((arg) => arg === '--config' || arg.startsWith('--config=') || arg === '--project' || arg.startsWith('--project='))) {
    io.writeStderr('send/ack use the installed native namespace; --config/--project are not daemon selectors\n'); return { exitCode: 2 };
  }
  if (flags.includes('--help') || flags.includes('-h')) {
    io.writeStdout('Usage: ao-pilot send --session S --message TEXT [--message-id ID] [--require-ack] [--ack-timeout 30s] [--json]\n       ao-pilot ack ID [--session S] [--json]\n'); return { exitCode: 0 };
  }
  try {
    const result = runNativeMessage(command, args, dependencies);
    io.writeStdout(result.stdout); io.writeStderr(result.stderr); return { exitCode: result.exitCode };
  } catch (error) { io.writeStderr(`${error.code ?? 'native_message_unavailable'}\n`); return { exitCode: 1 }; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = (await runCli(process.argv.slice(2))).exitCode;
