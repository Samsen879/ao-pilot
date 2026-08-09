import crypto from 'node:crypto';
import fs from 'node:fs';

import { createControllerLease } from './state-contracts.js';
import { readJsonFile } from './state-storage.js';

export const CONTROLLER_LEASE_AUTHORITY_SCHEMA_VERSION = 'ao.controller-lease-authority.v1';
export const CONTROLLER_LEASE_AUTHORITY_FORMAT = 'ao_controller_lease_authority';
export const CONTROLLER_LEASE_AUTHORITY_VERSION = 1;

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function digestControllerLeaseAuthorityEvidence(value) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableJson(value))).digest('hex')}`;
}

export function normalizeControllerLeaseRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('Malformed canonical controller lease authority records: expected a JSON array');
  }
  return records
    .map((record) => createControllerLease(record))
    .sort((left, right) => left.lease_id.localeCompare(right.lease_id));
}

export function createControllerLeaseAuthority(records = []) {
  return {
    schema_version: CONTROLLER_LEASE_AUTHORITY_SCHEMA_VERSION,
    format: CONTROLLER_LEASE_AUTHORITY_FORMAT,
    authority_version: CONTROLLER_LEASE_AUTHORITY_VERSION,
    records: normalizeControllerLeaseRecords(records),
  };
}

export function parseControllerLeaseAuthority(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Malformed canonical controller lease authority: expected a versioned JSON object');
  }
  if (
    payload.schema_version !== CONTROLLER_LEASE_AUTHORITY_SCHEMA_VERSION
    || payload.format !== CONTROLLER_LEASE_AUTHORITY_FORMAT
    || payload.authority_version !== CONTROLLER_LEASE_AUTHORITY_VERSION
  ) {
    throw new Error(
      `Unsupported canonical controller lease authority version: ${String(payload.schema_version ?? payload.authority_version ?? 'missing')}`,
    );
  }
  return createControllerLeaseAuthority(payload.records);
}

export function readControllerLeaseAuthorityFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Missing canonical controller lease authority: controller-leases.json');
  }
  return parseControllerLeaseAuthority(readJsonFile(filePath));
}
