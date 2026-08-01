#!/usr/bin/env node

import { verifyRuntimePatchParity } from './ao/lib/runtime-patch-parity.js';

try {
  console.log(JSON.stringify(verifyRuntimePatchParity(), null, 2));
} catch (error) {
  console.error(`runtime patch parity verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
