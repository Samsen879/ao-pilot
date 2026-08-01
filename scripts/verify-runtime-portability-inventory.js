#!/usr/bin/env node

import { verifyRuntimePortabilityInventory } from './ao/lib/runtime-portability-inventory.js';

try {
  process.stdout.write(`${JSON.stringify(verifyRuntimePortabilityInventory(), null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
