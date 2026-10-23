#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRelease, fileSha256, verifyReleaseTree } from './ao/lib/release-manifest.js';
const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const manifest = verifyReleaseTree(root);
const socket = process.env.AO_TMUX_SOCKET;
const temp = process.env.AO_TMUX_TMPDIR;
assertRelease(/^[a-zA-Z0-9_-]+$/.test(socket ?? '') && socket !== 'default'
  && path.isAbsolute(temp ?? '') && process.env.TMUX_TMPDIR === temp, 'invalid_tmux_namespace');
assertRelease(fileSha256(manifest.toolchain.tmux_executable) === manifest.toolchain.tmux_sha256, 'release_external_binary_drift');
fs.mkdirSync(temp, { recursive: true, mode: 0o700 });
assertRelease(typeof process.execve === 'function', 'release_node_execve_required');
process.chdir(temp);
process.execve(manifest.toolchain.tmux_executable, [manifest.toolchain.tmux_executable,
  '-L', socket, '-f', path.join(root, 'templates/tmux/ao-pilot.conf'), '-D'], process.env);
