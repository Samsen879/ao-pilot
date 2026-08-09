#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadControllerLeaseInventory,
  validateControllerLeaseInventory,
} from './ao/lib/controller-lease-authority-audit.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = path.join(
  repositoryRoot,
  'docs/foundation/controller-lease-caller-inventory.v1.json',
);

try {
  const inventory = loadControllerLeaseInventory(inventoryPath);
  const result = validateControllerLeaseInventory(inventory, repositoryRoot);
  process.stdout.write(`${JSON.stringify({ status: 'passed', ...result }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`controller_lease_authority_audit_failed: ${error.message}\n`);
  process.exitCode = 1;
}
