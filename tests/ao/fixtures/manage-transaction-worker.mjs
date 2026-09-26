// Isolated subprocess fixture. Every injected I/O boundary targets this test's
// temporary state directory; no production hooks or live AO state are used.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { runManageCommand } from '../../../scripts/ao/lib/manage-runner.js';
import { resolveControlPlanePaths } from '../../../scripts/ao/lib/state-migrations.js';

const { options, mode, releasePath } = JSON.parse(process.argv[2]);
const paths = resolveControlPlanePaths(options);
const original = { open: fs.openSync, rename: fs.renameSync, append: fs.appendFileSync, rm: fs.rmSync };
const publications = [];
let paused = false;
let contended = false;
let journalWritten = false;
function pause() {
  if (paused) return;
  paused = true;
  fs.writeSync(1, 'barrier\n');
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(releasePath)) {
    if (Date.now() > deadline) throw new Error('Parent did not release fixture barrier');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
fs.openSync = function (file, flags, ...rest) {
  if (file === paths.stateWriteLockPath && flags === 'wx' && mode === 'before-lock') pause();
  try { return original.open(file, flags, ...rest); }
  catch (error) {
    if (file === paths.stateWriteLockPath && error.code === 'EEXIST' && !contended) {
      contended = true; fs.writeSync(1, 'contended\n');
    }
    throw error;
  }
};
fs.renameSync = function (from, to) {
  if (to === paths.stateMutationJournalPath && mode === 'fault-journal') throw new Error('fixture journal failure');
  if (to === paths.statePath) {
    if (mode === 'before-publish') pause();
    if (mode === 'fault-state') throw new Error('fixture state failure');
  }
  const value = original.rename(from, to);
  if (to === paths.stateMutationJournalPath) journalWritten = true;
  if (to === paths.statePath) publications.push(JSON.parse(fs.readFileSync(to, 'utf8')));
  return value;
};
fs.appendFileSync = function (file, ...args) {
  if (file === paths.auditPath && journalWritten && mode === 'fault-audit') throw new Error('fixture audit failure');
  return original.append(file, ...args);
};
fs.rmSync = function (file, ...args) {
  if (file === paths.stateMutationJournalPath && journalWritten && mode === 'fault-unlink') throw new Error('fixture journal cleanup failure');
  return original.rm(file, ...args);
};
syncBuiltinESMExports();
try {
  const result = await runManageCommand(options);
  fs.writeSync(1, `${JSON.stringify({ ok: true, result, publications })}\n`);
} catch (error) {
  fs.writeSync(1, `${JSON.stringify({ ok: false, error: error.message, code: error.code, publications })}\n`);
  process.exitCode = 2;
}
