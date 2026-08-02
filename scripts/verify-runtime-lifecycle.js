#!/usr/bin/env node

import fs from 'node:fs';

import { buildRuntimeArguments, parseRuntimeArgs } from './ao-runtime.js';

function read(relativePath) {
  return fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const mappings = {
  start: buildRuntimeArguments(parseRuntimeArgs(['start'])),
  stop: buildRuntimeArguments(parseRuntimeArgs(['stop'])),
  status: buildRuntimeArguments(parseRuntimeArgs(['status', '--json'])),
};
assert(JSON.stringify(mappings.start) === JSON.stringify(['daemon']), 'start must launch the locked daemon directly');
assert(JSON.stringify(mappings.stop) === JSON.stringify(['stop', '--json']), 'stop must use the locked daemon API');
assert(JSON.stringify(mappings.status) === JSON.stringify(['status', '--json']), 'status must use the locked daemon API');

const commandEntrypoint = read('bin/ao-pilot.js');
for (const command of ['start', 'stop', 'status', 'runtime-path']) {
  assert(commandEntrypoint.includes(`${command}: '../scripts/ao-runtime.js'`) || commandEntrypoint.includes(`'${command}': '../scripts/ao-runtime.js'`), `missing ao-pilot ${command} entrypoint`);
}

const runtimeControl = read('scripts/ao/lib/runtime-control.js');
assert(runtimeControl.includes("childSpawn(runtime.binary_path, ['daemon']"), 'daemon start is not bound to the resolved absolute binary');
assert(runtimeControl.includes("syncSpawn(runtime.binary_path, ['status', '--json']"), 'daemon readiness is not bound to the resolved absolute binary');

const observation = read('scripts/ao/lib/ao-observation-source.js');
assert(observation.includes("commandRunner.run(runtime.binary_path, ['session', 'ls'"), 'AO observation is not bound to the resolved absolute binary');
assert(!observation.includes("commandRunner.run('ao'"), 'AO observation still invokes PATH ao');

const startClean = read('scripts/ao/start-clean.sh');
assert(startClean.includes('bin/ao-pilot.js'), 'start-clean does not route through ao-pilot');
assert(!/(^|[;&|]\s*)ao(?:\s|$)/m.test(startClean), 'start-clean contains a direct PATH ao invocation');

process.stdout.write(`${JSON.stringify({
  status: 'verified',
  scope: 'runtime_aware_doctor_and_lifecycle_contract',
  entrypoints: ['doctor', 'runtime-path', 'start', 'status', 'stop'],
  exact_runtime_commands: mappings,
  path_ao_execution_allowed: false,
  desktop_mutable_start_allowed: false,
  live_daemon_claim: false,
  self_hosting_claim: false,
}, null, 2)}\n`);
