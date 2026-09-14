// Dedicated authoritative helper: no business child before the IPC permit.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
function identity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return {
    pid,
    boot_id: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    start_identity: fields[19]
  };
}
let child,
  permitted = false;
try {
  process.send({
    type: 'ready',
    identity: identity(process.pid)
  });
} catch {
  process.exit(70);
}
process.on('message', message => {
  if (message?.type !== 'permit' || permitted) return;
  permitted = true;
  const command = message.command;
  try {
    child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: message.environment,
      stdio: ['ignore', 1, 2]
    });
    child.on('error', () => process.exit(71));
    process.send({
      type: 'child',
      identity: identity(child.pid)
    });
    child.on('exit', (code, signal) => {
      process.send({
        type: 'terminal',
        exit_code: code,
        signal
      }, () => process.exit(code === 0 ? 0 : 1));
    });
  } catch {
    process.exit(72);
  }
});
// Before permission, lost supervisor means no business effect. After permission,
// keep supervising the child; the durable helper identity makes it observable.
process.on('disconnect', () => {
  if (!permitted) process.exit(73);
});
