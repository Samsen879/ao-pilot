#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRuntimeLock } from './ao/lib/runtime-lock.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repositoryRoot, 'runtime', 'headless');
const forbiddenPath = /(^|\/)(frontend|electron)(\/|$)|appimage|forge\.config|maker-(?:dmg|nsis)/i;
const forbiddenSink = /\b(?:fetchApp|openApp|knownAppLocations|linuxAppImagePath|windowsInstalledExe)\b|AgentWrapper\/agent-orchestrator|agent-orchestrator\.AppImage/;
const forbiddenRecoveryInstruction = /(?:run|start it with)\s+`ao start`/i;
export const HEADLESS_START_SOURCE_SHA256 = '21cf8dcac04d4391da844adf717337533ed605c2272a9be2c32f6eada1fb804b';

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink forbidden in headless source: ${resolved}`);
    return entry.isDirectory() ? walk(resolved) : [resolved];
  });
}

export function verifyHeadlessRuntimeSource({
  sourceRoot: inspectedSourceRoot = sourceRoot,
  runtimeLock = null,
  expectedStartSourceSha256 = HEADLESS_START_SOURCE_SHA256,
} = {}) {
  const lock = runtimeLock ?? loadRuntimeLock().lock;
  if (lock.artifact.repository !== 'https://github.com/Samsen879/ao-pilot.git') {
    throw new Error('runtime source authority is not ao-pilot');
  }
  if (lock.artifact.ref.name !== 'ao-pilot-headless-runtime-v0.11.2-p0.4') {
    throw new Error('runtime source tag is not the admitted headless tag');
  }
  const files = walk(inspectedSourceRoot);
  const relativeFiles = files.map((file) => path.relative(inspectedSourceRoot, file).replaceAll('\\', '/'));
  const forbiddenPaths = relativeFiles.filter((file) => forbiddenPath.test(file));
  if (forbiddenPaths.length > 0) throw new Error(`desktop paths present: ${forbiddenPaths.join(', ')}`);
  const sourceFiles = files.filter((file) => file.endsWith('.go') || file.endsWith('.md'));
  const sinkMatches = sourceFiles.filter((file) => forbiddenSink.test(fs.readFileSync(file, 'utf8')));
  if (sinkMatches.length > 0) {
    throw new Error(`desktop acquisition sinks present: ${sinkMatches.map((file) => path.relative(inspectedSourceRoot, file)).join(', ')}`);
  }
  const recoveryInstructionMatches = sourceFiles.filter((file) => (
    forbiddenRecoveryInstruction.test(fs.readFileSync(file, 'utf8'))
  ));
  if (recoveryInstructionMatches.length > 0) {
    throw new Error(`disabled start recovery instructions present: ${recoveryInstructionMatches.map((file) => path.relative(inspectedSourceRoot, file)).join(', ')}`);
  }
  const startSource = fs.readFileSync(path.join(inspectedSourceRoot, 'backend', 'internal', 'cli', 'start.go'), 'utf8');
  const startSourceSha256 = createHash('sha256').update(startSource).digest('hex');
  if (startSourceSha256 !== expectedStartSourceSha256) {
    throw new Error(`headless start boundary digest mismatch: ${startSourceSha256}`);
  }
  for (const required of ['errDesktopEntrypointDisabled', 'performs no filesystem discovery', 'process creation']) {
    if (!startSource.includes(required)) throw new Error(`headless start guard missing: ${required}`);
  }
  return {
    status: 'pass',
    runtime_ref: lock.runtime_ref,
    repository: lock.artifact.repository,
    tag: lock.artifact.ref.name,
    file_count: files.length,
    forbidden_path_count: 0,
    forbidden_sink_count: 0,
    forbidden_recovery_instruction_count: 0,
    start_source_sha256: startSourceSha256,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(verifyHeadlessRuntimeSource(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Headless runtime source verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
