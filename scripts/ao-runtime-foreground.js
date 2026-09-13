#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolveRuntimeControl } from './ao/lib/runtime-control.js';
const runtime = resolveRuntimeControl();
const child = spawn(runtime.binary_path, ['daemon'], { stdio: 'inherit', env: process.env });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
